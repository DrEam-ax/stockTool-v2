"""交易代码在各数据源之间的转换。

内部规范：secid（东财风格 "1.600519" / "0.000001"）作为主键。
对外调用：symbol（"sh600519" / "sz000001" / "bj920000"）给腾讯和新浪用。
北交所必须靠 exchange 区分，因为东财把 SZ 和 BJ 都标成 market=0。
"""

from __future__ import annotations

EXCHANGE_MARKET = {"SH": 1, "SZ": 0, "BJ": 0}
MARKET_EXCHANGE = {1: "SH", 0: "SZ"}


def parse_symbol(symbol: str) -> tuple[str, str]:
    """'sh600519' -> ('SH', '600519')"""
    s = symbol.strip().lower()
    return s[:2].upper(), s[2:]


def to_symbol(exchange: str, code: str) -> str:
    return f"{exchange.lower()}{code}"


def to_secid(exchange: str, code: str) -> str:
    market = EXCHANGE_MARKET.get(exchange.upper())
    if market is None:
        raise ValueError(f"未知交易所: {exchange}")
    return f"{market}.{code}"


def secid_of(exchange: str, code: str) -> str:
    return to_secid(exchange, code)


def symbol_of(secid: str, exchange: str | None = None) -> str | None:
    """secid -> symbol。板块类（90.*）没有 symbol。"""
    market, _, code = secid.partition(".")
    if market == "90":
        return None
    if exchange:
        return to_symbol(exchange, code)
    ex = MARKET_EXCHANGE.get(int(market)) if market.isdigit() else None
    return to_symbol(ex, code) if ex else None


def infer_exchange(market: int, code: str) -> str | None:
    """从东财的 market + 代码推断交易所。

    东财把深市和北交所都标成 market=0，只能靠代码段区分：
    北交所是 4xxxxx / 8xxxxx / 920xxx，深市是 000/001/002/003/300/301/302。
    """
    if market == 90:
        return None
    if market == 1:
        return "SH"
    if code.startswith("920") or code[:1] in ("4", "8"):
        return "BJ"
    return "SZ"
