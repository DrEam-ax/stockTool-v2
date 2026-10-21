"""新浪行情客户端。

两个用途：
  1. 标的清单（东财 push2 被限流时的替代来源）—— 每页最多 100 条
  2. 日线兜底（datalen 上限约 1023 根）
"""

from __future__ import annotations

import json
import time
from typing import Any

import requests

from ..models import Bar, Instrument
from .symbols import parse_symbol, to_secid

LIST_URL = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/"
            "json_v2.php/Market_Center.getHQNodeData")
KLINE_URL = ("https://quotes.sina.cn/cn/api/json_v2.php/"
             "CN_MarketDataService.getKLineData")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Referer": "https://finance.sina.com.cn/",
}


class SinaError(RuntimeError):
    pass


class Sina:
    def __init__(self, cfg):
        self.cfg = cfg
        self.sleep = float(cfg.values.get("request_sleep", 0.25))
        self.retries = int(cfg.values.get("request_retries", 3))
        self.timeout = int(cfg.values.get("request_timeout", 20))
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def _get(self, url: str, params: dict[str, Any]) -> Any:
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
        raise SinaError(f"请求失败 {url}: {last}") from last

    # ---------- 标的清单 ----------
    def stocks(self, node: str = "hs_a", page_size: int = 100,
               max_pages: int = 200, progress: bool = True) -> list[Instrument]:
        out: list[Instrument] = []
        seen: set[str] = set()
        page = 1
        while page <= max_pages:
            payload = self._get(LIST_URL, {
                "page": page, "num": page_size, "sort": "symbol", "asc": 1,
                "node": node, "symbol": "", "_s_r_a": "page",
            })
            if not payload:
                break
            fresh = 0
            for row in payload:
                sym = str(row.get("symbol") or "")
                name = str(row.get("name") or "").strip()
                if not sym or not name or sym in seen:
                    continue
                seen.add(sym)
                exchange, code = parse_symbol(sym)
                out.append(Instrument(
                    secid=to_secid(exchange, code), code=code, name=name,
                    type="stock", market=1 if exchange == "SH" else 0,
                    exchange=exchange,
                ))
                fresh += 1
            if fresh == 0:
                break
            if progress and page % 10 == 0:
                print(f"    … 第 {page} 页，累计 {len(out)} 个")
            page += 1
            time.sleep(self.sleep)
        return out

    # ---------- 日线兜底 ----------
    def kline(self, symbol: str, datalen: int = 1023) -> list[Bar]:
        payload = self._get(KLINE_URL, {
            "symbol": symbol, "scale": 240, "ma": "no", "datalen": datalen,
        })
        if not isinstance(payload, list):
            return []
        bars: list[Bar] = []
        prev_close = 0.0
        for row in payload:
            close = _f(row.get("close"))
            pct = ((close / prev_close - 1) * 100) if prev_close > 0 else 0.0
            bars.append(Bar(
                trade_date=str(row.get("day")),
                open=_f(row.get("open")),
                close=close,
                high=_f(row.get("high")),
                low=_f(row.get("low")),
                volume=_f(row.get("volume")),
                amount=0.0,
                pct_chg=pct,
            ))
            prev_close = close
        time.sleep(self.sleep)
        return bars


def _f(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
