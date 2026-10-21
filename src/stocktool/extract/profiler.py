"""作者画像生成：把「一堆历史观点」变成「可读的方法论与偏见清单」。

这是知识库最有价值的部分，也是"吸收大V能力"的真正落点 ——
不是让模型去读原文，而是先归纳出一个**人也能看懂**的画像，
再让 App 把它当作军师的说明书。

铁律：**不许美化**。
画像必须包含对他不利的客观发现（比如"在某标的上显著差于随机"），
否则这个知识库就是在误导使用者。
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter

from ..backtest.stats import binom_test_p, wilson_interval
from ..textutil import now_iso
from .llm_extractor import _extract_json

PROFILE_PROMPT = """你在为一个投资知识库生成「作者画像」。

我会给你某个财经大V的历史观点样本，以及**客观的命中率统计**。
请归纳出他的方法与特征。

严格输出 JSON 对象：
{
  "summary": "150 字以内的整体风格与能力概括",
  "methodology": "他的判断框架，分 3~6 条，每条一行",
  "style_tags": ["3~6 个风格标签"],
  "known_biases": ["3~6 条已知的偏好或偏见"],
  "horizon_bias": "short | mid | long",
  "focus_subjects": ["他最关注的 5~10 个标的"]
}

硬性要求：
1. **不许美化。** 统计显示命中率与随机无异，就必须写出「与随机选股无显著差异」。
2. `known_biases` 必须包含**对他不利的客观发现**，例如
   「在 XX 标的上命中率仅 30%，显著差于随机，但仍在持续推荐」。
3. 区分「他说得多」和「他说得准」——被提及次数最多不等于水平最高。
4. 指出他的方向偏好（例如「73% 的观点是看多」）。
5. 只根据给定材料，不要脑补他的经历或背景。
6. **务必对比不同周期。** 如果短周期（T+5/20/60）与随机无异、
   而长周期（T+250）显著强于随机，必须明确指出他是「长周期有效」型，
   并说明用短周期评判他会得出错误结论。
7. 用中文。summary 与 methodology 面向使用者，要直白。

