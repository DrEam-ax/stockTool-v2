/**
 * 「推荐之后回头核对持仓」的工具。
 *
 * 为什么必须有它：
 *   1. 军师现在可以给板块/基金建议了，但它必须先知道**你是不是已经持有**了 ——
 *      推荐一只你已经满仓的基金是毫无意义的，甚至是危险的。
 *   2. 用户持仓多半来自**截图识别**，名字容易偏移：
 *        · 份额类别不同：`建信上海金ETF联接A` vs `...联接C`
 *        · 简称/全称不一致：`中欧医疗健康` vs `中欧医疗健康混合A`
 *        · OCR 漏字/错字：`稀有金属` 被读成 `希有金属`
 *      按字符串精确比对会漏掉这些，所以这里做**归一化 + 相似度**匹配，
 *      并把「疑似」单独标出来让模型自己判断，而不是硬给一个二选一的答案。
 */

import type { Holding } from '@/types'
import { asString, type ToolDef, type ToolResult } from './types'

/** 去掉不影响"是不是同一只产品"的修饰：份额类别、发起式、联接、括号内容等 */
export function normalizeProductName(raw: string): string {
  let s = String(raw || '').trim()
  if (!s) return ''
  // 全角转半角（ＡＢＣ → ABC），去掉空格和常见分隔符
  s = s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s·・\-—_/／]/g, '')
  // 份额类别后缀：联接A / 联接C / A类 / (QDII)A 等
  s = s.replace(/(联接|连接)?[A-Eａ-ｅ]$/i, '')
  s = s.replace(/[A-Eａ-ｅ](类|份额)$/i, '')
  // 常见后缀
  s = s.replace(/(发起式?|混合型?|股票型?|债券型?|指数型?|LOF|ETF|QDII|FOF)$/gi, '')
  return s.toLowerCase()
}

/** 字符二元组 Dice 相似度：对中文短名比编辑距离更稳，且不吃字序 */
export function similarity(a: string, b: string): number {
  const x = normalizeProductName(a)
  const y = normalizeProductName(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ma = bigrams(x)
  const mb = bigrams(y)
  let inter = 0
  for (const [g, n] of ma) inter += Math.min(n, mb.get(g) ?? 0)
  const total = x.length - 1 + (y.length - 1)
  return total > 0 ? (2 * inter) / total : 0
}

export interface HoldingMatch {
  holding: Holding
  score: number
  /** exact=归一化后完全相同；likely=很像但名字有偏移；weak=弱相关 */
  level: 'exact' | 'likely' | 'weak'
}

/** 在一个持仓列表里找最像的那几只 */
export function matchHoldings(
  name: string,
  holdings: Holding[],
  { min = 0.55, limit = 3 }: { min?: number; limit?: number } = {},
): HoldingMatch[] {
  const out: HoldingMatch[] = []
  for (const h of holdings) {
    const score = similarity(name, h.name)
    if (score < min) continue
    const level: HoldingMatch['level'] =
      score >= 0.999 ? 'exact' : score >= 0.75 ? 'likely' : 'weak'
    out.push({ holding: h, score, level })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}

export const checkHoldingsTool: ToolDef = {
  name: 'check_holdings',
  title: '核对持仓',
  description:
    '在向用户推荐某只基金/标的**之前或之后**调用，确认他是不是已经持有。' +
    '会用归一化 + 相似度匹配，能认出份额类别不同（A/C）、简称与全称不同、' +
    '以及截图识别导致的错字偏移。返回「已持有 / 疑似已持有 / 未持有」。' +
    '**一次可以传多个名字**（推荐了几只就一起传），不要一个一个分开调用 —— ' +
    '那样会白白消耗轮数。',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '要核对的基金或标的名称，可以一次传多个（≤8 个）',
      },
    },
    required: ['names'],
  },
  available: (ctx) =>
    ctx.holdings && ctx.holdings.length
      ? { ok: true }
      : { ok: false, reason: '用户还没有录入任何持仓（记忆 → 从截图导入）' },
  async run(args, ctx): Promise<ToolResult> {
    // 兼容单个字符串：模型有时会传 name 而不是 names
    const one = asString((args as Record<string, unknown>).name).trim()
    const list = Array.isArray(args.names)
      ? (args.names as unknown[]).map((s) => asString(s).trim()).filter(Boolean)
      : one
        ? [one]
        : []
    const names = list.slice(0, 8)
    if (!names.length) {
      return {
        ok: false,
        display: '核对持仓：缺少名称',
        content: '请提供要核对的名称（names 数组）',
        error: '缺少名称',
      }
    }
    const holdings = ctx.holdings ?? []
    const confirmed = holdings.filter((h) => h.confirmed)
    const pending = holdings.filter((h) => !h.confirmed)

    const fmt = (h: Holding): string => {
      const bits = [h.name]
      if (h.code) bits.push(`(${h.code})`)
      if (h.marketValue != null) bits.push(`市值 ${Math.round(h.marketValue)}`)
      if (h.profitPct != null) bits.push(`盈亏 ${(h.profitPct * 100).toFixed(1)}%`)
      if (h.dca?.enabled) bits.push('有定投')
      return bits.join('，')
    }

    const sections: string[] = []
    let held = 0
    let likely = 0
    for (const name of names) {
      const hits = matchHoldings(name, confirmed)
      const pendingHits = matchHoldings(name, pending)
      const lines: string[] = [`## ${name}`]
      if (hits.length) {
        for (const m of hits) {
          const tag =
            m.level === 'exact'
              ? '已持有'
              : m.level === 'likely'
                ? `疑似已持有（相似度 ${(m.score * 100).toFixed(0)}%，名字有偏移）`
                : `弱相关（相似度 ${(m.score * 100).toFixed(0)}%）`
          if (m.level === 'exact') held += 1
          else if (m.level === 'likely') likely += 1
          lines.push(`- ${tag}：${fmt(m.holding)}`)
        }
      } else {
        lines.push('- 未持有：已确认持仓里没有相近的')
      }
      if (pendingHits.length) {
        lines.push(
          `- 另有 ${pendingHits.length} 条**待确认**记录相近：` +
            pendingHits.map((m) => m.holding.name).join('、') +
            '（用户还没核对，不要当成已持有）',
        )
      }
      sections.push(lines.join('\n'))
    }

    const head =
      names
        .map((n) => {
          const top = matchHoldings(n, confirmed)[0]
          if (!top) return `${n}：未持有`
          if (top.level === 'exact') return `${n}：已持有`
          if (top.level === 'likely') return `${n}：疑似已持有`
          return `${n}：未持有`
        })
        .join('；')

    return {
      ok: true,
      display: `核对持仓 ${names.length} 只`,
      summary: held ? `已持有 ${held}` : likely ? `疑似 ${likely}` : '未持有',
      detail: sections.join('\n\n') + '\n\n' + head,
      content:
        sections.join('\n\n') +
        '\n\n小结：' +
        head +
        (likely
          ? '\n\n注意：标「疑似」的是名字有偏移（份额类别或简称不同），' +
            '可能是同一只产品的不同份额，也可能是截图识别错字。' +
            '**必须向用户确认**，不要直接断言是同一只。'
          : '') +
        (held ? '\n\n已持有的那几只，推荐时要考虑：是否该加仓、是否已有定投、集中度是否过高。' : ''),
    }
  },
}
