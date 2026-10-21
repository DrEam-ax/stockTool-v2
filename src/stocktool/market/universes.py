"""内置标的池：指数。"""

from __future__ import annotations

from ..models import Instrument
from .symbols import parse_symbol, to_secid

# (symbol, 名称)  —— secid 由 symbol 推导，保证与基准配置一致
INDEX_SYMBOLS: list[tuple[str, str]] = [
    ("sh000300", "沪深300"),
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000905", "中证500"),
    ("sh000852", "中证1000"),
    ("sh000688", "科创50"),
    ("sz399905", "中证500(深)"),
]


def default_indices() -> list[Instrument]:
    out: list[Instrument] = []
    for symbol, name in INDEX_SYMBOLS:
        exchange, code = parse_symbol(symbol)
        out.append(Instrument(
            secid=to_secid(exchange, code), code=code, name=name, type="index",
            market=1 if exchange == "SH" else 0, exchange=exchange,
        ))
    return out