材料：
---
{data}
---
"""


def render_profile_prompt(data: str) -> str:
    # 同 llm_extractor：提示词含 JSON 示例，绝不能用 str.format()
    return PROFILE_PROMPT.replace("{data}", data)


def build_author_material(con: sqlite3.Connection, author_id: int,
                          horizons=(5, 20, 60), max_opinions: int = 60) -> str:
    """拼出给模型看的材料：统计 + 代表性观点。"""
    lines: list[str] = []

    total = con.execute(
        "SELECT COUNT(*) c FROM opinion WHERE author_id = ?", (author_id,)
    ).fetchone()["c"]
    resolved = con.execute(
        "SELECT COUNT(*) c FROM opinion WHERE author_id = ? AND subject_secid IS NOT NULL",
        (author_id,),
    ).fetchone()["c"]
    pol = con.execute(
        "SELECT SUM(polarity > 0) bull, SUM(polarity < 0) bear FROM opinion "
        "WHERE author_id = ?", (author_id,)
    ).fetchone()
    lines.append(f"观点总数 {total}（已归属标的 {resolved}）")
    lines.append(f"看多 {pol['bull'] or 0} / 看空 {pol['bear'] or 0}")

    lines.append("\n【客观命中率统计（对随机基线做检验）】")
    for h in horizons:
        row = con.execute(
            """
            SELECT COUNT(*) n, SUM(e.hit) hits, AVG(e.signed_excess) avg_ex,
                   b.hit_rate baseline
            FROM opinion_eval e
            JOIN opinion o ON o.id = e.opinion_id
            LEFT JOIN baseline b
              ON b.benchmark_secid = e.benchmark_secid AND b.horizon_days = e.horizon_days
            WHERE o.author_id = ? AND e.horizon_days = ? AND e.status = 'ok'
            """,
            (author_id, h),
        ).fetchone()
        if not row["n"]:
            continue
        n, hits = int(row["n"]), int(row["hits"] or 0)
        rate = hits / n
        base = row["baseline"] or 0.5
        p = binom_test_p(hits, n, base)
        low, _ = wilson_interval(hits, n)
        verdict = ("显著强于随机" if p < 0.05 and rate > base else
                   "显著弱于随机" if p < 0.05 else "与随机无异")
        lines.append(
            f"  T+{h}: {n} 条，命中率 {rate * 100:.1f}%，"
            f"随机基线 {base * 100:.1f}%，p={p:.3f}，"
            f"Wilson下界 {low * 100:.1f}%，平均超额 {(row['avg_ex'] or 0) * 100:+.2f}%"
            f" → {verdict}"
        )

    lines.append("\n【分标的命中率（样本>=8 才列出，按命中率排序）】")
    sub = con.execute(
        """
        SELECT i.name, COUNT(*) n, SUM(e.hit) hits, AVG(e.signed_excess) avg_ex
        FROM opinion_eval e
        JOIN opinion o ON o.id = e.opinion_id
        JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ? AND e.horizon_days = 20 AND e.status = 'ok'
        GROUP BY o.subject_secid HAVING n >= 8 ORDER BY n DESC LIMIT 25
        """,
        (author_id,),
    ).fetchall()
    for r in sub:
        n, hits = int(r["n"]), int(r["hits"] or 0)
        lines.append(
            f"  {r['name']}: {n} 次，命中率 {hits / n * 100:.1f}%，"
            f"平均超额 {(r['avg_ex'] or 0) * 100:+.2f}%"
        )

    lines.append(f"\n【代表性观点（最多 {max_opinions} 条，按时间倒序）】")
    ops = con.execute(
        """
        SELECT o.stated_date, o.subject_raw, i.name AS inst, o.polarity,
               o.strength, o.horizon, o.thesis, o.evidence
        FROM opinion o
        LEFT JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ?
        ORDER BY o.stated_date DESC LIMIT ?
        """,
        (author_id, max_opinions),
    ).fetchall()
    for r in ops:
        who = r["inst"] or r["subject_raw"] or "未指明"
        d = "看多" if r["polarity"] > 0 else "看空"
        body = (r["thesis"] or r["evidence"] or "").replace("\n", " ")[:120]
        lines.append(f"  [{r['stated_date']}] {d} {who}（强度{r['strength']}）{body}")

    # 焦点标的（提及次数）
    focus = con.execute(
        """
        SELECT i.name, COUNT(*) n FROM opinion o
        JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ? GROUP BY o.subject_secid ORDER BY n DESC LIMIT 12
        """,
        (author_id,),
    ).fetchall()
    if focus:
        lines.append("\n【提及次数最多的标的】" +
                     "、".join(f"{r['name']}({r['n']})" for r in focus))
    return "\n".join(lines)


def generate_profile(con: sqlite3.Connection, cfg, llm, author_id: int) -> dict:
    horizons = tuple(cfg.values.get("horizons") or (5, 20, 60, 250))
    material = build_author_material(con, author_id, horizons=horizons)
    raw = llm._chat_generic(render_profile_prompt(material))
    data = _extract_json(raw)
    if not isinstance(data, dict):
        raise SystemExit("画像生成返回的不是 JSON 对象")
    now = now_iso()
    con.execute(
        """
        INSERT INTO author_profile
          (author_id, summary, methodology, style_tags, known_biases,
           horizon_bias, focus_subjects, generated_by, generated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT (author_id) DO UPDATE SET
          summary = excluded.summary, methodology = excluded.methodology,
          style_tags = excluded.style_tags, known_biases = excluded.known_biases,
          horizon_bias = excluded.horizon_bias,
          focus_subjects = excluded.focus_subjects,
          generated_by = excluded.generated_by, generated_at = excluded.generated_at
        """,
        (
            author_id,
            data.get("summary"),
            data.get("methodology"),
            json.dumps(data.get("style_tags") or [], ensure_ascii=False),
            json.dumps(data.get("known_biases") or [], ensure_ascii=False),
            data.get("horizon_bias"),
            json.dumps(data.get("focus_subjects") or [], ensure_ascii=False),
            llm.id,
            now,
        ),
    )
    con.commit()
    return data


def load_profile(con: sqlite3.Connection, author_id: int) -> dict | None:
    row = con.execute(
        "SELECT * FROM author_profile WHERE author_id = ?", (author_id,)
    ).fetchone()
    if not row:
        return None

    def arr(v):
        try:
            out = json.loads(v or "[]")
            return out if isinstance(out, list) else []
        except (TypeError, ValueError):
            return []

    return {
        "summary": row["summary"],
        "methodology": row["methodology"],
        "style_tags": arr(row["style_tags"]),
        "known_biases": arr(row["known_biases"]),
        "horizon_bias": row["horizon_bias"],
        "focus_subjects": arr(row["focus_subjects"]),
        "generated_by": row["generated_by"],
        "generated_at": row["generated_at"],
    }


def top_subjects(con: sqlite3.Connection, author_id: int, limit: int = 10) -> list[str]:
    rows = con.execute(
        """
        SELECT i.name, COUNT(*) n FROM opinion o
        JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ? GROUP BY o.subject_secid ORDER BY n DESC LIMIT ?
        """,
        (author_id, limit),
    ).fetchall()
    return [r["name"] for r in rows]
