"""板块 -> 可交易 ETF 的映射加载。"""

from __future__ import annotations

import json
from pathlib import Path

from ..models import Instrument
from .symbols import parse_symbol, to_secid


def load_sectors(path: Path) -> tuple[list[Instrument], list[tuple[str, str, float]]]:
    """返回 (ETF 标的列表, [(别名, secid, 权重)])。"""
    if not Path(path).exists():
        return [], []
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    instruments: list[Instrument] = []
    alias_rows: list[tuple[str, str, float]] = []

    for entry in raw.get("sectors", []):
        symbol = str(entry.get("symbol") or "").strip()
        name = str(entry.get("name") or "").strip()
        if not symbol or not name:
            continue
        exchange, code = parse_symbol(symbol)
        inst = Instrument(
            secid=to_secid(exchange, code), code=code, name=name, type="fund",
            market=1 if exchange == "SH" else 0, exchange=exchange,
        )
        instruments.append(inst)
        for alias in entry.get("aliases", []):
            alias = str(alias).strip()
            if len(alias) >= 2:
                alias_rows.append((alias, inst.secid, 1.0))
    return instruments, alias_rows
