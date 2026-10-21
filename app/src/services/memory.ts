/**
 * 全局记忆：把截图变成结构化持仓，再从持仓与对话里归纳个人画像。
 *
 * 两个刻意的设计：
 *   1. 截图识别结果一律 confirmed=false。券商的持仓截图里数字密集，
 *      识图模型错一位数就会污染之后所有的分析，所以必须让用户核对。
 *   2. 所有推断都带 evidence（依据）。个人画像不是黑盒，
 *      用户要能看到「为什么 AI 认为我偏好短线」并删掉不对的。
 */

import type { MemoryFact, ModelProvider, UserProfile } from '@/types'
import { chat, chatJson, LlmError } from './llm'
import { nowIso, uid, num, clamp } from '@/lib/fmt'

export interface ParsedHolding {
  name: string
  code?: string
  shares?: number
  costPrice?: number
  lastPrice?: number
  marketValue?: number
  profitAmount?: number
  profitPct?: number
  confidence: number
  note?: string
}

export interface ExtractResult {
  holdings: ParsedHolding[]
  summary?: string
  warnings: string[]
  raw: string
}

const HOLDING_PROMPT = `你是券商持仓截图的结构化提取器。

要求：
1. 只提取**图片里明确可见**的数据。看不清、被遮挡、没显示的字段一律留空，
   绝对不要推测或补全。
2. 股票/基金名称照抄，不要改写、不要补全成你认识的简称。
3. 盈亏百分比如果图上给的是「12.34%」这种形式，输出 0.1234（小数）。
   如果只有金额没有百分比，就只填金额。
4. 每行标注 confidence（0-1），表示你对这一行读得有多确定。
   如果某行有明显模糊或可能看错，confidence 给 0.5 以下。
5. 如果图片不是持仓截图（例如是K线图、聊天记录、新闻），
   返回 {"holdings": [], "summary": "这不是持仓截图"}。

严格输出 JSON 对象：
{
  "summary": "一句话描述这张图是什么，以及总资产/总盈亏（若可见）",
  "holdings": [
    {
      "name": "股票或基金名称",
      "code": "6位代码，没有就省略",
      "shares": 100,
      "costPrice": 10.5,
      "lastPrice": 11.2,
      "marketValue": 1120,
      "profitAmount": 70,
      "profitPct": 0.0667,
      "confidence": 0.9
    }
  ],
  "warnings": ["图上哪里看不清，或有什么无法确定"]
}`

export async function extractHoldingsFromImages(
  provider: ModelProvider,
  images: string[],
  signal?: AbortSignal,
): Promise<ExtractResult> {
  if (!provider.supportsVision) {
    throw new LlmError(
      `模型「${provider.name}」未标记为支持识图。\n` +
        '请到「设置 → 模型」里编辑它并勾选「支持识图」，' +
        '或新建一个支持视觉的模型（如 gpt-4o / qwen-vl-max / glm-4v）。',
      undefined,
      'format',
    )
  }
  if (!images.length) throw new LlmError('没有提供图片', undefined, 'format')

  const content = [
    { type: 'text' as const, text: HOLDING_PROMPT },
    ...images.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ]

  const { data, raw } = await chatJson<{
    summary?: string
    holdings?: unknown[]
    warnings?: string[]
  }>(provider, {
    messages: [{ role: 'user', content }],
    temperature: 0,
    signal,
  })

  const holdings: ParsedHolding[] = []
  const warnings: string[] = Array.isArray(data.warnings) ? data.warnings.map(String) : []

  for (const item of data.holdings ?? []) {
    const h = item as Record<string, unknown>
    const name = String(h.name ?? '').trim()
    if (!name) continue
    holdings.push({
      name,
      code: h.code ? String(h.code).replace(/\D/g, '').slice(0, 6) || undefined : undefined,
      shares: num(h.shares),
      costPrice: num(h.costPrice),
      lastPrice: num(h.lastPrice),
      marketValue: num(h.marketValue),
      profitAmount: num(h.profitAmount),
      profitPct: normalizePct(num(h.profitPct)),
      confidence: clamp(num(h.confidence) ?? 0.5, 0, 1),
      note: h.note ? String(h.note) : undefined,
    })
  }

  if (holdings.some((h) => h.confidence < 0.6)) {
    warnings.push('有识别置信度较低的条目，请重点核对')
  }

  return { holdings, summary: data.summary, warnings, raw }
}

