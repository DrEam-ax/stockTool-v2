"""文本与时间工具。"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import date, datetime

# 段内句边界：只认强标点。
# 刻意不把单个换行当边界 —— 有的作者"一句一行"且整篇不写句号，
# 按换行切会把一篇完整论断切成十几个碎片，上下文全丢。
_SENT_BOUNDARY = re.compile(r"[。！？!?；;]+")
# 段落边界：空行
_PARA_BOUNDARY = re.compile(r"\n[ \t\u3000]*\n+")
_WS = re.compile(r"[ \t\u3000]+")


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today_str() -> str:
    return date.today().isoformat()


def parse_dt(value: str) -> datetime:
    """宽松解析常见时间字符串。"""
    value = value.strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%Y%m%d",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError(f"无法解析时间: {value!r}")


def content_hash(text: str) -> str:
    norm = normalize_text(text)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:32]


def normalize_text(text: str) -> str:
    """归一化，用于去重比较（不影响原文存档）。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _WS.sub(" ", text)
    return "\n".join(line.strip() for line in text.split("\n")).strip()


def normalize_name(name: str) -> str:
    """规范化标的名称，用于名称匹配。

    新浪返回的名字带空格和全角字母（"五 粮 液"、"万 科Ａ"），
    不处理的话这批股票的名称匹配会全部失效，只能靠 cashtag 命中。
    """
    s = str(name).replace(" ", "").replace("\u3000", "")
    s = unicodedata.normalize("NFKC", s)
    return s.strip()


def split_sentences(text: str) -> list[tuple[str, int, int]]:
    """切句，返回 [(片段, start, end)]，偏移相对原文。

    先按空行切段，段内再按强标点切句。单个换行**不切**。
    句内的多标的/多观点交给 rule_extractor 用「就近归属」处理。
    """
    out: list[tuple[str, int, int]] = []

    def emit(seg: str, base: int) -> None:
        pos = 0
        for m in _SENT_BOUNDARY.finditer(seg):
            end = m.end()
            piece = seg[pos:end]
            if piece.strip():
                out.append((piece, base + pos, base + end))
            pos = end
        if pos < len(seg):
            piece = seg[pos:]
            if piece.strip():
                out.append((piece, base + pos, base + len(seg)))

    cursor = 0
    for m in _PARA_BOUNDARY.finditer(text):
        emit(text[cursor:m.start()], cursor)
        cursor = m.end()
    emit(text[cursor:], cursor)
    return out


def window_before(text: str, pos: int, width: int) -> str:
    return text[max(0, pos - width):pos]


def window_around(text: str, pos: int, width: int) -> str:
    return text[max(0, pos - width):min(len(text), pos + width)]
