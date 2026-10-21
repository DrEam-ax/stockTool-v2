"""分标的看真实水平：整体不行，不代表处处不行。

这才是 App 要给用户的东西 —— 不是"这个军师准不准"，
而是"这个军师在**哪些标的、哪个周期**上准"。
"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.backtest.stats import sign_test_p, wilson_interval  # noqa: E402
from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402

MIN_N = 8


def verdict(n: int, hits: int, rate: float, p: float, low: float) -> str:
    if n < MIN_N:
        return "样本不足"
    if p < 0.05 and low > 0.5:
        return "★ 显著强"
    if p < 0.05 and rate < 0.5:
        return "✗ 显著弱"
    return "与随机无异"


def main() -> int:
    cfg = load_config()
    con = connect(cfg)
    horizon = 20

    rows = con.execute(
        """f"""
        SELECT i.name AS name, o.subject_secid AS secid, COUNT(*) n,
               SUM(e.hit) hits, AVG(e.signed_excess) avg_ex,
               SUM(CASE WHEN o.polarity > 0 THEN 1 ELSE 0 END) bull,
               SUM(CASE WHEN o.polarity < 0 THEN 1 ELSE 0 END) bear
        FROM opinion_eval e
        JOIN opinion o ON o.id = e.opinion_id
        JOIN author a ON a.id = o.author_id
        JOIN instrument i ON i.secid = o.subject_secid
        WHERE a.name = {AUTHOR} AND e.horizon_days = ? AND e.status = 'ok'
          AND o.is_dup = 0
        GROUP BY o.subject_secid HAVING n >= 3
        ORDER BY n DESC
        """,
        (horizon,),
    ).fetchall()

    out = []
    for r in rows:
        n, hits = int(r["n"]), int(r["hits"] or 0)
        rate = hits / n
        low, high = wilson_interval(hits, n)
        p = sign_test_p(hits, n)
        out.append({
            "name": r["name"], "n": n, "hits": hits, "rate": rate,
            "low": low, "high": high, "p": p, "avg": r["avg_ex"] or 0,
            "bull": int(r["bull"] or 0), "bear": int(r["bear"] or 0),
            "verdict": verdict(n, hits, rate, p, low),
        })

    out.sort(key=lambda x: (-x["low"], -x["n"]))

    print("=" * 104)
    print(f"分标的真实水平 · T+{horizon}（按 Wilson 下界排序，最少 {MIN_N} 个样本才算数）")
    print("已去重。方向列告诉你这个成绩是「看多准」还是「看空准」——"
          "「显著强」不等于他推荐过它。")
    print("=" * 104)
    print(f"{'标的':<16}{'样本':>5}{'看多':>5}{'看空':>5}{'命中':>5}{'命中率':>9}"
          f"{'Wilson下界':>11}{'p值':>8}{'平均超额':>10}  判定")
    print("-" * 104)
    for x in out:
        if x["n"] < MIN_N:
            continue
        print(f"{x['name']:<16}{x['n']:>5}{x['bull']:>5}{x['bear']:>5}{x['hits']:>5}"
              f"{x['rate'] * 100:>8.1f}%{x['low'] * 100:>10.1f}%{x['p']:>8.3f}"
              f"{x['avg'] * 100:>9.2f}%  {x['verdict']}")

    weak = [x for x in out if x["n"] >= MIN_N and x["verdict"] == "✗ 显著弱"]
    if weak:
        print()
        print("显著弱于随机的标的：")
        for x in weak:
            print(f"  {x['name']:<16} {x['n']:>4} 次，命中率 {x['rate'] * 100:.1f}%，"
                  f"平均超额 {x['avg'] * 100:+.2f}%")

    small = [x for x in out if x["n"] < MIN_N]
    if small:
        print()
        print(f"样本不足 {MIN_N} 的标的（{len(small)} 个，不下结论）：")
        print("  " + "、".join(f"{x['name']}({x['n']})" for x in small[:20]))

    # 按方向拆分
    print()
    print("=" * 92)
    print("按方向拆分")
    print("=" * 92)
    for pol, label in ((1, "看多"), (-1, "看空")):
        r = con.execute(
            """f"""
            SELECT COUNT(*) n, SUM(e.hit) hits, AVG(e.signed_excess) avg_ex
            FROM opinion_eval e
            JOIN opinion o ON o.id = e.opinion_id
            JOIN author a ON a.id = o.author_id
            WHERE a.name = {AUTHOR} AND e.horizon_days = ? AND e.status = 'ok'
              AND o.polarity = ?
            """,
            (horizon, pol),
        ).fetchone()
        n, hits = int(r["n"] or 0), int(r["hits"] or 0)
        if not n:
            continue
        rate = hits / n
        low, _ = wilson_interval(hits, n)
        p = sign_test_p(hits, n)
        print(f"  {label}: {n:>4} 条，命中率 {rate * 100:5.1f}%，"
              f"Wilson 下界 {low * 100:5.1f}%，p={p:.4f}，"
              f"平均超额 {(r['avg_ex'] or 0) * 100:+.2f}%  "
              f"{verdict(n, hits, rate, p, low)}")

    # 按周期
    print()
    print("按周期")
    for h in (5, 20, 60):
        r = con.execute(
            """f"""
            SELECT COUNT(*) n, SUM(e.hit) hits, AVG(e.signed_excess) avg_ex
            FROM opinion_eval e
            JOIN opinion o ON o.id = e.opinion_id
            JOIN author a ON a.id = o.author_id
            WHERE a.name = {AUTHOR} AND e.horizon_days = ? AND e.status = 'ok'
            """,
            (h,),
        ).fetchone()
        n, hits = int(r["n"] or 0), int(r["hits"] or 0)
        if not n:
            continue
        rate = hits / n
        low, _ = wilson_interval(hits, n)
        p = sign_test_p(hits, n)
        print(f"  T+{h:<3}: {n:>4} 条，命中率 {rate * 100:5.1f}%，"
              f"Wilson 下界 {low * 100:5.1f}%，p={p:.4f}，"
              f"平均超额 {(r['avg_ex'] or 0) * 100:+.2f}%  "
              f"{verdict(n, hits, rate, p, low)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