/** 模型有时给 12.34 有时给 0.1234，统一成小数 */
function normalizePct(v?: number): number | undefined {
  if (v == null) return undefined
  if (Math.abs(v) > 1.5) return v / 100
  return v
}

// ============================================================
// 画像推断
// ============================================================

export interface ProfileContext {
  holdings: { name: string; code?: string; marketValue?: number; profitPct?: number }[]
  /** 用户在大V知识库里看过/问过什么，作为兴趣佐证 */
  recentQuestions?: string[]
  existingNotes?: string
}

const PROFILE_PROMPT = `你在为一个股票/基金助手归纳用户画像。

基于用户**已确认的持仓**和最近的提问，归纳出对他的投资有实际帮助的信息。

严格要求：
1. **只根据给定数据推断，不要脑补。** 数据里没体现的，不要写。
2. 每条结论都要给 evidence（具体依据），例如
   ["持仓中 4/6 只是半导体相关"]。
3. confidence 要诚实：只有一条依据就写 0.4~0.6，不要写 0.9。
4. 不要把"持有某股票"直接等同于"看好该行业"——可能是套牢。
   如果某标的亏损明显（profitPct < -0.1），要谨慎表述。
5. 归纳 3~8 条即可，宁少勿滥。

严格输出 JSON 对象：
{
  "riskAppetite": "conservative" | "balanced" | "aggressive" | null,
  "preferredHorizons": ["short"|"mid"|"long"],
  "sectorFocus": [{"name":"半导体","weight":0.4}],
  "styleTags": ["偏好科技成长"],
  "facts": [
    {
      "kind": "preference"|"constraint"|"observation"|"goal",
      "text": "一句话结论",
      "confidence": 0.6,
      "evidence": ["依据1","依据2"]
    }
  ],
  "notes": "可选：给用户自己看的补充说明"
}`

export interface ProfileInference {
  profile: Partial<UserProfile>
  facts: MemoryFact[]
  raw: string
}

export async function inferProfile(
  provider: ModelProvider,
  ctx: ProfileContext,
  signal?: AbortSignal,
): Promise<ProfileInference> {
  const confirmed = ctx.holdings
  if (!confirmed.length) {
    return { profile: {}, facts: [], raw: '' }
  }

  const lines: string[] = ['已确认持仓：']
  for (const h of confirmed) {
    const seg = [`- ${h.name}${h.code ? `(${h.code})` : ''}`]
    if (h.marketValue != null) seg.push(`市值 ${Math.round(h.marketValue)}`)
    if (h.profitPct != null) seg.push(`盈亏 ${(h.profitPct * 100).toFixed(2)}%`)
    lines.push(seg.join('，'))
  }
  if (ctx.recentQuestions?.length) {
    lines.push('\n最近提问：')
    for (const q of ctx.recentQuestions.slice(-12)) lines.push(`- ${q}`)
  }
  if (ctx.existingNotes) lines.push(`\n用户自述：${ctx.existingNotes}`)

  const { data, raw } = await chatJson<{
    riskAppetite?: string | null
    preferredHorizons?: string[]
    sectorFocus?: { name?: string; weight?: number }[]
    styleTags?: string[]
    facts?: {
      kind?: string
      text?: string
      confidence?: number
      evidence?: string[]
    }[]
    notes?: string
  }>(provider, {
    messages: [{ role: 'user', content: `${PROFILE_PROMPT}\n\n---\n${lines.join('\n')}` }],
    temperature: 0.2,
    signal,
  })

  const risk = data.riskAppetite
  const profile: Partial<UserProfile> = {
    riskAppetite:
      risk === 'conservative' || risk === 'balanced' || risk === 'aggressive'
        ? risk
        : undefined,
    preferredHorizons: (data.preferredHorizons ?? []).filter(
      (h): h is 'short' | 'mid' | 'long' => ['short', 'mid', 'long'].includes(h),
    ),
    sectorFocus: (data.sectorFocus ?? [])
      .filter((s) => s?.name)
      .map((s) => ({
        name: String(s.name),
        weight: clamp(num(s.weight) ?? 0, 0, 1),
      })),
    styleTags: (data.styleTags ?? []).map(String).filter(Boolean),
    notes: data.notes ? String(data.notes) : undefined,
    updatedAt: nowIso(),
  }

  const validKinds = ['preference', 'constraint', 'observation', 'goal'] as const
  const facts: MemoryFact[] = (data.facts ?? [])
    .filter((f) => f?.text)
    .map((f) => ({
      id: uid('fact_'),
      kind: validKinds.includes(f.kind as (typeof validKinds)[number])
        ? (f.kind as MemoryFact['kind'])
        : 'observation',
      text: String(f.text),
      confidence: clamp(num(f.confidence) ?? 0.5, 0, 1),
      evidence: (f.evidence ?? []).map(String).filter(Boolean),
      createdAt: nowIso(),
      source: 'inferred' as const,
      active: true,
    }))

  return { profile, facts, raw }
}

