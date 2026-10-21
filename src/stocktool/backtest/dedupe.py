"""去重：同一个观点被反复发帖时，只算一次。

为什么必须做：
  社交平台上，作者会反复顶帖、分别回复不同人，同一段话会生成多条帖子。
  实测同一个观点最多重复五次以上（同一天、不同帖子 ID、内容一字不差）。
  不去重的话：
    · 样本量虚高（二十来条里可能只有八到十条是独立观点）
    · Wilson 置信区间变窄
    · p 值假性显著
  这会让绩效榜得出"显著强/弱"的结论，而实际上样本根本不够。

判定口径：同一作者 + 同一标的 + **同一段证据文本**，只保留最早那条，
其余标记 is_dup=1。用证据文本而不是整篇正文，
是因为作者常常在不同帖子里引用同一句话。
"""

from __future__ import annotations

import hashlib
import sqlite3
import re
from collections import defaultdict

_WS = re.compile(r"[\s\u3000]+")


def evidence_fingerprint(text: str | None) -> str | None:
    """证据文本指纹。归一化空白后再哈希，避免排版差异造成假区分。"""
    if not text:
        return None
    norm = _WS.sub("", str(text)).strip()
    if not norm:
        return None
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def backfill_hashes(con: sqlite3.Connection) -> int:
    """给还没有指纹的观点补上（老数据）。"""
    rows = con.execute(
        "SELECT id, evidence FROM opinion WHERE evidence_hash IS NULL"
    ).fetchall()
    n = 0
    for r in rows:
        h = evidence_fingerprint(r["evidence"])
        if h:
            con.execute("UPDATE opinion SET evidence_hash = ? WHERE id = ?",
                        (h, r["id"]))
            n += 1
    con.commit()
    return n


def mark_duplicates(con: sqlite3.Connection, *, author: str | None = None) -> dict:
    """标记重复观点。返回统计。"""
    backfill_hashes(con)

    where, params = ["o.evidence_hash IS NOT NULL", "o.resolved = 1"], []
    if author:
        where.append("a.name = ?")
        params.append(author)
    cond = " AND ".join(where)

    rows = con.execute(f"""
        SELECT o.id, o.author_id, o.subject_secid, o.subject_raw,
               o.evidence_hash, o.stated_date
        FROM opinion o JOIN author a ON a.id = o.author_id
        WHERE {cond}
        ORDER BY o.stated_date, o.id
    """, params).fetchall()

    groups: dict[tuple, list] = defaultdict(list)
    for r in rows:
        key = (r["author_id"], r["subject_secid"] or r["subject_raw"] or "",
               r["evidence_hash"])
        groups[key].append(r)

    con.execute("UPDATE opinion SET is_dup = 0")
    dup_ids: list[int] = []
    dup_groups = 0
    for key, items in groups.items():
        if len(items) < 2:
            continue
        dup_groups += 1
        for r in items[1:]:          # 保留最早的，其余算重复
            dup_ids.append(r["id"])

    for start in range(0, len(dup_ids), 400):
        chunk = dup_ids[start:start + 400]
        marks = ",".join("?" * len(chunk))
        con.execute(f"UPDATE opinion SET is_dup = 1 WHERE id IN ({marks})", chunk)
    con.commit()

    total = con.execute("SELECT COUNT(*) c FROM opinion").fetchone()["c"]
    dup = con.execute("SELECT COUNT(*) c FROM opinion WHERE is_dup = 1").fetchone()["c"]
    return {
        "total": total,
        "duplicates": dup,
        "unique": total - dup,
        "dup_groups": dup_groups,
        "dup_rate": dup / total if total else 0.0,
    }


def duplicate_examples(con: sqlite3.Connection, limit: int = 10) -> list[dict]:
    """列出重复最严重的组，便于人工核对（尤其是被灌水的标的）。"""
    rows = con.execute("""
        SELECT COALESCE(i.name, o.subject_raw) AS subject, o.evidence_hash,
               COUNT(*) n, MIN(o.stated_date) a, MAX(o.stated_date) b,
               GROUP_CONCAT(o.id) ids
        FROM opinion o
        LEFT JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.evidence_hash IS NOT NULL AND o.resolved = 1
        GROUP BY o.author_id, COALESCE(o.subject_secid, o.subject_raw),
                 o.evidence_hash
        HAVING n > 1
        ORDER BY n DESC LIMIT ?
    """, (limit,)).fetchall()
    out = []
    for r in rows:
        sample = con.execute(
            "SELECT evidence FROM opinion WHERE id = ? LIMIT 1",
            (r["ids"].split(",")[0],),
        ).fetchone()
        out.append({
            "subject": r["subject"], "n": int(r["n"]),
            "first": r["a"], "last": r["b"],
            "evidence": (sample["evidence"] if sample else "")[:90],
        })
    return out
