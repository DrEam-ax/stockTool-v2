"""东财行情客户端。

刻意不依赖 akshare：
  - akshare 依赖树庞大，在 Python 3.13 / pandas 3.x 上容易炸
  - 我们只需要「日线 + 标的清单」两件事，直连接口更可控、更快
所有请求都做了限速与重试。
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterable

import requests

from ..models import Bar, Instrument
from .symbols import infer_exchange

KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"

# f51 日期, f52 开, f53 收, f54 高, f55 低, f56 量, f57 额, f58 涨跌幅
KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58"

# 全 A 股（沪主板 / 科创板 / 深主板 / 创业板 / 北交所）
FS_A_SHARES = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
FS_INDUSTRY = "m:90+t:2"
FS_CONCEPT = "m:90+t:3"

# 常用基准指数
DEFAULT_INDICES: list[tuple[str, str, str]] = [
    ("000300", "沪深300", "1.000300"),
    ("000001", "上证指数", "1.000001"),
    ("399001", "深证成指", "0.399001"),
    ("399006", "创业板指", "0.399006"),
    ("000905", "中证500", "1.000905"),
    ("000852", "中证1000", "1.000852"),
    ("000688", "科创50", "1.000688"),
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
}


class EastmoneyError(RuntimeError):
    pass


class Eastmoney:
    def __init__(self, cfg):
        self.cfg = cfg
        self.sleep = float(cfg.values.get("request_sleep", 0.25))
        self.retries = int(cfg.values.get("request_retries", 3))
        self.timeout = int(cfg.values.get("request_timeout", 20))
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    # ---------- 底层 ----------
    def _get(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                resp.raise_for_status()
                payload = resp.json()
                if payload is None:
                    raise EastmoneyError("响应为空")
                return payload
            except Exception as exc:  # noqa: BLE001
                last = exc
                if attempt < self.retries:
                    time.sleep(self.sleep * (2 ** attempt))
        raise EastmoneyError(f"请求失败 {url} params={params}: {last}") from last
        # pragma: no cover

    # ---------- 日线 ----------
    def kline(self, secid: str, beg: str, end: str = "20500101",
              klt: int = 101, fqt: int = 1) -> list[Bar]:
        """klt=101 日线, fqt=1 前复权。"""
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": KLINE_FIELDS2,
            "klt": klt,
            "fqt": fqt,
            "beg": beg,
            "end": end,
        }
        payload = self._get(KLINE_URL, params)
        data = payload.get("data")
        if not data or not data.get("klines"):
            return []
        out: list[Bar] = []
        for row in data["klines"]:
            parts = row.split(",")
            if len(parts) < 8:
                continue
            out.append(
                Bar(
                    trade_date=parts[0],
                    open=_f(parts[1]),
                    close=_f(parts[2]),
                    high=_f(parts[3]),
                    low=_f(parts[4]),
                    volume=_f(parts[5]),
                    amount=_f(parts[6]),
                    pct_chg=_f(parts[7]),
                )
            )
        time.sleep(self.sleep)
        return out

    # ---------- 标的清单 ----------
    def clist_all(self, fs: str, fields: str = "f12,f13,f14",
                  pz: int = 100, max_pages: int = 400) -> list[dict[str, Any]]:
        """翻页拉全量。

        注意：东财会把 pz 截断到 100，所以不能用 len(diff) < pz 判断结束，
        必须靠 total 和「本页没有新增」两个条件收尾。
        """
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        page = 1
        total: int | None = None
        while page <= max_pages:
            params = {
                "pn": page,
                "pz": pz,
                "po": 0,
                "np": 1,
                "fltt": 2,
                "invt": 2,
                "fid": "f12",
                "fs": fs,
                "fields": fields,
                "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            }
            payload = self._get(CLIST_URL, params)
            data = payload.get("data")
            if not data or not data.get("diff"):
                break
            diff = data["diff"]
            if isinstance(diff, dict):      # 少数情况下返回 dict
                diff = list(diff.values())
            if not diff:
                break

            fresh = 0
            for r in diff:
                sid = f"{r.get('f13')}.{r.get('f12')}"
                if sid in seen:
                    continue
                seen.add(sid)
                out.append(r)
                fresh += 1

            if total is None:
                total = int(data.get("total") or 0)
            if fresh == 0:                  # 接口开始重复返回同一页
                break
            if total and len(out) >= total:
                break
            page += 1
            time.sleep(self.sleep)
        return out

    def stocks(self) -> list[Instrument]:
        rows = self.clist_all(FS_A_SHARES)
        out: list[Instrument] = []
        for r in rows:
            if not r.get("f12") or not r.get("f14"):
                continue
            code = str(r["f12"])
            market = int(r["f13"])
            out.append(Instrument(
                secid=f"{market}.{code}",
                code=code,
                name=str(r["f14"]).strip(),
                type="stock",
                market=market,
                exchange=infer_exchange(market, code),
            ))
        return out

    def boards(self, board_type: str) -> list[Instrument]:
        fs = FS_INDUSTRY if board_type == "industry" else FS_CONCEPT
        rows = self.clist_all(fs)
        return [
            Instrument(
                secid=f"90.{r['f12']}",
                code=str(r["f12"]),
                name=str(r["f14"]).strip(),
                type=board_type,
                market=90,
                exchange=None,
            )
            for r in rows
            if r.get("f12") and r.get("f14")
        ]

    @staticmethod
    def indices() -> list[Instrument]:
        out: list[Instrument] = []
        for code, name, secid in DEFAULT_INDICES:
            market = int(secid.split(".")[0])
            out.append(Instrument(
                secid=secid, code=code, name=name, type="index", market=market,
                exchange=infer_exchange(market, code),
            ))
        return out

    def universe(self) -> list[Instrument]:
        out: list[Instrument] = []
        for label, fn in (
            ("个股", self.stocks),
            ("行业板块", lambda: self.boards("industry")),
            ("概念板块", lambda: self.boards("concept")),
        ):
            try:
                items = fn()
            except EastmoneyError as exc:
                print(f"  ! {label} 拉取失败：{exc}")
                continue
            print(f"  · {label}: {len(items)}")
            out.extend(items)
        out.extend(self.indices())
        # 以 secid 去重（6 位代码会跨市场撞车，不能用它去重）
        seen: set[str] = set()
        uniq: list[Instrument] = []
        for inst in out:
            if inst.secid in seen:
                continue
            seen.add(inst.secid)
            uniq.append(inst)
        return uniq


def _f(value: Any) -> float:
    try:
        if value in ("-", "", None):
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def fetch_quotes_for(cfg, secids: Iterable[str], beg: str | None = None) -> dict[str, list[Bar]]:
    client = Eastmoney(cfg)
    beg = beg or str(cfg.values.get("quote_beg", "20190101"))
    result: dict[str, list[Bar]] = {}
    for secid in secids:
        try:
            result[secid] = client.kline(secid, beg)
        except EastmoneyError as exc:
            print(f"  ! {secid} 行情失败：{exc}")
            result[secid] = []
    return result


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)
