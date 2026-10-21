"""抽取编排：从库里读文档 -> 抽观点 -> 落库。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..models import Instrument, Opinion
from ..textutil import now_iso
from ..backtest.dedupe import evidence_fingerprint
from .rule_extractor import extract_opinions


def opinion_key(doc_id: int, op: Opinion) -> str:
    ref = op.subject_secid or op.subject_raw or ""
    raw = f"{doc_id}|{op.char_start}|{op.char_end}|{ref}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _dedupe(opinions: list[Opinion]) -> list[Opinion]:
    """同一位置同一标的只留置信度最高的一条。"""
    best: dict[tuple[int, str], Opinion] = {}
    for op in opinions:
        key = (op.char_start, op.subject_secid or op.subject_raw or "")
        cur = best.get(key)
        if cur is None or op.confidence > cur.confidence:
            best[key] = op
    return sorted(best.values(), key=lambda o: (o.char_start, o.char_end))


def _merge(rule_ops: list[Opinion], llm_ops: list[Opinion]) -> list[Opinion]:
    """合并两个抽取器的结果，**LLM 优先**。

    为什么不让置信度决定胜负：规则抽取器在口语化、正话反说的内容上
    会给出方向相反的结论，而且它的 confidence 还常常不低。
    词表匹配看到「拒绝下跌」里的「下跌」就判空，这类错误不能靠打分兜住。
    """
    by_key: dict[tuple[int, str], Opinion] = {}
    for op in rule_ops:
        by_key[(op.char_start, op.subject_secid or op.subject_raw or "")] = op
    for op in llm_ops:
        by_key[(op.char_start, op.subject_secid or op.subject_raw or "")] = op
    return sorted(by_key.values(), key=lambda o: (o.char_start, o.char_end))


def _write(con: sqlite3.Connection, doc, opinions: list[Opinion],
           now: str, stats: dict) -> None:
    for op in opinions:
        key = opinion_key(doc["id"], op)
        con.execute(
            """
            INSERT INTO opinion
              (opinion_key, doc_id, author_id, stated_at, stated_date, sentence,
               char_start, char_end, subject_raw, subject_secid, subject_type,
               resolved, match_conf, polarity, strength, horizon, thesis,
               triggers, evidence, extractor, confidence, created_at,
               evidence_hash, is_dup)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT (opinion_key) DO UPDATE SET
               polarity = excluded.polarity,
               strength = excluded.strength,
               horizon  = excluded.horizon,
               thesis   = excluded.thesis,
               triggers = excluded.triggers,
               evidence = excluded.evidence,
               evidence_hash = excluded.evidence_hash,
               extractor = excluded.extractor,
               confidence = excluded.confidence,
               subject_secid = excluded.subject_secid,
               subject_type = excluded.subject_type,
               resolved = excluded.resolved,
               match_conf = excluded.match_conf
            """,
            (
                key, doc["id"], doc["author_id"], doc["published_at"],
                doc["published_date"], op.sentence, op.char_start, op.char_end,
                op.subject_raw, op.subject_secid, op.subject_type,
                1 if op.resolved else 0, op.match_conf, op.polarity, op.strength,
                op.horizon, op.thesis,
                json.dumps(op.triggers, ensure_ascii=False),
                op.evidence, op.extractor, op.confidence, now,
                evidence_fingerprint(op.evidence),
            ),
        )
        stats["opinions"] += 1
        if op.resolved:
            stats["resolved"] += 1
        else:
            stats["unresolved"] += 1


def run_extraction(con: sqlite3.Connection, cfg, lex, resolver, *,
                   benchmark: Instrument | None = None,
                   llm=None, extractor: str = "rule",
                   limit: int | None = None,
                   latest: int | None = None,
                   purge: bool = True,
                   concurrency: int = 1,
                   progress_every: int = 50) -> dict:
    """抽取观点并落库。

    extractor:
      "rule" —— 只用规则（零成本，适合写法规范的内容）
      "llm"  —— 只用 LLM（口语化/隐喻化内容必须用它）
      "both" —— 两者都跑，冲突时 LLM 优先

    latest: 只处理最近 N 篇（按发布日期倒序）。日常增量跑用它。
    concurrency: LLM 并发数。串行跑 2000 多篇要一两个小时，
                 并发 6 路能把时间压到十几分钟。
                 注意规则抽取仍在主线程做 —— resolver 内部有可变计数器，
                 不适合多线程。

    purge=True 时先删掉这些文档的旧观点再重建。
    必须这么做：幂等键里含 char_start/char_end，切句规则一变，
    旧行不会被覆盖而会残留成幽灵数据，把回测和绩效榜一起带偏。
    """
    if extractor not in ("rule", "llm", "both"):
        raise ValueError(f"未知抽取器模式: {extractor}")
    if extractor in ("llm", "both") and (llm is None or not llm.available()):
        raise SystemExit(
            "指定了 LLM 抽取但没有可用的 API key。\n"
            "请设置环境变量 STOCKTOOL_LLM_API_KEY（或 DEEPSEEK_API_KEY），"
            "或写入 config/llm_api_key.txt。"
        )

    order = "DESC" if latest else "ASC"
    sql = f"""
        SELECT d.id, d.author_id, d.published_at, d.published_date, d.permalink, t.text
        FROM doc d JOIN doc_text t ON t.doc_id = d.id
        ORDER BY d.published_date {order}, d.id {order}
    """
    docs = con.execute(sql).fetchall()
    if latest:
        docs = docs[:latest]
    if limit:
        docs = docs[:limit]

    now = now_iso()
    stats = {"docs": 0, "opinions": 0, "resolved": 0, "unresolved": 0,
             "rule_opinions": 0, "llm_docs": 0, "llm_opinions": 0,
             "purged": 0, "failed": 0, "extractor": extractor,
             "concurrency": concurrency}

    if purge and docs:
        ids = [d["id"] for d in docs]
        for start in range(0, len(ids), 400):
            chunk = ids[start:start + 400]
            marks = ",".join("?" * len(chunk))
            cur = con.execute(
                f"DELETE FROM opinion WHERE doc_id IN ({marks})", chunk)
            stats["purged"] += cur.rowcount or 0
        con.commit()

    use_llm = extractor in ("llm", "both")
    lock = threading.Lock()

    def _rule_for(doc) -> list[Opinion]:
        if extractor == "llm":
            return []
        return extract_opinions(doc["text"], resolver, lex, benchmark=benchmark)

    def _llm_call(doc):
        """只做网络调用，不碰数据库 —— sqlite 连接不能跨线程写。"""
        try:
            return doc, llm.extract(doc["text"], benchmark=benchmark)
        except Exception as exc:  # noqa: BLE001
            return doc, exc

    total = len(docs)
    if use_llm and concurrency > 1 and total > 1:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(_llm_call, doc) for doc in docs]
            done = 0
            for fut in as_completed(futures):
                doc, result = fut.result()
                done += 1
                if isinstance(result, Exception):
                    with lock:
                        stats["failed"] += 1
                    print(f"  ! LLM 抽取失败 doc={doc['id']}: "
                          f"{type(result).__name__}: {result}")
                    llm_ops = []
                else:
                    llm_ops = result
                if llm_ops:
                    stats["llm_docs"] += 1
                    stats["llm_opinions"] += len(llm_ops)

                rule_ops = _rule_for(doc)
                stats["rule_opinions"] += len(rule_ops)
                if extractor == "both":
                    opinions = _merge(rule_ops, llm_ops)
                elif extractor == "llm":
                    opinions = llm_ops
                else:
                    opinions = rule_ops
                _write(con, doc, _dedupe(opinions), now, stats)
                stats["docs"] += 1
                if done % progress_every == 0:
                    con.commit()
                    print(f"    … {done}/{total} 篇，累计观点 {stats['opinions']} 条")
        con.commit()
        return stats

    # ---------- 串行路径 ----------
    for i, doc in enumerate(docs, 1):
        rule_ops = _rule_for(doc)
        stats["rule_opinions"] += len(rule_ops)

        llm_ops: list[Opinion] = []
        if use_llm:
            try:
                llm_ops = llm.extract(doc["text"], benchmark=benchmark)
            except Exception as exc:  # noqa: BLE001
                stats["failed"] += 1
                print(f"  ! LLM 抽取失败 doc={doc['id']}: "
                      f"{type(exc).__name__}: {exc}")
                llm_ops = []
            if llm_ops:
                stats["llm_docs"] += 1
                stats["llm_opinions"] += len(llm_ops)

        if extractor == "both":
            opinions = _merge(rule_ops, llm_ops)
        elif extractor == "llm":
            opinions = llm_ops
        else:
            opinions = rule_ops

        _write(con, doc, _dedupe(opinions), now, stats)
        stats["docs"] += 1
        if use_llm and i % progress_every == 0:
            con.commit()
            print(f"    … {i}/{total} 篇，累计观点 {stats['opinions']} 条")

    con.commit()
    return stats
