/**
 * 提示词组装 —— 这个文件决定了产品是「有据可查的军师」还是「会编故事的聊天机器人」。
 *
 * 三条铁律：
 *   1. 只喂**检索到的真实历史观点**，并要求模型不得编造大V没说过的话
 *   2. 每条观点都附上**事后的真实超额收益与命中与否** —— 让模型自己看到
 *      「这个人在这个标的上到底准不准」，而不是只看到他说得很有信心
 *   3. 命中率必须带 Wilson 区间与样本量。3 次全对不是「很准」，
 *      这一点必须在提示词里说清楚，否则模型会替用户过度信任
 */

import type {
  AdvisorMode,
  Holding,
  KbAuthor,
  KbEvaluation,
  KbInstrument,
  KbOpinion,
  KnowledgeBase,
  MemoryFact,
  UserProfile,
} from '@/types'
import { hitStats, verdict, type HitStats } from '@/lib/stats'
import { fmtDate, fmtPct, fmtSignedPct } from '@/lib/fmt'
import { describeDca, isDcaActive, monthlyDcaAmount } from '@/lib/dca'
import { matchSubjects } from './kb'
import { findPersona, personaToPrompt } from './persona'
import { buildAuditSystemPrompt } from './audit'

export interface RetrievedOpinion {
  opinion: KbOpinion
  instrument?: KbInstrument
  outcomes: KbEvaluation[]
  signed: number[]
}

export interface MemoryContext {
  profile: UserProfile
  holdings: Holding[]
  facts: MemoryFact[]
}

export interface BuildPromptArgs {
  kbs: KnowledgeBase[]
  question: string
  memory?: MemoryContext | null
  focusSubject?: { secid?: string; name: string } | null
  /** 主评价周期，默认 20 交易日 */
  horizon?: number
  perKbLimit?: number
  /** 会话模式。默认 research（向后兼容） */
  mode?: AdvisorMode
  /** persona / audit 模式扮演谁 */
  personaAuthorUid?: string | null
  /** audit 模式的背景补充 */
  auditContext?: string
  /** 有没有可用的联网工具 —— 决定"先查证"的口径 */
  hasTools?: boolean
  /**
   * 用户是否已预先授权联网查证（会话里「允许联网」开关）。
   * false 时提示词要求模型先问一句再调工具。
   */
  allowOnline?: boolean
}

/** 某个知识库在某周期上的整体表现 */
export function kbPerformance(kb: KnowledgeBase, horizonDays = 20): HitStats {
  const signed: number[] = []
  for (const o of kb.opinions) {
    for (const e of kb.evalIndex[o.opinion_id] ?? []) {
      if (e.horizon_days === horizonDays && e.status === 'ok' && e.signed_excess != null) {
        signed.push(e.signed_excess)
      }
    }
  }
  return hitStats(signed)
}

/** 按标的相关性 + 时效性检索历史观点 */
export function retrieveOpinions(
  kb: KnowledgeBase,
  opts: {
    queryText: string
    focusSecid?: string
    limit?: number
  },
): RetrievedOpinion[] {
  const limit = opts.limit ?? 24
  const mentioned = new Set(matchSubjects(kb, opts.queryText))
  if (opts.focusSecid) mentioned.add(opts.focusSecid)

  const now = Date.now()
  const scored = kb.opinions.map((o) => {
    const secid = o.subject?.secid ?? ''
    let score = 0
    if (secid && mentioned.has(secid)) score += 120
    if (secid && kb.instrumentIndex[secid]?.type === 'index') score += 8 // 大盘观点给点基础分
    const t = Date.parse(o.stated_at || o.stated_date)
    if (Number.isFinite(t)) {
      const days = (now - t) / 86400000
      score += Math.max(0, 40 - days / 30) // 越新越靠前，但衰减很慢
    }
    score += (o.strength ?? 3) * 1.5
    score += (o.confidence ?? 0.5) * 5
    return { o, score }
  })

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(({ o }) => {
    const outcomes = (kb.evalIndex[o.opinion_id] ?? [])
      .slice()
      .sort((a, b) => a.horizon_days - b.horizon_days)
    const signed = outcomes
      .filter((e) => e.status === 'ok' && e.signed_excess != null)
      .map((e) => e.signed_excess as number)
    return {
      opinion: o,
      instrument: o.subject?.secid ? kb.instrumentIndex[o.subject.secid] : undefined,
      outcomes,
      signed,
    }
  })
}

