"""绩效榜与板块共识。

这两个输出就是产品的核心价值：
  - 绩效榜：谁在这个板块上历史上判断得准
  - 板块共识：当下被看多的板块，且按历史准确度加权
"""

from __future__ import annotations

import sqlite3
from statistics import mean, median

from .baseline import load_baseline
from .stats import binom_test_p, summarize_returns, verdict_vs, wilson_interval


def _rows_to_stats(rows: list[sqlite3.Row], min_samples: int,
                   baseline: float | None = None) -> dict:
    signed = [r["signed_excess"] for r in rows if r["signed_excess"] is not None]
    hits = [r["hit"] for r in rows if r["hit"] is not None]
    n = len(hits)
    k = sum(hits)
    base = summarize_returns(signed)
    low, high = wilson_interval(k, n)
    out = {
        "n": n,
        "hits": k,
        "hit_rate": (k / n) if n else None,
        "wilson_low": low if n else None,
        "wilson_high": high if n else None,
        # 对 50% 的检验：仅作参考，A 股里这个原假设通常是错的
        "p_value": binom_test_p(k, n, 0.5) if n else None,
        # 对实测基线的检验：这才是该看的数字
        "p_value_vs_baseline": binom_test_p(k, n, baseline) if n and baseline else None,
        "baseline_hit_rate": baseline,
        "avg_excess": base["mean"],
        "median_excess": base["median"],
        "payoff": base["payoff"],
        "rankable": n >= min_samples,
    }
    out["verdict"] = verdict_vs(out, baseline, min_samples)
    return out


def build_scoreboard(con: sqlite3.Connection, cfg, *,
                     horizon: int | None = None,
                     benchmark_secid: str | None = None,
                     min_samples: int | None = None) -> list[dict]:
    benchmark_secid = benchmark_secid or str(cfg.values["benchmark_secid"])
    min_samples = min_samples if min_samples is not None else int(
        cfg.values["min_samples_for_rank"]
    )
    horizon = horizon or int(cfg.values["horizons"][1] if len(cfg.values["horizons"]) > 1
                             else cfg.values["horizons"][0])

    authors = con.execute("SELECT id, name, source FROM author ORDER BY name").fetchall()
    baselines = load_baseline(con, benchmark_secid)
    baseline = (baselines.get(horizon) or {}).get("hit_rate")
    out: list[dict] = []
    for author in authors:
        rows = con.execute(
            """
            SELECT e.signed_excess, e.hit, o.subject_type, o.polarity
            FROM opinion_eval e JOIN opinion o ON o.id = e.opinion_id
            WHERE o.author_id = ? AND e.horizon_days = ?
              AND e.benchmark_secid = ? AND e.status = 'ok'
              AND o.is_dup = 0
            """,
            (author["id"], horizon, benchmark_secid),
        ).fetchall()
        entry = {
            "author_id": author["id"],
            "author": author["name"],
            "source": author["source"],
            "horizon": horizon,
            **_rows_to_stats(rows, min_samples, baseline),
        }
        # 按标的类型拆
        for stype in ("stock", "fund", "industry", "concept", "index"):
            sub = [r for r in rows if r["subject_type"] == stype]
            entry[f"by_{stype}"] = _rows_to_stats(sub, min_samples, baseline) if sub else None
        # 按方向拆
        entry["by_bull"] = _rows_to_stats([r for r in rows if r["polarity"] > 0],
                                          min_samples, baseline)
        entry["by_bear"] = _rows_to_stats([r for r in rows if r["polarity"] < 0],
                                          min_samples, baseline)
        out.append(entry)

    out.sort(
        key=lambda e: (
            not e["rankable"],
            -((e["hit_rate"] or 0) - (e["baseline_hit_rate"] or 0.5)),
            -(e["avg_excess"] if e["avg_excess"] is not None else 0),
        )
    )
    return out


def author_weights(con: sqlite3.Connection, cfg, *,
                   horizon: int | None = None,
                   benchmark_secid: str | None = None,
                   floor: float = 0.2) -> dict[int, float]:
    """按历史命中率给作者加权，样本不足的取中性 0.5。"""
    board = build_scoreboard(con, cfg, horizon=horizon,
                             benchmark_secid=benchmark_secid)
    weights: dict[int, float] = {}
    for entry in board:
        if entry["n"] == 0 or entry["hit_rate"] is None:
            weights[entry["author_id"]] = 0.5
        elif entry["rankable"]:
            weights[entry["author_id"]] = max(floor, min(1.0, entry["hit_rate"]))
        else:
            weights[entry["author_id"]] = 0.5
    return weights


def build_consensus(con: sqlite3.Connection, cfg, *,
                    since_date: str | None = None,
                    benchmark_secid: str | None = None,
                    min_authors: int = 1) -> list[dict]:
    """板块/标的共识：当下被看多的方向，按作者历史准确度加权。"""
    weights = author_weights(con, cfg, benchmark_secid=benchmark_secid)

    sql = """
        SELECT o.subject_secid, i.name AS subject_name, i.type AS subject_type,
               o.author_id, o.polarity, o.strength, o.stated_date, o.confidence
        FROM opinion o JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.resolved = 1 AND o.subject_secid IS NOT NULL
          AND o.is_dup = 0
    """
    params: list[str] = []
    if since_date:
        sql += " AND o.stated_date >= ?"
        params.append(since_date)
    rows = con.execute(sql, params).fetchall()

    buckets: dict[str, dict] = {}
    for r in rows:
        code = r["subject_secid"]
        b = buckets.setdefault(code, {
            "code": code,
            "name": r["subject_name"],
            "type": r["subject_type"],
            "bull": 0, "bear": 0, "score": 0.0, "authors": set(),
            "last_date": "",
        })
        w = weights.get(r["author_id"], 0.5)
        contribution = w * r["polarity"] * (r["strength"] / 3.0)
        b["score"] += contribution
        b["authors"].add(r["author_id"])
        if r["polarity"] > 0:
            b["bull"] += 1
        elif r["polarity"] < 0:
            b["bear"] += 1
        b["last_date"] = max(b["last_date"], r["stated_date"])

    out: list[dict] = []
    for b in buckets.values():
        if len(b["authors"]) < min_authors:
            continue
        out.append({
            "code": b["code"],
            "name": b["name"],
            "type": b["type"],
            "bull": b["bull"],
            "bear": b["bear"],
            "n_authors": len(b["authors"]),
            "score": round(b["score"], 3),
            "last_date": b["last_date"],
        })
    out.sort(key=lambda x: -x["score"])
    return out
