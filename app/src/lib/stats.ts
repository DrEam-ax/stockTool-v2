/** 统计工具。与 Python 侧 backtest/stats.py 保持同一套算法。 */

/** Wilson 得分区间：比正态近似在小样本下可靠得多 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): [number, number] {
  if (n <= 0) return [0, 1]
  const p = successes / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const margin =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

function logFactorial(n: number): number {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

function binomPmf(k: number, n: number): number {
  // 用对数计算避免大数阶乘溢出
  const logp = logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2
  return Math.exp(logp)
}

/** 双侧符号检验：命中率是否显著偏离 50% */
export function signTestP(successes: number, n: number): number {
  if (n <= 0) return 1
  if (n > 500) {
    const z = Math.max(0, Math.abs(successes - n / 2) - 0.5) / Math.sqrt(n / 4)
    return Math.max(0, Math.min(1, erfc(z / Math.SQRT2)))
  }
  let cdf = 0
  for (let i = 0; i <= successes; i++) cdf += binomPmf(i, n)
  let sf = 0
  for (let i = successes; i <= n; i++) sf += binomPmf(i, n)
  return Math.min(1, 2 * Math.min(cdf, sf))
}

function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const z = Math.abs(x)
  const t = 1 / (1 + z / 2)
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? r : 2 - r
}

export interface HitStats {
  n: number
  hits: number
  hitRate: number | null
  wilsonLow: number | null
  wilsonHigh: number | null
  pValue: number | null
  avgExcess: number | null
  medianExcess: number | null
}

export function hitStats(signed: number[]): HitStats {
  const vals = signed.filter((v) => Number.isFinite(v))
  const n = vals.length
  if (!n) {
    return {
      n: 0,
      hits: 0,
      hitRate: null,
      wilsonLow: null,
      wilsonHigh: null,
      pValue: null,
      avgExcess: null,
      medianExcess: null,
    }
  }
  const hits = vals.filter((v) => v > 0).length
  const [lo, hi] = wilsonInterval(hits, n)
  const sorted = [...vals].sort((a, b) => a - b)
  const mid =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return {
    n,
    hits,
    hitRate: hits / n,
    wilsonLow: lo,
    wilsonHigh: hi,
    pValue: signTestP(hits, n),
    avgExcess: vals.reduce((a, b) => a + b, 0) / n,
    medianExcess: mid,
  }
}

/** 明确定性：小样本不许说成「很准」 */
export function verdict(s: HitStats, minSamples = 10): string {
  if (!s.n) return '无样本'
  if (s.n < minSamples) return '样本不足'
  const p = s.pValue ?? 1
  const low = s.wilsonLow ?? 0
  if (p < 0.05 && low > 0.5) return '显著优于随机'
  if (p < 0.05 && (s.hitRate ?? 0.5) < 0.5) return '显著差于随机'
  return '与随机无异'
}
