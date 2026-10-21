"""回测：把每条观点放到行情上打分。

严谨性约定（这些细节决定数字可不可信）：
  1. 入场用「观点发布日之后的第一个交易日收盘」，绝不使用当日盘中价，
     从根上避免前视偏差（lookahead bias）。
  2. 个股停牌时顺延到复牌后第一个交易日；基准取相同日期，保证区间对齐。
  3. 超额收益 = 标的收益 - 基准收益，再看多/看空分别取符号。
     hit 定义为「方向调整后的超额收益 > 0」。
"""

from __future__ import annotations

import sqlite3

from ..market import store
from ..models import Bar
from ..textutil import now_iso


def _entry_index(calendar: list[str], stated_date: str, stated_at: str,
                 cfg) -> int | None:
    rule = str(cfg.values.get("entry_rule", "next_close"))
    close_hour = int(cfg.values.get("close_hour", 15))

    if rule == "same_day_if_before_close" and stated_date in calendar:
        try:
            hour = int(stated_at[11:13])
        except (ValueError, IndexError):
            hour = 23
        if hour < close_hour:
            return calendar.index(stated_date)

    for i, day in enumerate(calendar):
        if day > stated_date:
            return i
    return None


def _bar_at_or_after(bars: list[Bar], date: str) -> Bar | None:
    for bar in bars:
        if bar.trade_date >= date:
            return bar
    return None


def _max_adverse(bars: list[Bar], entry_close: float, polarity: int) -> float | None:
    if not bars or entry_close <= 0:
        return None
    if polarity > 0:
        worst = min(b.low for b in bars) / entry_close - 1
    else:
        worst = 1 - max(b.high for b in bars) / entry_close
    return min(0.0, worst)


def evaluate_all(con: sqlite3.Connection, cfg, *,
                 benchmark_secid: str | None = None,
                 horizons: list[int] | None = None) -> dict:
    benchmark_secid = benchmark_secid or str(cfg.values["benchmark_secid"])
    horizons = horizons or list(cfg.values["horizons"])

    calendar = store.trading_calendar(con, benchmark_secid)
    if not calendar:
        raise SystemExit(
            f"基准 {benchmark_secid} 没有行情数据。先执行 fetch-quotes。"
        )
    bench_bars = store.get_bars(con, benchmark_secid)
    bench_map = {b.trade_date: b for b in bench_bars}

    rows = con.execute(
        """
        SELECT o.id, o.stated_date, o.stated_at, o.polarity, o.subject_secid
        FROM opinion o
        WHERE o.resolved = 1 AND o.subject_secid IS NOT NULL
          AND o.is_dup = 0
        ORDER BY o.stated_date, o.id
        """
    ).fetchall()

    now = now_iso()
    stats = {"opinions": len(rows), "ok": 0, "pending": 0, "no_data": 0,
             "self_benchmark": 0, "rows": 0}
    bar_cache: dict[str, list[Bar]] = {benchmark_secid: bench_bars}

    for row in rows:
        secid = row["subject_secid"]
        if not secid:
            stats["no_data"] += 1
            continue

        # 「大盘」类观点会被解析成基准指数本身。拿基准当自己的基准，
        # 超额收益恒为 0，hit 恒为 0 —— 这批样本会**被系统性地记成全错**，
        # 把整体命中率往下拽。必须单独处理，不能混进绩效榜。
        # （实测：907 个样本里有 71 个是这种情况，足以改变「显著差于随机」
        #   和「与随机无异」的结论。）
        if secid == benchmark_secid:
            _write_eval(con, row["id"], horizons, benchmark_secid, None, None,
                        "self_benchmark", now)
            stats["self_benchmark"] += 1
            continue
        if secid not in bar_cache:
            bar_cache[secid] = store.get_bars(con, secid)
        bars = bar_cache[secid]
        if not bars:
            _write_eval(con, row["id"], horizons, benchmark_secid, None, None,
                        "no_data", now)
            stats["no_data"] += 1
            continue

        idx = _entry_index(calendar, row["stated_date"], row["stated_at"], cfg)
        if idx is None:
            _write_eval(con, row["id"], horizons, benchmark_secid, None, None,
                        "pending", now)
            stats["pending"] += 1
            continue

        entry_bar = _bar_at_or_after(bars, calendar[idx])
        if entry_bar is None:
            _write_eval(con, row["id"], horizons, benchmark_secid, None, None,
                        "no_data", now)
            stats["no_data"] += 1
            continue

        any_ok = False
        any_pending = False
        for horizon in horizons:
            exit_idx = idx + horizon
            if exit_idx >= len(calendar):
                _write_eval(con, row["id"], [horizon], benchmark_secid,
                            entry_bar, None, "pending", now)
                any_pending = True
                continue
            exit_target = calendar[exit_idx]
            exit_bar = _bar_at_or_after(bars, exit_target)
            bench_entry = bench_map.get(entry_bar.trade_date)
            bench_exit = bench_map.get(exit_bar.trade_date) if exit_bar else None
            if exit_bar is None or bench_entry is None or bench_exit is None:
                _write_eval(con, row["id"], [horizon], benchmark_secid,
                            entry_bar, None, "no_data", now)
                stats["no_data"] += 1
                continue

            window = [b for b in bars
                      if entry_bar.trade_date <= b.trade_date <= exit_bar.trade_date]
            _write_eval(
                con, row["id"], [horizon], benchmark_secid, entry_bar, exit_bar,
                "ok", now,
                bench_entry=bench_entry.close, bench_exit=bench_exit.close,
                polarity=row["polarity"], window=window,
            )
            any_ok = True
            stats["rows"] += 1

        if any_ok:
            stats["ok"] += 1
        elif any_pending:
            stats["pending"] += 1

    con.commit()
    return stats