/** 从持仓里直接算出来的板块分布，不依赖模型，作为模型输出的交叉验证 */
export function sectorDistribution(
  holdings: { name: string; marketValue?: number }[],
): { name: string; weight: number }[] {
  const KEYWORDS: [string, string[]][] = [
    ['半导体/芯片', ['半导体', '芯片', '集成电路', '微电子', '晶圆']],
    ['新能源/电池', ['锂', '电池', '新能源', '储能', '光伏', '风电']],
    ['医药', ['医药', '生物', '制药', '医疗', '疫苗']],
    ['白酒/消费', ['白酒', '酒', '食品', '饮料', '消费', '乳业']],
    ['金融', ['银行', '证券', '保险', '券商']],
    ['科技/软件', ['科技', '软件', '信息', '计算机', '通信', '电子']],
    ['军工', ['军工', '航空', '航天', '船舶', '国防']],
    ['地产/建筑', ['地产', '置业', '建筑', '建材']],
    ['有色/资源', ['有色', '稀土', '矿业', '煤', '钢', '石油', '化工']],
    ['传媒/游戏', ['传媒', '游戏', '影视', '文化']],
  ]
  const bucket = new Map<string, number>()
  let total = 0
  for (const h of holdings) {
    const w = h.marketValue && h.marketValue > 0 ? h.marketValue : 1
    total += w
    let hit = '其他'
    for (const [label, kws] of KEYWORDS) {
      if (kws.some((k) => h.name.includes(k))) {
        hit = label
        break
      }
    }
    bucket.set(hit, (bucket.get(hit) ?? 0) + w)
  }
  if (!total) return []
  return [...bucket.entries()]
    .map(([name, w]) => ({ name, weight: w / total }))
    .sort((a, b) => b.weight - a.weight)
}

/** 让模型用一句话点评当前持仓结构（轻量、便宜） */
export async function commentOnPortfolio(
  provider: ModelProvider,
  holdings: { name: string; profitPct?: number; marketValue?: number }[],
  signal?: AbortSignal,
): Promise<string> {
  const dist = sectorDistribution(holdings)
  const lines = [
    `持仓 ${holdings.length} 只：`,
    ...holdings
      .slice(0, 40)
      .map(
        (h) =>
          `- ${h.name}` +
          (h.profitPct != null ? ` 盈亏${(h.profitPct * 100).toFixed(1)}%` : '') +
          (h.marketValue != null ? ` 市值${Math.round(h.marketValue)}` : ''),
      ),
    '',
    '板块分布（按市值）：' +
      dist.map((d) => `${d.name} ${Math.round(d.weight * 100)}%`).join('、'),
  ]
  const res = await chat(provider, {
    messages: [
      {
        role: 'system',
        content:
          '你是持仓结构分析助手。用 3~5 句话指出这个持仓的结构特征与集中度风险。' +
          '只描述事实，不给买卖建议。如果某板块占比过高要明确指出。不要用列表。',
      },
      { role: 'user', content: lines.join('\n') },
    ],
    temperature: 0.3,
    signal,
  })
  return res.text.trim()
}
