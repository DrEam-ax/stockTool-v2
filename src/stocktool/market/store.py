"""标的与行情的落库/读取。"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Sequence

from ..models import Bar, Instrument
from ..textutil import normalize_name


def upsert_instruments(con: sqlite3.Connection, instruments: Iterable[Instrument],
                       now: str) -> int:
    # 名称在这里统一归一化，是唯一的入库入口，下游（解析器/别名）都依赖它
    rows = [
        (i.secid, i.code, normalize_name(i.name), i.type, i.market, i.exchange, now)
        for i in instruments
    ]
    con.executemany(
        """
        INSERT INTO instrument (secid, code, name, type, market, exchange, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (secid) DO UPDATE SET code = excluded.code,
                                          name = excluded.name,
                                          type = excluded.type,
                                          market = excluded.market,
                                          exchange = excluded.exchange,
                                          updated_at = excluded.updated_at
        """,
        rows,
    )
    return len(rows)


def upsert_aliases(con: sqlite3.Connection,
                   aliases: Sequence[tuple[str, str, float]],
                   origin: str = "manual") -> int:
    """aliases: [(别名, secid, weight)]；只保留 secid 已存在的。"""
    valid = {r["secid"] for r in con.execute("SELECT secid FROM instrument")}
    rows = [(normalize_name(a), s, w, origin) for a, s, w in aliases
            if s in valid and normalize_name(a)]
    if not rows:
        return 0
    con.executemany(
        """
        INSERT INTO alias (alias, secid, weight, origin) VALUES (?, ?, ?, ?)
        ON CONFLICT (alias, secid) DO UPDATE SET weight = excluded.weight
        """,
        rows,
    )
    return len(rows)


def load_instrument_index(con: sqlite3.Connection) -> tuple[
        dict[str, list[Instrument]], dict[str, list[tuple[Instrument, float]]]]:
    """返回 (名称->标的列表, 别名->[(标的, 权重)])。"""
    by_secid: dict[str, Instrument] = {}
    by_name: dict[str, list[Instrument]] = {}
    for row in con.execute(
        "SELECT secid, code, name, type, market, exchange FROM instrument"
    ):
        inst = Instrument(
            secid=row["secid"], code=row["code"], name=row["name"],
            type=row["type"], market=row["market"], exchange=row["exchange"],
        )
        by_secid[inst.secid] = inst
        by_name.setdefault(inst.name, []).append(inst)

    by_alias: dict[str, list[tuple[Instrument, float]]] = {}
    for row in con.execute("SELECT alias, secid, weight FROM alias"):
        inst = by_secid.get(row["secid"])
        if inst is None:
            continue
        by_alias.setdefault(row["alias"], []).append((inst, float(row["weight"])))
    return by_name, by_alias


def upsert_quotes(con: sqlite3.Connection, secid: str, bars: Iterable[Bar],
                  source: str = "eastmoney") -> int:
    rows = [
        (secid, b.trade_date, b.open, b.close, b.high, b.low,
         b.volume, b.amount, b.pct_chg, source)
        for b in bars
    ]
    if not rows:
        return 0
    con.executemany(
        """
        INSERT INTO quote_daily
          (secid, trade_date, open, close, high, low, volume, amount, pct_chg, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (secid, trade_date) DO UPDATE SET
          open = excluded.open, close = excluded.close,
          high = excluded.high, low = excluded.low,
          volume = excluded.volume, amount = excluded.amount,
          pct_chg = excluded.pct_chg, source = excluded.source
        """,
        rows,
    )
    return len(rows)


def get_bars(con: sqlite3.Connection, secid: str,
             start: str | None = None, end: str | None = None) -> list[Bar]:
    sql = ("SELECT trade_date, open, close, high, low, volume, amount, pct_chg "
           "FROM quote_daily WHERE secid = ?")
    params: list[str] = [secid]
    if start:
        sql += " AND trade_date >= ?"
        params.append(start)
    if end:
        sql += " AND trade_date <= ?"
        params.append(end)
    sql += " ORDER BY trade_date"
    return [
        Bar(
            trade_date=r["trade_date"], open=r["open"], close=r["close"],
            high=r["high"], low=r["low"], volume=r["volume"],
            amount=r["amount"], pct_chg=r["pct_chg"],
        )
        for r in con.execute(sql, params)
    ]


def trading_calendar(con: sqlite3.Connection, benchmark_secid: str) -> list[str]:
    """用基准指数的交易日作为日历，天然对齐真实开市日。"""
    return [
        r["trade_date"]
        for r in con.execute(
            "SELECT DISTINCT trade_date FROM quote_daily WHERE secid = ? "
            "ORDER BY trade_date",
            (benchmark_secid,),
        )
    ]


def quote_coverage(con: sqlite3.Connection, secid: str) -> tuple[str | None, str | None, int]:
    row = con.execute(
        "SELECT MIN(trade_date) AS a, MAX(trade_date) AS b, COUNT(*) AS n "
        "FROM quote_daily WHERE secid = ?",
        (secid,),
    ).fetchone()
    return row["a"], row["b"], int(row["n"] or 0)


def instrument_name(con: sqlite3.Connection, secid: str | None) -> str | None:
    if not secid:
        return None
    row = con.execute("SELECT name FROM instrument WHERE secid = ?", (secid,)).fetchone()
    return row["name"] if row else None


def secids_by_type(con: sqlite3.Connection, type_: str) -> list[str]:
    return [r["secid"] for r in
            con.execute("SELECT secid FROM instrument WHERE type = ?", (type_,))]
