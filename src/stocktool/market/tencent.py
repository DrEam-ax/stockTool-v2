"""腾讯行情客户端（当前主力价格源）。

优点：前复权日线、个股/指数/ETF 都能取、稳定、不限流。
腾讯返回的行格式是 [日期, 开, 收, 高, 低, 量]，注意是「开收高低」，不是常见的 OHLC。
"""

from __future__ import annotations

import time
from typing import Any

import requests

from ..models import Bar
from .symbols import parse_symbol, to_secid

KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
QUOTE_URL = "https://qt.gtimg.cn/q="

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Referer": "https://gu.qq.com/",
}


class TencentError(RuntimeError):
    pass


class Tencent:
    # 实测上限：<=800 正常；1500/2000 会被静默截断到 641；>=4000 直接 param error
    MAX_BARS = 800

    def __init__(self, cfg):
        self.cfg = cfg
        self.sleep = float(cfg.values.get("request_sleep", 0.25))
        self.retries = int(cfg.values.get("request_retries", 3))
        self.timeout = int(cfg.values.get("request_timeout", 20))
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def _get_json(self, url: str, params: dict[str, Any]) -> Any:
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                resp.raise_for_status()
                return resp.json()
            except Exception as exc:  # noqa: BLE001
                last = exc
                if attempt < self.retries:
                    time.sleep(self.sleep * (2 ** attempt))
        raise TencentError(f"请求失败 {url}: {last}") from last

    # ---------- 日线 ----------
    def kline(self, symbol: str, count: int = 800, adjust: str = "qfq") -> list[Bar]:
        count = max(1, min(int(count), self.MAX_BARS))
        payload = self._get_json(
            KLINE_URL, {"param": f"{symbol},day,,,{count},{adjust}"}
        )
        data = (payload.get("data") or {}).get(symbol) or {}
        rows = data.get(f"{adjust}day") or data.get("day") or []
        bars: list[Bar] = []
        prev_close = 0.0
        for row in rows:
            if len(row) < 6:
                continue
            close = _f(row[2])
            pct = ((close / prev_close - 1) * 100) if prev_close > 0 else 0.0
            bars.append(
                Bar(
                    trade_date=str(row[0]),
                    open=_f(row[1]),
                    close=close,
                    high=_f(row[3]),
                    low=_f(row[4]),
                    volume=_f(row[5]),
                    amount=0.0,
                    pct_chg=pct,
                )
            )
            prev_close = close
        time.sleep(self.sleep)
        return bars

    # ---------- 名称（用于校验标的真实性）----------
    def names(self, symbols: list[str]) -> dict[str, tuple[str, str]]:
        """返回 {symbol: (交易所, 名称)}。"""
        out: dict[str, tuple[str, str]] = {}
        for i in range(0, len(symbols), 20):
            chunk = symbols[i:i + 20]
            try:
                resp = self.session.get(QUOTE_URL + ",".join(chunk),
                                        timeout=self.timeout)
                resp.encoding = "gbk"
                for line in resp.text.strip().split(";"):
                    line = line.strip()
                    if not line.startswith("v_"):
                        continue
                    head, _, body = line.partition("=")
                    sym = head[2:]
                    fields = body.strip().strip('"').split("~")
                    if len(fields) > 2:
                        out[sym] = (fields[0], fields[1])
            except Exception:  # noqa: BLE001
                continue
            time.sleep(self.sleep)
        return out


def _f(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def make_instrument(symbol: str, name: str, type_: str):
    from ..models import Instrument

    exchange, code = parse_symbol(symbol)
    return Instrument(secid=to_secid(exchange, code), code=code, name=name,
                      type=type_, market=1 if exchange == "SH" else 0,
                      exchange=exchange)
