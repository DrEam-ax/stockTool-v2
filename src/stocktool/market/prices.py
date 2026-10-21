"""价格服务：多源故障转移。

东财 push2 集群会对翻页密集的 IP 做边缘封禁（表现为服务端 0 字节直接断开），
所以价格抓取必须是多源的，不能单点依赖。
优先级默认：腾讯 -> 新浪 -> 东财。
"""

from __future__ import annotations

from ..models import Bar, Instrument
from .eastmoney import Eastmoney
from .sina import Sina
from .tencent import Tencent


def _iso(beg: str) -> str:
    beg = beg.strip()
    if len(beg) == 8 and beg.isdigit():
        return f"{beg[:4]}-{beg[4:6]}-{beg[6:]}"
    return beg


class PriceService:
    def __init__(self, cfg):
        self.cfg = cfg
        self.beg = str(cfg.values.get("quote_beg", "20190101"))
        self.days = int(cfg.values.get("quote_days", 4000))
        self.order = list(cfg.values.get("price_sources",
                                         ["tencent", "sina", "eastmoney"]))
        self._tencent = None
        self._sina = None
        self._eastmoney = None
        self.last_errors: list[str] = []

    # 懒加载，避免无谓地建 session
    @property
    def tencent(self) -> Tencent:
        if self._tencent is None:
            self._tencent = Tencent(self.cfg)
        return self._tencent

    @property
    def sina(self) -> Sina:
        if self._sina is None:
            self._sina = Sina(self.cfg)
        return self._sina

    @property
    def eastmoney(self) -> Eastmoney:
        if self._eastmoney is None:
            self._eastmoney = Eastmoney(self.cfg)
        return self._eastmoney

    def bars(self, inst: Instrument, beg: str | None = None) -> tuple[list[Bar], str]:
        """返回 (日线, 实际生效的数据源)。全部失败时返回 ([], 错误摘要)。"""
        beg = beg or self.beg
        self.last_errors = []
        for name in self.order:
            try:
                bars = self._fetch(name, inst, beg)
            except Exception as exc:  # noqa: BLE001
                self.last_errors.append(f"{name}:{type(exc).__name__}")
                continue
            if bars:
                return bars, name
            self.last_errors.append(f"{name}:empty")
        return [], ",".join(self.last_errors) or "no_source"

    def _fetch(self, name: str, inst: Instrument, beg: str) -> list[Bar]:
        if name == "tencent":
            symbol = inst.symbol
            if not symbol:
                raise ValueError("标的没有可用的 symbol")
            bars = self.tencent.kline(symbol, count=self.days)
            return [b for b in bars if b.trade_date >= _iso(beg)]
        if name == "sina":
            symbol = inst.symbol
            if not symbol:
                raise ValueError("标的没有可用的 symbol")
            bars = self.sina.kline(symbol, datalen=min(self.days, 1023))
            return [b for b in bars if b.trade_date >= _iso(beg)]
        if name == "eastmoney":
            return self.eastmoney.kline(inst.secid, beg)
        raise ValueError(f"未知数据源: {name}")
