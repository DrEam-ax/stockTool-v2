"""随机选股基线：给"命中率"一个正确的对照。

为什么这不是可选功能：
  A 股里中位数个股本来就跑输市值加权的沪深300。
  实测随机选股 + 一律看多、在同一批日期上，
  T+5/T+20/T+60 的命中率只有 **44%/45%/43%**，不是 50%。
  拿 50% 当原假设做符号检验，会把几乎所有大V判成"显著差于随机"——
  这个结论是假的，是基准选错了。

  所以判定必须对着**实测基线**，而不是对着 50%。
"""

from __future__ import annotations

import random
import sqlite3
from statistics import mean

from ..market import PriceService
from ..market.store import (
    get_bars, quote_coverage, trading_calendar, upsert_quotes,
)
from ..models import Instrument
from ..textutil import now_iso

DEFAULT_SEED = 20261008


def load_baseline(con: sqlite3.Connection,
                  benchmark_secid: str) -> dict[int, dict]:
    rows = con.execute(
        "SELECT horizon_days, n, hit_rate, mean_excess, sample_stocks, computed_at "
        "FROM baseline WHERE benchmark_secid = ?",
        (benchmark_secid,),
    ).fetchall()
    return {
        int(r["horizon_days"]): {
            "n": r["n"], "hit_rate": r["hit_rate"],
            "mean_excess": r["mean_excess"], "sample_stocks": r["sample_stocks"],
            "computed_at": r["computed_at"],
        }
        for r in rows
    }


def dates_from_opinions(con: sqlite3.Connection, author: str | None = None) -> list[str]:
    sql = ("SELECT DISTINCT o.stated_date FROM opinion o "
           "JOIN author a ON a.id = o.author_id "
           "WHERE o.stated_date IS NOT NULL")
    params: list[str] = []
    if author:
        sql += " AND a.name = ?"
        params.append(author)
    sql += " ORDER BY o.stated_date"
    return [r["stated_date"] for r in con.execute(sql, params)]


def compute_baseline(con: sqlite3.Connection, cfg, *,
                     horizons: list[int] | None = None,
                     benchmark_secid: str | None = None,
                     author: str | None = None,
                     sample_stocks: int = 180,
                     picks_per_date: int = 3,
                     seed: int = DEFAULT_SEED,
                     fetch_missing: bool = True,
                     progress=None) -> dict:
    """抽样计算基线并落库。"""
    horizons = list(horizons or cfg.values["horizons"])
    benchmark_secid = benchmark_secid or str(cfg.values["benchmark_secid"])
    rng = random.Random(seed)

    calendar = trading_calendar(con, benchmark_secid)
    if not calendar:
        raise SystemExit("基准没有行情，先跑 fetch-quotes")
    bench_map = {b.trade_date: b for b in get_bars(con, benchmark_secid)}

    dates = dates_from_opinions(con, author)
    if not dates:
        raise SystemExit("没有观点日期，先跑 extract")

    stocks = list(con.execute(
        "SELECT secid, code, name, type, market, exchange FROM instrument "
        "WHERE type = 'stock'"
    ))
    if len(stocks) < 10:
        raise SystemExit("个股数量太少，先跑 fetch-universe")
    rng.shuffle(stocks)
    picked = [
        Instrument(r["secid"], r["code"], r["name"], r["type"],
                   r["market"], r["exchange"])
        for r in stocks[:sample_stocks]
    ]

    if fetch_missing:
        svc = PriceService(cfg)
        for i, inst in enumerate(picked, 1):
            _, _, n = quote_coverage(con, inst.secid)
            if n > 0:
                continue
            bars, source = svc.bars(inst)
            if bars:
                upsert_quotes(con, inst.secid, bars, source=source)
            if i % 40 == 0:
                con.commit()
                if progress:
                    progress(f"  … 拉行情 {i}/{len(picked)}")
        con.commit()

    idx_of = {d: i for i, d in enumerate(calendar)}
    vals: dict[int, list[float]] = {h: [] for h in horizons}

    for date in dates:
        i0 = None
        for i, d in enumerate(calendar):
            if d > date:
                i0 = i
                break
        if i0 is None:
            continue
        entry_date = calendar[i0]
        b_entry = bench_map.get(entry_date)
        if b_entry is None:
            continue
        for inst in rng.sample(picked, min(picks_per_date, len(picked))):
            bars = get_bars(con, inst.secid)
            if not bars:
                continue
            bar_map = {b.trade_date: b for b in bars}
            e = bar_map.get(entry_date)
            if e is None or e.close <= 0:
                continue
            for h in horizons:
                ie = i0 + h
                if ie >= len(calendar):
                    continue
                x = bar_map.get(calendar[ie])
                bx = bench_map.get(calendar[ie])
                if x is None or bx is None or x.close <= 0:
                    continue
                vals[h].append(x.close / e.close - 1 - (bx.close / b_entry.close - 1))

    now = now_iso()
    result: dict[int, dict] = {}
    for h in horizons:
        v = vals[h]
        if not v:
            continue
        hits = sum(1 for x in v if x > 0)
        row = {
            "n": len(v), "hit_rate": hits / len(v), "mean_excess": mean(v),
            "sample_stocks": len(picked),
        }
        con.execute(
            """
            INSERT INTO baseline
              (benchmark_secid, horizon_days, scope_start, scope_end, n,
               hit_rate, mean_excess, sample_stocks, seed, computed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (benchmark_secid, horizon_days) DO UPDATE SET
               scope_start = excluded.scope_start, scope_end = excluded.scope_end,
               n = excluded.n, hit_rate = excluded.hit_rate,
               mean_excess = excluded.mean_excess,
               sample_stocks = excluded.sample_stocks, seed = excluded.seed,
               computed_at = excluded.computed_at
            """,
            (benchmark_secid, h, dates[0], dates[-1], row["n"],
             row["hit_rate"], row["mean_excess"], row["sample_stocks"],
             seed, now),
        )
        result[h] = row
    con.commit()
    return {"benchmark_secid": benchmark_secid, "dates": len(dates),
            "sample_stocks": len(picked), "horizons": result}