function formatOutcome(e: KbEvaluation): string {
  if (e.status === 'pending') return `T+${e.horizon_days} 尚未走完`
  if (e.status === 'no_data') return `T+${e.horizon_days} 缺数据`
  const ex = e.signed_excess
  if (ex == null) return `T+${e.horizon_days} 无结果`
  const hit = ex > 0 ? '命中' : '未命中'
  return `T+${e.horizon_days} 超额 ${fmtSignedPct(ex)} ${hit}`
}

function formatOpinionLine(r: RetrievedOpinion): string {
  const o = r.opinion
  const name = r.instrument?.name || o.subject?.raw || '（未指明标的）'
  const dir = o.polarity > 0 ? '看多' : '看空'
  const horizonCn: Record<string, string> = {
    short: '短期',
    mid: '中期',
    long: '长期',
    unspecified: '未声明周期',
  }
  const parts: string[] = []
  parts.push(
    `- [${fmtDate(o.stated_date)}] ${dir} **${name}**` +
      `（强度 ${o.strength}/5，${horizonCn[o.horizon] || o.horizon}）`,
  )
  if (o.thesis && o.thesis !== o.evidence) {
    parts.push(`  理由：${truncate(o.thesis, 160)}`)
  }
  if (o.evidence) {
    parts.push(`  原文：${truncate(o.evidence, 220)}`)
  }
  if (o.triggers?.length) {
    parts.push(`  触发条件：${o.triggers.join('；')}`)
  }
  if (r.outcomes.length) {
    parts.push(`  事后结果：${r.outcomes.map(formatOutcome).join('；')}`)
  } else {
    parts.push('  事后结果：暂无回测数据')
  }
  return parts.join('\n')
}

