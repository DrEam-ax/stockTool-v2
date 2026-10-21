"""领域模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# 标的类型优先级：同长度匹配冲突时，越靠前越优先
SUBJECT_PRIORITY = ("industry", "concept", "stock", "index")


@dataclass(frozen=True)
class Instrument:
    secid: str
    code: str
    name: str
    type: str
    market: int
    exchange: str | None = None      # SH / SZ / BJ；板块类为 None

    @property
    def symbol(self) -> str | None:
        from .market.symbols import symbol_of
        return symbol_of(self.secid, self.exchange)


@dataclass
class RawDoc:
    """采集层的统一输出。所有来源（社交平台 / 音视频 / 人工粘贴）都归一到这个结构。"""

    source: str
    author_uid: str
    author_name: str
    published_at: str          # ISO8601 本地时间
    text: str
    external_id: str
    kind: str = "post"
    title: str | None = None
    permalink: str | None = None
    media_refs: list[str] = field(default_factory=list)
    raw_meta: dict[str, Any] = field(default_factory=dict)
    author_note: str | None = None


@dataclass
class SubjectMatch:
    raw: str
    secid: str | None
    type: str
    start: int
    end: int
    confidence: float
    # True 表示这是"合成"标的（大盘回落、主语继承），没有真实文本位置，
    # 因此不受「方向词与标的必须相邻」的距离限制
    placeholder: bool = False


@dataclass
class Opinion:
    sentence: str
    char_start: int
    char_end: int
    subject_raw: str | None
    subject_secid: str | None
    subject_type: str
    resolved: bool
    match_conf: float | None
    polarity: int
    strength: int
    horizon: str
    thesis: str
    triggers: list[str]
    evidence: str
    extractor: str
    confidence: float


@dataclass(frozen=True)
class Bar:
    trade_date: str
    open: float
    close: float
    high: float
    low: float
    volume: float
    amount: float
    pct_chg: float
