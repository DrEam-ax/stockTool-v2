"""把知识库载入本地数据库。

设计要点：
  · 导入的观点用 `kb:<opinion_id>` 作幂等键，与本地抽取的规则键区分开，
    重复导入同一个库不会产生重复行。
  · evidence_only 的库没有原文，但 opinion 表的 doc_id 是必填外键，
    所以为缺失的文档建**只有元数据的存根 doc**（不写 doc_text）。
    这样既满足约束，又不会让这些文档被本地重新抽取（抽取只处理有 doc_text 的）。
  · 标的自包含：先把库里的 instrument 落库，再导观点，避免外键失败。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from ..db import save_revision, upsert_author, upsert_doc
from ..models import Instrument
from ..textutil import content_hash, now_iso
from . import spec
from .bundle import iter_jsonl, read_bundle
from .spec import AUTHOR, DOCUMENTS, EVALUATIONS, INSTRUMENTS, MANIFEST, OPINIONS
from .validator import validate_kb

IMPORT_KEY_PREFIX = "kb:"


@dataclass
class LoadedKB:
    path: Path
    manifest: dict = field(default_factory=dict)
    author: dict = field(default_factory=dict)
    instruments: list[dict] = field(default_factory=list)
    opinions: list[dict] = field(default_factory=list)
    evaluations: list[dict] = field(default_factory=list)
    documents: list[dict] = field(default_factory=list)


def load_kb(path: Path, *, validate: bool = True) -> LoadedKB:
    files = read_bundle(Path(path))
    if validate:
        result = validate_kb(path)
        if not result["ok"]:
            raise SystemExit(
                "知识库校验未通过：\n  - " + "\n  - ".join(result["errors"])
            )
    kb = LoadedKB(path=Path(path))
    kb.manifest = json.loads(files[MANIFEST]) if MANIFEST in files else {}
    kb.author = json.loads(files[AUTHOR]) if AUTHOR in files else {}
    kb.instruments = list(iter_jsonl(files[INSTRUMENTS])) if INSTRUMENTS in files else []
    kb.opinions = list(iter_jsonl(files[OPINIONS])) if OPINIONS in files else []
    kb.evaluations = list(iter_jsonl(files[EVALUATIONS])) if EVALUATIONS in files else []
    kb.documents = list(iter_jsonl(files[DOCUMENTS])) if DOCUMENTS in files else []
    return kb


def import_kb(con: sqlite3.Connection, cfg, kb: LoadedKB,
              *, purge_eval: bool = True) -> dict:
    now = now_iso()
    stats = {"instruments": 0, "aliases": 0, "authors": 0, "docs": 0,
             "doc_texts": 0, "opinions": 0, "evaluations": 0, "skipped": 0}

    # ---------- 1) 标的字典 ----------
    insts: list[Instrument] = []
    alias_rows: list[tuple[str, str, float]] = []
    for item in kb.instruments:
        secid = item.get("secid")
        if not secid:
            continue
        insts.append(Instrument(
            secid=secid,
            code=str(item.get("code") or secid.split(".")[-1]),
            name=str(item.get("name") or secid),
            type=str(item.get("type") or "stock"),
            market=int(str(secid).split(".")[0]) if "." in str(secid) else 0,
            exchange=item.get("exchange"),
        ))
        for alias in item.get("aliases") or []:
            alias_rows.append((str(alias), secid, 1.0))
    if insts:
        from ..market.store import upsert_aliases, upsert_instruments
        stats["instruments"] = upsert_instruments(con, insts, now)
        stats["aliases"] = upsert_aliases(con, alias_rows, origin="kb")
    con.commit()

    # ---------- 2) 作者 ----------
    author_ids: dict[str, int] = {}
    for item in kb.opinions:
        auid = item.get("author_uid")
        if not auid or auid in author_ids:
            continue
        src, uid = spec.split_author_uid(auid)
        name = (kb.author.get("name") if kb.author else None) or uid
        author_ids[auid] = upsert_author(con, src, uid, name, "imported from kb", now)
    stats["authors"] = len(author_ids)

    # ---------- 3) 文档（元数据存根 + 有原文时写正文）----------
    doc_ids: dict[str, int] = {}
    doc_author: dict[str, str] = {}
    for ref, auid, published_at, kind, title, permalink, meta in _iter_docs(kb):
        src, eid = spec.split_doc_ref(ref)
        aid = author_ids.get(auid)
        if aid is None:
            src2, uid = spec.split_author_uid(auid)
            aid = upsert_author(con, src2, uid, uid, "imported from kb", now)
            author_ids[auid] = aid
        doc_id = upsert_doc(
            con, author_id=aid, source=src, external_id=eid, kind=kind,
            title=title, published_at=published_at,
            published_date=str(published_at)[:10], permalink=permalink,
            media_refs=None,
            raw_meta=json.dumps(meta or {}, ensure_ascii=False, default=str),
            now=now,
        )
        doc_ids[ref] = doc_id
        doc_author[ref] = auid
        stats["docs"] += 1
    con.commit()

    # ---------- 4) 观点 ----------
    key_to_opinion_id: dict[str, int] = {}
    for item in kb.opinions:
        oid = item.get("opinion_id")
        auid = item.get("author_uid")
        ref = item.get("doc_ref")
        if not oid or not auid or not ref:
            stats["skipped"] += 1
            continue
        doc_id = doc_ids.get(ref)
        if doc_id is None:
            stats["skipped"] += 1
            continue
        subj = item.get("subject") or {}
        secid = subj.get("secid")
        resolved = 1 if secid else 0
        if secid and not _secid_exists(con, secid):
            # 校验器已拦过，这里再兜一次，避免外键炸掉整轮导入
            secid, resolved = None, 0

        key = IMPORT_KEY_PREFIX + str(oid)
        con.execute("""
            INSERT INTO opinion
              (opinion_key, doc_id, author_id, stated_at, stated_date, sentence,
               char_start, char_end, subject_raw, subject_secid, subject_type,
               resolved, match_conf, polarity, strength, horizon, thesis,
               triggers, evidence, extractor, confidence, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (opinion_key) DO UPDATE SET
               polarity = excluded.polarity,
               strength = excluded.strength,
               horizon  = excluded.horizon,
               thesis   = excluded.thesis,
               evidence = excluded.evidence,
               confidence = excluded.confidence,
               subject_secid = excluded.subject_secid,
               subject_type = excluded.subject_type,
               resolved = excluded.resolved
        """, (
            key, doc_id, author_ids[auid],
            item.get("stated_at") or item.get("stated_date") or now,
            item.get("stated_date") or str(item.get("stated_at"))[:10] or now[:10],
            (item.get("evidence") or item.get("thesis") or "")[:2000],
            None, None,
            subj.get("raw"),
            secid,
            item.get("subject_type") or "unresolved",
            resolved, subj.get("match_conf"),
            int(item.get("polarity") or 0),
            int(item.get("strength") or 3),
            item.get("horizon") or "unspecified",
            item.get("thesis"),
            json.dumps(item.get("triggers") or [], ensure_ascii=False),
            item.get("evidence"),
            item.get("extractor") or "imported",
            item.get("confidence"),
            now,
        ))
        row = con.execute("SELECT id FROM opinion WHERE opinion_key = ?",
                          (key,)).fetchone()
        if row:
            key_to_opinion_id[str(oid)] = int(row["id"])
        stats["opinions"] += 1
    con.commit()

    # ---------- 5) 回测结果 ----------
    bench = str(kb.manifest.get("benchmark") or cfg.values["benchmark_secid"])
    for item in kb.evaluations:
        oid = str(item.get("opinion_id"))
        pid = key_to_opinion_id.get(oid)
        if pid is None:
            stats["skipped"] += 1
            continue
        con.execute("""
            INSERT INTO opinion_eval
              (opinion_id, horizon_days, benchmark_secid, entry_date, entry_close,
               exit_date, exit_close, bench_entry, bench_exit, raw_return,
               bench_return, excess_return, signed_excess, hit, max_adverse,
               status, evaluated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (opinion_id, horizon_days, benchmark_secid) DO UPDATE SET
               entry_date = excluded.entry_date, entry_close = excluded.entry_close,
               exit_date = excluded.exit_date, exit_close = excluded.exit_close,
               bench_return = excluded.bench_return,
               excess_return = excluded.excess_return,
               signed_excess = excluded.signed_excess, hit = excluded.hit,
               max_adverse = excluded.max_adverse, status = excluded.status,
               evaluated_at = excluded.evaluated_at
        """, (
            pid, int(item.get("horizon_days") or 0),
            item.get("benchmark_secid") or bench,
            item.get("entry_date"), item.get("entry_close"),
            item.get("exit_date"), item.get("exit_close"),
            None, None, None,
            item.get("bench_return"), item.get("excess_return"),
            item.get("signed_excess"), item.get("hit"),
            item.get("max_adverse"), item.get("status") or "ok", now,
        ))
        stats["evaluations"] += 1
    con.commit()

    _ = purge_eval  # 保留参数以便将来做“导入前清空”策略
    return stats


def _iter_docs(kb: LoadedKB):
    """产出 (doc_ref, author_uid, published_at, kind, title, permalink, meta)。

    有原文用原文；没有原文（evidence_only）就按观点里的信息造元数据存根。
    """
    seen: set[str] = set()
    for d in kb.documents:
        ref = d.get("doc_ref")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        yield (ref, d.get("author_uid"), d.get("published_at") or now_iso(),
               d.get("kind") or "post", d.get("title"), d.get("permalink"),
               d.get("raw_meta"))

    # 没有 documents.jsonl 时，从观点的 doc_ref 造存根
    for o in kb.opinions:
        ref = o.get("doc_ref")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        yield (ref, o.get("author_uid"),
               o.get("stated_at") or o.get("stated_date") or now_iso(),
               "post", None, None, {"origin": "kb_stub"})


def _secid_exists(con: sqlite3.Connection, secid: str) -> bool:
    return con.execute("SELECT 1 FROM instrument WHERE secid = ?",
                       (secid,)).fetchone() is not None


def document_text_of(kb: LoadedKB) -> dict[str, str]:
    return {d["doc_ref"]: d.get("text", "") for d in kb.documents
            if d.get("doc_ref")}


def import_document_texts(con: sqlite3.Connection, kb: LoadedKB) -> int:
    """full_text 库：把原文写进 doc_text（并留版本快照）。仅此一次。"""
    now = now_iso()
    n = 0
    for d in kb.documents:
        ref = d.get("doc_ref")
        text = d.get("text")
        if not ref or not text:
            continue
        src, eid = spec.split_doc_ref(ref)
        row = con.execute(
            "SELECT id FROM doc WHERE source = ? AND external_id = ?",
            (src, eid),
        ).fetchone()
        if not row:
            continue
        save_revision(con, int(row["id"]), text,
                      d.get("content_hash") or content_hash(text), now)
        n += 1
    con.commit()
    return n
