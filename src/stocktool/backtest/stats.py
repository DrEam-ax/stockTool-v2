"""统计工具。

小样本是这类产品的最大陷阱：一个"3 次全对"的大V看起来命中率 100%。
所以除了点估计，必须同时给出 Wilson 区间和符号检验 p 值。
"""

from __future__ import annotations

import math
from statistics import mean, median


def wilson_interval(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """二项比例的 Wilson 得分区间（比正态近似在小样本下可靠得多）。"""
    if n <= 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = (z / denom) * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, center - margin), min(1.0, center + margin))


def _binom_pmf(k: int, n: int, p: float = 0.5) -> float:
    if k < 0 or k > n:
        return 0.0
    if p <= 0:
        return 1.0 if k == 0 else 0.0
    if p >= 1:
        return 1.0 if k == n else 0.0
    logp = (math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * math.log(p) + (n - k) * math.log(1 - p))
    return math.exp(logp)


def sign_test_p(successes: int, n: int) -> float:
    """双侧符号检验：命中率是否显著偏离 50%。

    注意：对 A 股大V 绩效来说，50% 往往是**错误的原假设** ——
    随机选股在同一批日期上的命中率只有 ~44%。请优先用
    binom_test_p(k, n, baseline) 对着实测基线做检验。
    """
    return binom_test_p(successes, n, 0.5)


def binom_test_p(successes: int, n: int, p0: float) -> float:
    """双侧二项检验：命中率是否显著偏离给定的原假设 p0。"""
    if n <= 0:
        return 1.0
    p0 = min(max(p0, 1e-6), 1 - 1e-6)
    if n > 5000:
        sd = math.sqrt(n * p0 * (1 - p0))
        z = max(0.0, abs(successes - n * p0) - 0.5) / sd
        return max(0.0, min(1.0, math.erfc(z / math.sqrt(2))))
    cdf = sum(_binom_pmf(i, n, p0) for i in range(0, successes + 1))
    sf = sum(_binom_pmf(i, n, p0) for i in range(successes, n + 1))
    return min(1.0, 2 * min(cdf, sf))


def summarize_returns(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "mean": None, "median": None, "win_rate": None}
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v <= 0]
    avg_win = mean(wins) if wins else 0.0
    avg_loss = abs(mean(losses)) if losses else 0.0
    payoff = (avg_win / avg_loss) if avg_loss > 1e-12 else None
    return {
        "n": len(values),
        "mean": mean(values),
        "median": median(values),
        "win_rate": len(wins) / len(values),
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "payoff": payoff,
    }


def pct(value: float | None, digits: int = 2) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.{digits}f}%"


def num(value: float | None, digits: int = 3) -> str:
    if value is None:
        return "—"
    return f"{value:+.{digits}f}"


def verdict_vs(s: dict, baseline: float | None, min_samples: int = 10) -> str:
    """对着**实测基线**下判定。

    baseline=None 时退回 50%，但那在 A 股里几乎总是错的，
    所以报告里必须显式提示基线不可用。
    """
    n = s.get("n") or 0
    if not n:
        return "无样本"
    if n < min_samples:
        return "样本不足"
    rate = s.get("hit_rate") or 0.0
    base = 0.5 if baseline is None else baseline
    p = binom_test_p(s.get("hits") or 0, n, base)
    diff = rate - base
    if p < 0.05:
        return "显著强于随机" if diff > 0 else "显著弱于随机"
    if abs(diff) < 0.02:
        return "与随机无异"
    return "略强于随机" if diff > 0 else "略弱于随机"
