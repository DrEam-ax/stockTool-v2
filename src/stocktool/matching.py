"""最长匹配扫描。

中文金融文本里，长词优先很重要：
  "坚定看好" 必须赢过 "看好"；"平安银行" 必须赢过 "平安"。
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

T = TypeVar("T")


def longest_match_scan(
    text: str,
    table: dict[str, T],
    *,
    min_len: int = 2,
    max_len: int = 10,
    accept: Callable[[str, T], bool] | None = None,
    mask: list[bool] | None = None,
) -> list[tuple[int, int, str, T]]:
    """贪心最长匹配。

    mask 为已占用的字符位（如 $代码$ 已匹配），命中后跳过占位区间。
    返回 [(start, end, term, payload)]，按位置升序。
    """
    out: list[tuple[int, int, str, T]] = []
    n = len(text)
    i = 0
    while i < n:
        if mask is not None and mask[i]:
            i += 1
            continue
        upper = min(max_len, n - i)
        hit: tuple[int, int, str, T] | None = None
        for length in range(upper, min_len - 1, -1):
            term = text[i:i + length]
            payload = table.get(term)
            if payload is None:
                continue
            if mask is not None and any(mask[i:i + length]):
                continue
            if accept is not None and not accept(term, payload):
                continue
            hit = (i, i + length, term, payload)
            break
        if hit is not None:
            out.append(hit)
            i = hit[1]
        else:
            i += 1
    return out


def build_table(terms: dict[str, Any]) -> dict[str, Any]:
    return dict(terms)


def max_term_len(table: dict[str, Any]) -> int:
    return max((len(k) for k in table), default=0)