function truncate(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

function formatStats(s: HitStats, horizon: number): string {
  if (!s.n) return `T+${horizon}：暂无可用样本`
  return (
    `T+${horizon}：共 ${s.n} 条可评价观点，命中率 ${fmtPct(s.hitRate)}，` +
    `Wilson 95% 下界 ${fmtPct(s.wilsonLow)}，符号检验 p=${(s.pValue ?? 1).toFixed(3)}，` +
    `平均超额 ${fmtSignedPct(s.avgExcess)}。判定：**${verdict(s)}**`
  )
}

function formatMemory(mem: MemoryContext): string {
  const lines: string[] = []
  const p = mem.profile
  const bits: string[] = []
  if (p.riskAppetite) {
    const cn = { conservative: '保守', balanced: '平衡', aggressive: '激进' } as const
    bits.push(`风险偏好：${cn[p.riskAppetite]}`)
  }
  if (p.preferredHorizons?.length) {
    const cn: Record<string, string> = { short: '短线', mid: '中线', long: '长线' }
    bits.push(`偏好周期：${p.preferredHorizons.map((h) => cn[h] || h).join('/')}`)
  }
  if (p.sectorFocus?.length) {
    bits.push(
      '关注板块：' +
        p.sectorFocus.map((s) => `${s.name}(${Math.round(s.weight * 100)}%)`).join('、'),
    )
  }
  if (p.styleTags?.length) bits.push(`风格标签：${p.styleTags.join('、')}`)
  if (bits.length) lines.push(bits.join('；'))

  const confirmed = mem.holdings.filter((h) => h.confirmed)
  const pending = mem.holdings.filter((h) => !h.confirmed)
  if (confirmed.length) {
    lines.push('\n当前持仓（用户已确认）：')
    for (const h of confirmed) {
      const seg: string[] = [`${h.name}${h.code ? `(${h.code})` : ''}`]
      if (h.marketValue != null) seg.push(`市值 ${h.marketValue.toFixed(0)}`)
      if (h.profitPct != null) seg.push(`盈亏 ${fmtSignedPct(h.profitPct)}`)
      else if (h.profitAmount != null) seg.push(`盈亏 ${h.profitAmount.toFixed(0)}`)
      if (h.costPrice != null) seg.push(`成本 ${h.costPrice}`)
      // 定投一定要写进去：它是持续进行的操作，不是一次性买入。
      // 不写的话，军师会把他自动扣款当成「又在高位补仓」来批评。
      const dca = describeDca(h.dca)
      if (dca) seg.push(`定投：${dca}`)
      if (h.note) seg.push(`备注：${h.note}`)
      lines.push(`  - ${seg.join('，')}`)
    }
    const dcaList = confirmed.filter((h) => isDcaActive(h.dca))
    if (dcaList.length) {
      const monthly = confirmed.reduce((s, h) => s + monthlyDcaAmount(h.dca), 0)
      lines.push(
        `（${dcaList.length} 只在定投，合计每月约 ¥${Math.round(monthly)}。` +
          '定投是持续买入，判断时要考虑它的摊薄作用，不要当成一次性抄底。）',
      )
    }
  } else {
    lines.push('\n当前持仓：未录入')
  }
  if (pending.length) {
    lines.push(
      `（另有 ${pending.length} 条由截图识别但**用户尚未确认**的持仓，请勿当作事实）`,
    )
  }

  const facts = mem.facts.filter((f) => f.active)
  if (facts.length) {
    const byKind: Record<string, string[]> = {}
    for (const f of facts) (byKind[f.kind] ||= []).push(f.text)
    lines.push('\n已知的个人信息与偏好：')
    if (byKind.constraint) lines.push(`  约束：${byKind.constraint.join('；')}`)
    if (byKind.preference) lines.push(`  偏好：${byKind.preference.join('；')}`)
    if (byKind.goal) lines.push(`  目标：${byKind.goal.join('；')}`)
    if (byKind.observation) lines.push(`  观察：${byKind.observation.join('；')}`)
  }
  if (p.notes) lines.push(`\n用户自述：${p.notes}`)
  return lines.join('\n')
}

/**
 * 组装系统提示词。这是整个 App 的核心产出物。
 *
 * 三种模式共用同一批素材（画像、检索到的历史观点、客观表现、用户情况），
 * 但**立场完全不同** —— 这是产品形态的分水岭：
 *
 *   research：他是研究对象  →「他在 2024-03-05 看多半导体，事后 T+20 超额 -3%」
 *   persona ：你是他本人    →「按我的逻辑，这个情况意味着…」
 *   audit   ：他是审你的人  →「你这笔操作触发了我哪条框架，做对还是做错」
 *
 * persona/audit 必须带决策框架（persona 字段）；没有就退回 research 并说明原因，
 * 而不是假装在扮演 —— 没有框架的"扮演"只会变成编造。
 */
export function buildSystemPrompt(args: BuildPromptArgs): string {
  const mode: AdvisorMode = args.mode ?? 'research'
  const advisors = args.kbs.filter((k) => k.enabled)

  if (mode === 'persona' || mode === 'audit') {
    const found = findPersona(advisors, args.personaAuthorUid)
    if (found) return buildAdvisorPrompt(args, found.kb, found.author, mode)
    // 没有框架就诚实退回，不要硬演
    return (
      buildResearchPrompt(
        args,
        `⚠️ 本次请求的是「${mode === 'audit' ? '检验' : '军师'}模式」，` +
          '但选中的知识库里**没有决策框架（persona）**，无法扮演。' +
          '已退回研究模式：下面只能给出他的历史观点，不能推演新情况。' +
          '请让知识库构建者重新跑 `profile-author` 生成框架。',
      )
    )
  }
  return buildResearchPrompt(args)
}

/** persona / audit 模式：先让他"成为"这个人，再让他干活 */
function buildAdvisorPrompt(
  args: BuildPromptArgs,
  kb: KnowledgeBase,
  author: KbAuthor,
  mode: AdvisorMode,
): string {
  const horizon = args.horizon ?? 20
  const limit = args.perKbLimit ?? 16
  const name = author.name || kb.manifest.title
  const hasTools = args.hasTools !== false

  // 1) 角色本体 —— 必须放最前面，先"成为"他
  let system = personaToPrompt(author.persona, name, {
    hasTools,
    allowOnline: args.allowOnline,
  })

  // 2) 他确实说过的话，作为可选佐证（不是回答主体）
  const retrieved = retrieveOpinions(kb, {
    queryText: args.question,
    focusSecid: args.focusSubject?.secid,
    limit,
  })
  const perf = kbPerformance(kb, horizon)
  system +=
    `\n\n# 他确实说过的话（参考，不是回答主体）\n` +
    `以下是与他本人相关的真实历史观点。**只在真的相关时引用**，` +
    `不要拿它们简单类比当前问题 —— 你的价值在于用框架推演，不是复述过去。\n\n` +
    retrieved.map(formatOpinionLine).join('\n') +
    `\n\n# 他这些观点的客观结果（提醒你不要夸大自己\n` +
    `下面是对**他本人历史判断**的统计。这是为了让你（和他）保持诚实：` +
    `如果命中率与随机无异，就不该说得斩钉截铁。\n\n` +
    formatStats(perf, horizon) +
    (author.known_biases?.length
      ? `\n\n他已知的偏好与偏见（你自己要意识到，必要时主动承认）：\n` +
        author.known_biases.map((b) => `- ${b}`).join('\n')
      : '')

  // 3) 聚焦标的
  if (args.focusSubject?.name) {
    system += `\n\n# 本次聚焦\n用户想重点聊 **${args.focusSubject.name}**。`
  }

  // 4) 用户情况
  system += '\n\n# 用户情况\n' + (args.memory ? formatMemory(args.memory) : '用户已关闭全局记忆，不要引用任何持仓或个人偏好。')

  // 5) audit 模式：叠加"审单子"的立场与输出格式
  if (mode === 'audit') {
    system = buildAuditSystemPrompt(system, {
      name,
      context: args.auditContext,
      hasTools,
    })
  }

  return system
}

/** research 模式：他是研究对象 */
function buildResearchPrompt(args: BuildPromptArgs, notice?: string): string {  const horizon = args.horizon ?? 20
  const limit = args.perKbLimit ?? 24
  const blocks: string[] = []

  const advisors = args.kbs.filter((k) => k.enabled)
  const names = advisors.map((k) => k.author?.name || k.manifest.title).join('、')

  blocks.push(
    (notice ? notice + '\n\n' : '') +
      `你是「${names || '通用'}」投资思路的**研究助手**。` +
      '你的职责是把这些大V的历史观点、以及这些观点事后的真实结果，' +
      '如实呈现给用户，并在此基础上分析用户提出的问题。',
  )

  for (const kb of advisors) {
    const a = kb.author
    const sec: string[] = []
    sec.push(`## 军师：${a?.name || kb.manifest.title}`)
    if (a?.summary) sec.push(`**画像**：${a.summary}`)
    if (a?.methodology) sec.push(`**方法论**：\n${a.methodology}`)
    if (a?.known_biases?.length) {
      sec.push(
        `**已知偏好与偏见**（必须如实告知用户，不要替他掩饰）：\n` +
          a.known_biases.map((b) => `- ${b}`).join('\n'),
      )
    }
    if (a?.style_tags?.length) sec.push(`**风格**：${a.style_tags.join('、')}`)
    if (a?.horizon_bias) {
      const cn: Record<string, string> = { short: '偏短线', mid: '偏中线', long: '偏长线' }
      sec.push(`**周期倾向**：${cn[a.horizon_bias] || a.horizon_bias}`)
    }
    const act = a?.activity
    if (act?.first_post && act?.last_post) {
      sec.push(
        `**活跃区间**：${act.first_post} ~ ${act.last_post}` +
          (act.doc_count ? `（采集 ${act.doc_count} 篇）` : ''),
      )
    }

    const perf = kbPerformance(kb, horizon)
    sec.push(`\n**历史表现（客观统计，不是评价）**：\n${formatStats(perf, horizon)}`)
    if (kb.manifest.extractor?.mode === 'rule') {
      sec.push(
        '⚠️ 该知识库由**词表规则**抽取。实测这种抽取方式在口语化、' +
          '正话反说的内容上会判出相反的方向，因此其中的方向判断可信度较低，' +
          '回答时必须向用户说明这一点。',
      )
    }

    const retrieved = retrieveOpinions(kb, {
      queryText: args.question,
      focusSecid: args.focusSubject?.secid,
      limit,
    })
    sec.push(
      `\n**与当前问题相关的历史观点**（共检索到 ${retrieved.length} 条）：\n` +
        retrieved.map(formatOpinionLine).join('\n'),
    )
    blocks.push(sec.join('\n'))
  }

  if (args.focusSubject?.name) {
    blocks.push(
      `## 本次会话聚焦\n用户想重点分析 **${args.focusSubject.name}**。` +
        '请围绕它组织回答。',
    )
  }

  if (args.memory) {
    blocks.push('## 用户情况\n' + formatMemory(args.memory))
  } else {
    blocks.push(
      '## 用户情况\n用户已**关闭全局记忆**，本次不要引用任何持仓或个人偏好，' +
        '只做纯粹的标的分析。',
    )
  }

  blocks.push(
    [
      '## 回答要求',
      '1. **只能基于上面列出的历史观点作答。** 不得编造大V没说过的观点、' +
        '不得虚构日期、不得虚构数字。',
      '2. 引用观点时注明日期与标的，例如「他在 2024-03-05 看多半导体」。',
      '3. **必须如实说明不确定性。** 历史命中率不等于未来收益；' +
        '若样本量小或判定为「与随机无异」，要明确告诉用户不要据此重仓。',
      '4. 若上面的历史观点与用户的问题关联不大，直接说明' +
        '「知识库里没有足够相关的观点」，不要硬答。',
      '5. 若用户持仓与大V观点冲突，要同时呈现两边，让用户自己判断。',
      '6. 结尾用一句话提示：以上是基于历史观点的研究整理，不构成投资建议。',
      '7. 用中文回答，条理清晰，不要长篇大论。',
    ].join('\n'),
  )

  return blocks.join('\n\n')
}

/**
 * 「大模型直接回答」提示词 —— 普通模式。
 *
 * 与军师（依赖知识库 persona / 历史观点）不同，这一侧**不加载任何知识库**，
 * 不引用任何军师的历史观点，由大模型基于通用金融逻辑 + 工具拿到的实时数据
 * 直接回答。行情/联网/快照等工具照常可用（hasTools 只反映工具可用性，
 * 与知识库无关）。
 */
export function buildPlainSystemPrompt(args: BuildPromptArgs): string {
  const blocks: string[] = []

  blocks.push(
    '你是一位专业的金融分析助手。请**不依赖任何历史观点库**，' +
      '直接基于你的知识与分析回答用户的问题。',
  )

  if (args.hasTools) {
    blocks.push(
      [
        '## 工作要求',
        '1. 涉及任何实时数据（价格、涨跌幅、成交额、资金流、公告、最新新闻）时，' +
          '**必须先调用可用工具查真实数据**，不要凭记忆和印象回答。',
        '2. 工具拿不到的数据，如实说明「没有数据」，绝不编造。',
      ].join('\n'),
    )
  }

  if (args.focusSubject?.name) {
    blocks.push(
      `## 本次会话聚焦\n用户想重点分析 **${args.focusSubject.name}**，请围绕它组织回答。`,
    )
  }

  if (args.memory) {
    blocks.push('## 用户情况\n' + formatMemory(args.memory))
  } else {
    blocks.push(
      '## 用户情况\n用户已**关闭全局记忆**，本次不要引用任何持仓或个人偏好，只做纯粹的标的分析。',
    )
  }

  blocks.push(
    [
      '## 回答要求',
      '1. 观点明确、依据充分，不模棱两可；数据与逻辑不符时如实承认不确定性。',
      '2. 用中文回答，结构清晰，可加小标题，但要控制在合理篇幅。',
      '3. 结尾用一句话提示：以上为分析参考，不构成投资建议。',
    ].join('\n'),
  )

  return blocks.join('\n\n')
}

export interface BuildAnalystArgs {
  question: string
  memory?: MemoryContext | null
  focusSubject?: { secid?: string; name: string } | null
  /** 有没有可用的工具 —— 决定"先查证"的口径 */
  hasTools?: boolean
  allowOnline?: boolean
}

/**
 * 「专业金融分析师」提示词 —— 对比请教的分析侧。
 *
 * 与军师（依赖知识库 persona / 历史观点）不同，这一侧**不依赖任何特定人物的
 * 历史观点**，完全基于通用金融逻辑 + 最新数据独立分析。
 * 两套提示词互不影响，生成也互不影响，方便用户对照。
 */
export function buildAnalystSystemPrompt(args: BuildAnalystArgs): string {
  const hasTools = args.hasTools !== false
  const blocks: string[] = []

  blocks.push(
    '你是「专业金融分析师」，供职于一家头部机构的投研部，' +
      '擅长宏观研判、行业比较与个股/基金的基本面与估值分析。' +
      '现在用户向你咨询一个投资问题，请你**独立**给出你的分析。',
  )

  if (hasTools) {
    blocks.push(
      [
        '## 工作要求',
        '1. 涉及任何实时数据（价格、涨跌幅、成交额、资金流、公告、基金持仓、' +
          '最新新闻）时，**必须先调用可用工具查真实数据**，不要凭记忆和印象回答。',
        '2. 工具拿不到的数据，如实说明「没有数据」，绝不编造。',
        '3. 这是你与「军师」（大V决策框架）的对比场：你不依赖任何特定人物的历史观点，' +
          '完全基于通用金融逻辑与最新数据独立得出结论。',
      ].join('\n'),
    )
  }

  blocks.push(
    [
      '## 分析框架（按这个顺序组织回答）',
      '1. 市场环境：当前大盘位置、风格与资金面（有数据先查数据）',
      '2. 标的基本面与估值：质地、估值分位、景气度、盈利与现金流',
      '3. 资金与交易面：主力动向、量价、拥挤度、情绪',
      '4. 风险：哪些情景会推翻你的结论，最坏情况是什么',
      '5. 结论：明确给出观点与依据，不模棱两可',
    ].join('\n'),
  )

  if (args.focusSubject?.name) {
    blocks.push(`## 本次聚焦\n用户想重点分析 **${args.focusSubject.name}**，请围绕它组织回答。`)
  }

  if (args.memory) {
    blocks.push('## 用户情况\n' + formatMemory(args.memory))
  } else {
    blocks.push(
      '## 用户情况\n用户已**关闭全局记忆**，本次不要引用任何持仓或个人偏好，只做纯粹的标的分析。',
    )
  }

  blocks.push(
    [
      '## 回答要求',
      '1. 观点明确、依据充分，不模棱两可；数据与逻辑不符时如实承认不确定性。',
      '2. 与「军师」的回答是两套独立分析，你不需要参考或呼应对方，给出你自己的判断即可。',
      '3. 用中文回答，结构清晰，可加小标题，但要控制在合理篇幅。',
      '4. 结尾用一句话提示：以上为专业分析参考，不构成投资建议。',
    ].join('\n'),
  )

  return blocks.join('\n\n')
}
