"""从本地数据库导出知识库。"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from .. import __version__
from ..extract.persona import load_persona, persona_to_prompt
from ..extract.profiler import load_profile, top_subjects
from ..textutil import now_iso
from . import spec
from .bundle import write_bundle

# 每篇文档最早那个版本的哈希 —— 代表"最初采集到的样子"，
# 后面即使大V改帖，这个值也能证明原文是什么
_EARLIEST_HASH = (
    "(SELECT r.content_hash FROM doc_revision r "
    " WHERE r.doc_id = d.id ORDER BY r.captured_at LIMIT 1)"
)


def export_kb(con: sqlite3.Connection, cfg, *, out_path: Path,
              policy: str = spec.POLICY_EVIDENCE,
              kb_id: str | None = None,
              title: str | None = None,
              description: str | None = None,
              authors: list[str] | None = None,
              source: str | None = None,
              include_evaluations: bool = True,
              max_evidence_chars: int = 200,
              publisher: str = "self") -> dict:
    """导出知识库。返回统计信息。"""
    if policy not in spec.POLICIES:
        raise SystemExit(f"content_policy 只能是 {spec.POLICIES}")

    where, params = ["1=1"], []
    if authors:
        marks = ",".join("?" * len(authors))
        where.append(f"(a.name IN ({marks}) OR a.source_uid IN ({marks}))")
        params.extend(authors)
        params.extend(authors)
    if source:
        where.append("a.source = ?")
        params.append(source)
    cond = " AND ".join(where)

    rows = con.execute(f"""
        SELECT o.opinion_key, o.stated_at, o.stated_date, o.char_start,
               o.subject_raw, o.subject_secid, o.subject_type, o.match_conf,
               o.polarity, o.strength, o.horizon, o.thesis, o.triggers,
               o.evidence, o.extractor, o.confidence,
               a.source AS a_source, a.source_uid, a.name AS author_name,
               d.external_id, d.kind, d.published_at, d.title, d.permalink,
               {_EARLIEST_HASH} AS doc_hash
        FROM opinion o
        JOIN author a ON a.id = o.author_id
        JOIN doc    d ON d.id = o.doc_id
        WHERE {cond}
        ORDER BY o.stated_date, o.stated_at, o.id
    """, params).fetchall()

    if not rows:
        raise SystemExit("没有匹配的观点，无法导出。先跑 extract。")

    used_secids = {r["subject_secid"] for r in rows if r["subject_secid"]}
    doc_ids: set[int] = set()
    author_meta: dict[str, dict] = {}
    opinions: list[dict] = []
    dropped_neutral = 0

    for r in rows:
        # 兜底：规范只允许 polarity ±1。中性不是方向判断，
        # 既不可回测也不该进知识库。
        if int(r["polarity"]) not in (-1, 1):
            dropped_neutral += 1
            continue
        auid = spec.author_uid_of(r["a_source"], r["source_uid"])
        doc_ref = spec.doc_ref_of(r["a_source"], r["external_id"])
        author_meta.setdefault(auid, {
            "author_uid": auid, "name": r["author_name"], "source": r["a_source"],
        })
        opinions.append({
            "opinion_id": spec.make_opinion_id(
                auid, doc_ref, r["char_start"], r["subject_secid"],
                r["subject_raw"]),
            "author_uid": auid,
            "doc_ref": doc_ref,
            "doc_hash": r["doc_hash"],
            "stated_at": r["stated_at"],
            "stated_date": r["stated_date"],
            "subject": {
                "secid": r["subject_secid"],
                "raw": r["subject_raw"],
                "match_conf": r["match_conf"],
            },
            "subject_type": r["subject_type"] or "unresolved",
            "polarity": int(r["polarity"]),
            "strength": int(r["strength"] or 3),
            "horizon": r["horizon"] or "unspecified",
            "thesis": r["thesis"],
            "triggers": _loads_list(r["triggers"]),
            "evidence": _clip(r["evidence"], max_evidence_chars),
            "extractor": r["extractor"],
            "confidence": r["confidence"],
        })

    # ---------- 标的字典（只带引用到的，保证自包含且体积小）----------
    instruments: list[dict] = []
    if used_secids:
        marks = ",".join("?" * len(used_secids))
        slist = sorted(used_secids)
        alias_map: dict[str, list[str]] = defaultdict(list)
        for row in con.execute(
            f"SELECT secid, alias FROM alias WHERE secid IN ({marks})", slist
        ):
            alias_map[row["secid"]].append(row["alias"])
        for row in con.execute(
            f"SELECT secid, code, name, type, exchange FROM instrument "
            f"WHERE secid IN ({marks}) ORDER BY secid", slist
        ):
            instruments.append({
                "secid": row["secid"], "code": row["code"], "name": row["name"],
                "type": row["type"], "exchange": row["exchange"],
                "aliases": sorted(alias_map.get(row["secid"], [])),
            })
        missing = used_secids - {i["secid"] for i in instruments}
        if missing:
            print(f"  ! {len(missing)} 个标的在 instrument 表里找不到: "
                  f"{sorted(missing)[:5]}")

    # ---------- 回测结果（离线出绩效榜用）----------
    evaluations: list[dict] = []
    if include_evaluations:
        erows = con.execute(f"""
            SELECT o.opinion_key, o.char_start, o.stated_at, o.stated_date,
                   o.subject_secid, o.subject_raw, a.source AS a_source,
                   a.source_uid, d.external_id,
                   e.horizon_days, e.benchmark_secid, e.entry_date, e.entry_close,
                   e.exit_date, e.exit_close, e.bench_return, e.excess_return,
                   e.signed_excess, e.hit, e.max_adverse, e.status
            FROM opinion_eval e
            JOIN opinion o ON o.id = e.opinion_id
            JOIN author  a ON a.id = o.author_id
            JOIN doc     d ON d.id = o.doc_id
            WHERE {cond}
        """, params).fetchall()
        for r in erows:
            auid = spec.author_uid_of(r["a_source"], r["source_uid"])
            doc_ref = spec.doc_ref_of(r["a_source"], r["external_id"])
            evaluations.append({
                "opinion_id": spec.make_opinion_id(
                    auid, doc_ref, r["char_start"], r["subject_secid"],
                    r["subject_raw"]),
                "horizon_days": r["horizon_days"],
                "benchmark_secid": r["benchmark_secid"],
                "entry_date": r["entry_date"], "entry_close": r["entry_close"],
                "exit_date": r["exit_date"], "exit_close": r["exit_close"],
                "bench_return": r["bench_return"],
                "excess_return": r["excess_return"],
                "signed_excess": r["signed_excess"],
                "hit": r["hit"], "max_adverse": r["max_adverse"],
                "status": r["status"],
            })

    # ---------- 原文（仅 full_text）----------
    documents: list[dict] = []
    if policy == spec.POLICY_FULL:
        dwhere, dparams = ["1=1"], []
        if authors:
            marks = ",".join("?" * len(authors))
            dwhere.append(f"(a.name IN ({marks}) OR a.source_uid IN ({marks}))")
            dparams.extend(authors)
            dparams.extend(authors)
        if source:
            dwhere.append("a.source = ?")
            dparams.append(source)
        dcond = " AND ".join(dwhere)
        drows = con.execute(f"""
            SELECT d.external_id, d.kind, d.published_at, d.title, d.permalink,
                   d.raw_meta, t.text,
                   a.source AS a_source, a.source_uid, a.name AS author_name,
                   {_EARLIEST_HASH} AS doc_hash
            FROM doc d
            JOIN doc_text t ON t.doc_id = d.id
            JOIN author   a ON a.id = d.author_id
            WHERE {dcond}
            ORDER BY d.published_at
        """, dparams).fetchall()
        for r in drows:
            auid = spec.author_uid_of(r["a_source"], r["source_uid"])
            documents.append({
                "doc_ref": spec.doc_ref_of(r["a_source"], r["external_id"]),
                "author_uid": auid,
                "published_at": r["published_at"],
                "kind": r["kind"],
                "title": r["title"],
                "text": r["text"],
                "content_hash": r["doc_hash"],
                "permalink": r["permalink"],
                "raw_meta": _loads_dict(r["raw_meta"]),
            })

    # ---------- 组装 ----------
    stamp = datetime.now().strftime("%Y%m%d")
    now = now_iso()
    counts = {
        # 恒为 1：单作者是格式契约，多作者在 _build_author 里已被拦下
        "authors": len(author_meta),
        "documents": len(documents),
        "opinions": len(opinions),
        "instruments": len(instruments),
    }

    files: dict[str, str] = {}
    files[spec.AUTHOR] = spec.dumps_pretty(
        _build_author(con, author_meta, rows, source))
    files[spec.INSTRUMENTS] = "\n".join(
        spec.dumps_line(i) for i in instruments) + "\n"
    files[spec.OPINIONS] = "\n".join(
        spec.dumps_line(o) for o in opinions) + "\n"
    if evaluations:
        files[spec.EVALUATIONS] = "\n".join(
            spec.dumps_line(e) for e in evaluations) + "\n"
    if documents:
        files[spec.DOCUMENTS] = "\n".join(
            spec.dumps_line(d) for d in documents) + "\n"

    integrity_files = {
        name: spec.sha256_text(text)
        for name, text in sorted(files.items())
    }

    src = next(iter(author_meta.values()))
    manifest = {
        "kb_format": spec.FORMAT_NAME,
        "format_version": spec.FORMAT_VERSION,
        "kb_id": kb_id or spec.default_kb_id(src["source"], src["author_uid"], stamp),
        "title": title or f"{src['name']} · 观点知识库",
        "description": description,
        "content_policy": policy,
        "created_at": now,
        "generator": {"name": "stocktool", "version": __version__},
        "publisher": {"name": publisher, "contact": None},
        "sources": _build_sources(con, author_meta, rows),
        "extractor": _build_extractor(rows),
        "benchmark": str(cfg.values["benchmark_secid"]),
        "horizons": list(cfg.values["horizons"]),
        "counts": counts,
        "quote_policy": {"max_evidence_chars": max_evidence_chars},
        "integrity": {"algorithm": "sha256", "files": integrity_files},
        "license": {
            "kb": "private",
            "source_content": "all-rights-reserved-by-original-author",
        },
    }
    files[spec.MANIFEST] = spec.dumps_pretty(manifest)

    written = write_bundle(Path(out_path), files)
    size = written.stat().st_size if written.is_file() else sum(
        f.stat().st_size for f in written.iterdir() if f.is_file())
    if dropped_neutral:
        print(f"  ! 已跳过 {dropped_neutral} 条中性观点（规范只允许 ±1）")
    return {"path": str(written), "size_bytes": size, "counts": counts,
            "policy": policy, "kb_id": manifest["kb_id"],
            "evaluations": len(evaluations), "documents": len(documents),
            "dropped_neutral": dropped_neutral}


# ---------------------------------------------------------------- 内部

def _clip(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= limit else text[:limit]


def _loads_list(raw) -> list:
    import json
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except (TypeError, ValueError):
        return []


def _loads_dict(raw) -> dict:
    import json
    if not raw:
        return {}
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) else {}
    except (TypeError, ValueError):
        return {}


def _build_sources(con, author_meta: dict, rows) -> list[dict]:
    out = []
    for auid, meta in author_meta.items():
        s, uid = spec.split_author_uid(auid)
        row = con.execute("""
            SELECT COUNT(*) n, MIN(d.published_date) a, MAX(d.published_date) b
            FROM doc d JOIN author a ON a.id = d.author_id
            WHERE a.source = ? AND a.source_uid = ?
        """, (s, uid)).fetchone()
        out.append({
            "source": s,
            "author_uid": uid,
            "author_name": meta["name"],
            "harvested_at": now_iso(),
            "doc_count": int(row["n"] or 0),
            "period": {"first": row["a"], "last": row["b"]},
        })
    return out


def _build_extractor(rows) -> dict:
    modes = Counter("llm" if str(r["extractor"]).startswith("llm") else "rule"
                    for r in rows)
    models = sorted({r["extractor"] for r in rows
                     if str(r["extractor"]).startswith("llm")})
    mode = modes.most_common(1)[0][0] if modes else "unknown"
    return {
        "mode": mode,
        "model": models[0].split(":", 1)[1] if models else None,
        "prompt_version": "1",
        "note": ("口语化内容必须用 LLM；词表规则会判反方向"
                 if mode == "llm" else
                 "使用词表规则抽取，仅适合表述规范的内容"),
    }


def _build_author(con, author_meta: dict, rows, source) -> dict:
    """构造作者画像。

    **契约：一个 .stkb = 一位军师。**
    author.json 只能装一个作者对象，多作者导出会让除第一个以外的
    作者变成"没有画像的孤儿观点"。想组建军师团就导出多个知识库、
    在 App 里一起载入 —— 这既符合产品语义，也让格式保持简单。
    """
    if not author_meta:
        return {}
    if len(author_meta) > 1:
        names = "、".join(m.get("name") or k for k, m in list(author_meta.items())[:5])
        raise SystemExit(
            f"一次只能导出**一位**大V，但筛选出了 {len(author_meta)} 位：{names}\n"
            f"请用 --author 指定一位，或为每位分别导出：\n"
            f"    python run.py kb-export out.stkb --author <名字> --policy evidence_only"
        )
    auid, meta = next(iter(author_meta.items()))
    auid_source, auid_uid = spec.split_author_uid(auid)

    arow = con.execute(
        "SELECT id, platforms FROM author WHERE source = ? AND source_uid = ?",
        (auid_source, auid_uid),
    ).fetchone()
    profile = load_profile(con, int(arow["id"])) if arow else None
    persona = load_persona(con, int(arow["id"])) if arow else None
    try:
        platforms = json.loads((arow["platforms"] if arow else None) or "[]")
        if not isinstance(platforms, list):
            platforms = []
    except (TypeError, ValueError):
        platforms = []

    focus = Counter(r["subject_secid"] for r in rows if r["subject_secid"])
    name_of = {}
    if focus:
        marks = ",".join("?" * len(focus))
        for row in con.execute(
            f"SELECT secid, name FROM instrument WHERE secid IN ({marks})",
            list(focus),
        ):
            name_of[row["secid"]] = row["name"]

    horizons = Counter(r["horizon"] or "unspecified" for r in rows)

    # 文档数必须查库，不能用 len({opinion.external_id})：
    # 那样得到的是"有观点的文档数"，不是"采集到的文档数"。
    doc_row = con.execute("""
        SELECT COUNT(*) n, MIN(d.published_date) a, MAX(d.published_date) b
        FROM doc d JOIN author a ON a.id = d.author_id
        WHERE a.source = ? AND a.source_uid = ?
    """, (auid_source, auid_uid)).fetchone()

    focus_from_opinions = [name_of.get(s, s) for s, _ in focus.most_common(10)]
    p = profile or {}
    return {
        "author_uid": auid,
        "name": meta["name"],
        "source": meta["source"],
        # 跨平台身份：同一个人在其他平台叫什么。
        # App 可以用它提示用户"你载入的两个知识库其实是同一位军师"。
        "platforms": platforms,
        "summary": p.get("summary"),
        "style_tags": p.get("style_tags") or [],
        "focus_subjects": p.get("focus_subjects") or focus_from_opinions,
        "methodology": p.get("methodology"),
        "known_biases": p.get("known_biases") or [],
        "horizon_bias": (p.get("horizon_bias")
                         or (horizons.most_common(1)[0][0] if horizons else None)),
        "activity": {
            "first_post": doc_row["a"],
            "last_post": doc_row["b"],
            "doc_count": int(doc_row["n"] or 0),
            "opinion_count": len(rows),
        },
        # 「数字化的他」本体：可迁移的决策框架。
        # App 的军师模式用 persona 推导新情况，而不是复述 opinions。
        "persona": persona,
        "generated_by": p.get("generated_by") or "heuristic",
        "generated_at": p.get("generated_at") or now_iso(),
    }