def _write_eval(con: sqlite3.Connection, opinion_id: int, horizons: list[int],
                benchmark_secid: str, entry_bar: Bar | None, exit_bar: Bar | None,
                status: str, now: str, *, bench_entry: float | None = None,
                bench_exit: float | None = None, polarity: int = 1,
                window: list[Bar] | None = None) -> None:
    for horizon in horizons:
        raw = bench = excess = signed = None
        hit = None
        adverse = None
        if status == "ok" and entry_bar and exit_bar and bench_entry and bench_exit:
            if entry_bar.close > 0 and bench_entry > 0:
                raw = exit_bar.close / entry_bar.close - 1
                bench = bench_exit / bench_entry - 1
                excess = raw - bench
                signed = excess * (1 if polarity > 0 else -1)
                hit = 1 if signed > 0 else 0
                adverse = _max_adverse(window or [], entry_bar.close, polarity)

        con.execute(
            """
            INSERT INTO opinion_eval
              (opinion_id, horizon_days, benchmark_secid, entry_date, entry_close,
               exit_date, exit_close, bench_entry, bench_exit, raw_return,
               bench_return, excess_return, signed_excess, hit, max_adverse,
               status, evaluated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (opinion_id, horizon_days, benchmark_secid) DO UPDATE SET
               entry_date = excluded.entry_date, entry_close = excluded.entry_close,
               exit_date = excluded.exit_date, exit_close = excluded.exit_close,
               bench_entry = excluded.bench_entry, bench_exit = excluded.bench_exit,
               raw_return = excluded.raw_return, bench_return = excluded.bench_return,
               excess_return = excluded.excess_return,
               signed_excess = excluded.signed_excess, hit = excluded.hit,
               max_adverse = excluded.max_adverse, status = excluded.status,
               evaluated_at = excluded.evaluated_at
            """,
            (
                opinion_id, horizon, benchmark_secid,
                entry_bar.trade_date if entry_bar else None,
                entry_bar.close if entry_bar else None,
                exit_bar.trade_date if exit_bar else None,
                exit_bar.close if exit_bar else None,
                bench_entry, bench_exit, raw, bench, excess, signed, hit,
                adverse, status, now,
            ),
        )


def needed_secids(con: sqlite3.Connection, cfg, *,
                  benchmark_secid: str | None = None,
                  min_history_days: int = 0) -> list[str]:
    """回测所需的全部 secid（观点标的 + 基准 + 指数池）。"""
    benchmark_secid = benchmark_secid or str(cfg.values["benchmark_secid"])
    out: set[str] = {benchmark_secid}
    for row in con.execute(
        "SELECT DISTINCT subject_secid FROM opinion "
        "WHERE resolved = 1 AND subject_secid IS NOT NULL AND is_dup = 0"
    ):
        out.add(row["subject_secid"])
    # 大盘观点会落到指数上，一并取
    for row in con.execute("SELECT secid FROM instrument WHERE type = 'index'"):
        if row["secid"]:
            out.add(row["secid"])
    return sorted(out)
