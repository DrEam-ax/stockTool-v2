"""对照组实验：随机选股在同一批日期上能有多少命中率？

为什么必须做这个：
  该大V 73% 的观点是看多。如果同期 A 股整体跑赢沪深300 的比例
  本来就只有 ~40%，那"命中率 41%"根本不说明他水平差，
  只说明他跟着大盘走。没有基线，绩效榜的数字会被系统性误读。

做法：
  取他每条观点的发布日期，在同样的日期上随机抽 3 只 A 股，
  算同样的「方向调整后超额收益」（这里方向一律按看多，因为他以看多为主），
  得到随机选股的命中率分布，与他的真实成绩对比。
"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402
from stocktool.market import PriceService  # noqa: E402
from stocktool.market.store import (  # noqa: E402
    get_bars, quote_coverage, trading_calendar, upsert_quotes,
)
from stocktool.models import Instrument  # noqa: E402

SAMPLE_STOCKS = 180
PICKS_PER_DATE = 3
HORIZONS = (5, 20, 60)
SEED = 20261008


def main() -> int:
    random.seed(SEED)
    cfg = load_config()
    con = connect(cfg)
    bench = str(cfg.values["benchmark_secid"])
    calendar = trading_calendar(con, bench)
    if not calendar:
        print("没有基准行情，先跑 fetch-quotes")
        return 1
    bench_map = {b.trade_date: b for b in get_bars(con, bench)}

    # 他观点的日期（去重），作为对照组的时间轴
    dates = [
        r["stated_date"]
        for r in con.execute(
            "SELECT DISTINCT stated_date FROM opinion "
            "WHERE stated_date IS NOT NULL ORDER BY stated_date"
        )
    ]
    print(f"观点日期数: {len(dates)}")

    # 随机抽股票（只从个股里抽，排除 ETF/指数/板块）
    stocks = [
        r for r in con.execute(
            "SELECT secid, code, name, type, market, exchange FROM instrument "
            "WHERE type = 'stock'"
        )
    ]
    random.shuffle(stocks)
    picked = [
        Instrument(r["secid"], r["code"], r["name"], r["type"],
                   r["market"], r["exchange"])
        for r in stocks[:SAMPLE_STOCKS]
    ]
    print(f"随机抽取个股: {len(picked)} 只")

    # 拉行情（已有则跳过）
    svc = PriceService(cfg)
    fetched = 0
    for i, inst in enumerate(picked, 1):
        _, _, n = quote_coverage(con, inst.secid)
        if n > 0:
            continue
        bars, source = svc.bars(inst)
        if bars:
            upsert_quotes(con, inst.secid, bars, source=source)
            fetched += 1
        if i % 40 == 0:
            con.commit()
            print(f"  … {i}/{len(picked)}")
    con.commit()
    print(f"新增行情: {fetched} 只")

    # 为每个日期抽 PICKS_PER_DATE 只，算超额
    idx_of = {d: i for i, d in enumerate(calendar)}
    results = {h: [] for h in HORIZONS}
    skipped = 0

    for date in dates:
        i0 = None
        for i, d in enumerate(calendar):
            if d > date:
                i0 = i
                break
        if i0 is None:
            skipped += 1
            continue
        entry_date = calendar[i0]
        b_entry = bench_map.get(entry_date)
        if b_entry is None:
            skipped += 1
            continue

        for inst in random.sample(picked, min(PICKS_PER_DATE, len(picked))):
            bars = get_bars(con, inst.secid)
            if not bars:
                continue
            bar_map = {b.trade_date: b for b in bars}
            e = bar_map.get(entry_date)
            if e is None or e.close <= 0:
                continue
            for h in HORIZONS:
                ie = i0 + h
                if ie >= len(calendar):
                    continue
                ex_date = calendar[ie]
                x = bar_map.get(ex_date)
                bx = bench_map.get(ex_date)
                if x is None or bx is None or x.close <= 0:
                    continue
                raw = x.close / e.close - 1
                bret = bx.close / b_entry.close - 1
                results[h].append(raw - bret)

    print()
    print("=" * 70)
    print("对照组：随机选股 + 一律看多，在同一批日期上的命中率")
    print("=" * 70)
    print(f"{'周期':<8}{'样本':>8}{'命中率':>10}{'平均超额':>12}{'中位超额':>12}")
    baseline = {}
    for h in HORIZONS:
        vals = results[h]
        if not vals:
            print(f"T+{h:<6}{'—':>8}")
            continue
        hits = sum(1 for v in vals if v > 0)
        vals_sorted = sorted(vals)
        mid = vals_sorted[len(vals_sorted) // 2]
        mean = sum(vals) / len(vals)
        baseline[h] = {
            "n": len(vals),
            "hit": hits / len(vals),
            "mean": mean,
            "median": mid,
        }
        print(f"T+{h:<6}{len(vals):>8}{hits / len(vals) * 100:>9.2f}%"
              f"{mean * 100:>11.2f}%{mid * 100:>11.2f}%")

    print()
    print("=" * 70)
    print("与该大V对比")
    print("=" * 70)
    print(f"{'周期':<8}{'他':>10}{'随机基线':>12}{'差值':>10}{'结论':>16}")
    for h in HORIZONS:
        row = con.execute(
            """f"""
            SELECT COUNT(*) n, SUM(e.hit) hits, AVG(e.signed_excess) avg
            FROM opinion_eval e
            JOIN opinion o ON o.id = e.opinion_id
            JOIN author a ON a.id = o.author_id
            WHERE a.name = {AUTHOR} AND e.horizon_days = ?
              AND e.status = 'ok' AND o.polarity > 0
            """,
            (h,),
        ).fetchone()
        if not row["n"] or h not in baseline:
            continue
        his = row["hits"] / row["n"]
        base = baseline[h]["hit"]
        diff = his - base
        verdict = (
            "明显强于随机" if diff > 0.05 else
            "略强于随机" if diff > 0.015 else
            "略弱于随机" if diff > -0.015 else
            "明显弱于随机" if diff > -0.05 else
            "远弱于随机"
        )
        print(f"T+{h:<6}{his * 100:>9.2f}%{base * 100:>11.2f}%"
              f"{diff * 100:>+9.2f}%{verdict:>16}")
    print()
    print(f"（只统计他的看多观点，与对照组口径一致；跳过 {skipped} 个日期）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
