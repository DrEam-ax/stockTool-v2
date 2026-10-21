"""验证他自称的盈利来源：这些标的在他看多之后，真实走势如何？

这是检验「我的指标是否量错了周期」的决定性实验。
如果他在 2025-05 看多锑矿、2025-06 看多商业航天，
而这些标的在随后 6~12 个月大涨、只是前 20/60 天跑输，
那就是我的 T+20 口径错了，不是他的判断错了。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402
from stocktool.market.store import get_bars, trading_calendar  # noqa: E402

HORIZONS = (5, 20, 60, 120, 250)


def main() -> int:
    cfg = load_config()
    con = connect(cfg)
    bench = str(cfg.values["benchmark_secid"])
    calendar = trading_calendar(con, bench)
    bench_map = {b.trade_date: b for b in get_bars(con, bench)}

    # 他自称的盈利来源 -> 对应标的 -> 他实际看多的日期
    cases = [
        ("锑矿 / 华钰矿业", "0.601020", "2025-05-16"),
        ("锑矿 / 有色金属ETF", "1.512400", "2025-05-16"),
        ("商业航天 / 航天动力", "1.600343", "2025-06-12"),
        ("商业航天(蹭军工) / 军工ETF", "1.512660", "2025-06-12"),
        # 对照组：他判断最差的
        ("他自称最拉胯 / 华大智造", "1.688114", "2025-01-01"),
        ("他看错 / 比亚迪", "0.002594", "2025-09-09"),
    ]

    print("=" * 100)
    print("他自称的盈利来源，真实价格走势（超额 = 相对沪深300）")
    print("=" * 100)
    hdr = f"{'标的':<26}{'起点':<12}{'T+5':>9}{'T+20':>9}{'T+60':>9}{'T+120':>9}{'T+250':>9}{'至今':>9}"
    print(hdr)
    print("-" * 100)

    for label, secid, start in cases:
        bars = get_bars(con, secid)
        if not bars:
            print(f"{label:<26} 无行情数据")
            continue
        bar_map = {b.trade_date: b for b in bars}
        # 从他看多的那天之后第一个交易日入场（与回测口径一致，避免前视）
        idx = None
        for i, d in enumerate(calendar):
            if d > start:
                idx = i
                break
        if idx is None:
            print(f"{label:<26} 日期超出日历范围")
            continue
        entry_date = calendar[idx]
        e = bar_map.get(entry_date)
        b_entry = bench_map.get(entry_date)
        if e is None or b_entry is None:
            print(f"{label:<26} 缺 {entry_date} 数据")
            continue

        cells = []
        for h in HORIZONS:
            j = idx + h
            if j >= len(calendar):
                cells.append("—")
                continue
            x = bar_map.get(calendar[j])
            bx = bench_map.get(calendar[j])
            if x is None or bx is None:
                cells.append("—")
                continue
            raw = x.close / e.close - 1
            bex = bx.close / b_entry.close - 1
            cells.append(f"{(raw - bex) * 100:+.1f}%")

        # 至今（用最后一根）
        last = bars[-1]
        last_bench = bench_map.get(last.trade_date)
        till = ("—" if last_bench is None
                else f"{(last.close / e.close - last_bench.close / b_entry.close) * 100:+.1f}%")

        print(f"{label:<26}{entry_date:<12}" +
              "".join(f"{c:>9}" for c in cells) + f"{till:>9}")

    print()
    print("=" * 100)
    print("同期的绝对涨幅（不扣基准）")
    print("=" * 100)
    for label, secid, start in cases:
        bars = get_bars(con, secid)
        if not bars:
            continue
        bar_map = {b.trade_date: b for b in bars}
        idx = None
        for i, d in enumerate(calendar):
            if d > start:
                idx = i
                break
        if idx is None:
            continue
        entry_date = calendar[idx]
        e = bar_map.get(entry_date)
        if e is None:
            continue
        cells = []
        for h in HORIZONS:
            j = idx + h
            x = bar_map.get(calendar[j]) if j < len(calendar) else None
            cells.append("—" if x is None else f"{(x.close / e.close - 1) * 100:+.1f}%")
        last = bars[-1]
        till = f"{(last.close / e.close - 1) * 100:+.1f}%"
        print(f"{label:<26}{entry_date:<12}" +
              "".join(f"{c:>9}" for c in cells) + f"{till:>9}")

    print()
    print(f"（'至今' = 该标的最后一根K线 {get_bars(con, '0.601020')[-1].trade_date if get_bars(con,'0.601020') else '?'}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
