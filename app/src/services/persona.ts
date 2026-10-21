/**
 * 「军师模式」—— 把知识库里的决策框架渲染成角色提示词。
 *
 * 核心设计（这段决定了它是不是"私人军师"）：
 *
 *   史料检索：system = "这是他的历史观点列表"
 *             → 模型只会类比"N年M月他说过X"，遇到新标的一问三不知
 *
 *   军师模式：system = "这是他的决策框架，你先查证现状，再按框架推演"
 *             → 模型能对**从没出现过的情况**给出自洽判断
 *
 * 所以提示词里必须强制两件事：
 *   1. 先调用工具查当前数据，不许凭记忆作答
 *   2. 用框架推演，而不是复述历史
 */

import type { KnowledgeBase, KbAuthor, Persona } from '@/types'

/** 知识库列表里带决策框架的军师。
 *
 * 契约：**一个 .stkb = 一位军师**。要组建"军师团"就载入多个知识库。
 * 这也是导出器强制单作者的原因 —— 多作者会让 author.json 只能装下第一个。
 */
export function availablePersonas(kbs: KnowledgeBase[]): {
  kb: KnowledgeBase
  author: KbAuthor
}[] {
  const out: { kb: KnowledgeBase; author: KbAuthor }[] = []
  for (const kb of kbs) {
    if (!kb.enabled) continue
    const author = kb.author
    if (author?.persona && (author.persona.decision_rules?.length ?? 0) > 0) {
      out.push({ kb, author })
    }
  }
  return out
}

export function hasPersona(author: KbAuthor | undefined | null): boolean {
  return !!author?.persona && (author.persona.decision_rules?.length ?? 0) > 0
}

/** 按 author_uid 找军师；不指定就返回第一个可用的 */
export function findPersona(
  kbs: KnowledgeBase[],
  authorUid?: string | null,
): { kb: KnowledgeBase; author: KbAuthor } | null {
  const all = availablePersonas(kbs)
  if (!all.length) return null
  if (!authorUid) return all[0]
  return all.find((p) => p.author.author_uid === authorUid) ?? all[0]
}

/**
 * 渲染角色提示词。
 * 与 Python 侧 `extract/persona.py: persona_to_prompt` 保持一致 ——
 * 两边渲染出来的东西必须同构，否则同一个知识库在 CLI 和 App 里表现会不一样。
 */
export function personaToPrompt(
  persona: Persona | null | undefined,
  name: string,
  opts: { hasTools?: boolean } = {},
): string {
  if (!persona) return ''
  const L: string[] = []

  L.push(`# 你是谁\n你在扮演「${name}」的数字化身，用他的框架思考，而不是复述他说过的话。`)
  if (persona.identity) L.push(`\n## 你的定位\n${persona.identity}`)

  if (persona.worldview?.length) {
    L.push('\n## 你的世界观（所有判断的地基）')
    for (const w of persona.worldview) L.push(`- ${w}`)
  }

  // frameworks 放在 decision_rules 之前：有名字的方法论才是能反复调用的东西，
  // 具体规则只是它在某个场景下的实例。
  if (persona.frameworks?.length) {
    L.push('\n## 你的核心方法论（**检验操作时优先用这些**）')
    persona.frameworks.forEach((f, i) => {
      L.push(`${i + 1}. **${f.name || '（未命名）'}** —— ${f.content || ''}`)
      if (f.how_to_apply) L.push(`   怎么用：${f.how_to_apply}`)
      if (f.durability) L.push(`   为什么不过期：${f.durability}`)
    })
  }

  if (persona.decision_rules?.length) {
    L.push('\n## 你的决策规则（遇到情况按这些推演）')
    persona.decision_rules.forEach((r, i) => {
      L.push(`${i + 1}. 当「${r.when}」`)
      L.push(`   → 你会「${r.then}」`)
      if (r.because) L.push(`   因为：${r.because}`)
    })
  }

  if (persona.vetoes?.length) {
    L.push('\n## 你的否决条件（这些情况你会直接说不）')
    for (const v of persona.vetoes) L.push(`- ${v}`)
  }

  if (persona.preferences?.length) L.push('\n## 你偏好的\n' + persona.preferences.join('、'))
  if (persona.aversions?.length) L.push('\n## 你厌恶的\n' + persona.aversions.join('、'))

  const frameworks: [keyof Persona, string][] = [
    ['valuation_framework', '你怎么判断贵贱'],
    ['timing_framework', '你怎么择时'],
    ['position_sizing', '你的仓位逻辑'],
  ]
  for (const [key, label] of frameworks) {
    const v = persona[key]
    if (typeof v === 'string' && v) L.push(`\n## ${label}\n${v}`)
  }

  if (persona.information_sources?.length) {
    L.push('\n## 你做判断时真正依赖的信息\n' + persona.information_sources.join('、'))
  }

  if (persona.checklist?.length) {
    L.push('\n## 面对一个新标的，你依次问自己')
    persona.checklist.forEach((c, i) => L.push(`${i + 1}. ${c}`))
  }

  const v = persona.voice
  if (v && (v.tone || v.argument_style || v.catchphrases?.length)) {
    L.push('\n## 你的说话方式')
    if (v.tone) L.push(`- 语气：${v.tone}`)
    if (v.argument_style) L.push(`- 论证套路：${v.argument_style}`)
    if (v.catchphrases?.length) L.push(`- 你常用的说法：${v.catchphrases.join('、')}`)
  }

  // 行为约束：这段是"军师"和"复读机"的分界线
  L.push('\n# 重要行为约束')
  if (opts.hasTools !== false) {
    L.push(
      '1. **先查证，再判断。** 涉及行情、政策、新闻时，**必须先调用工具获取当前数据**，' +
        '不许凭记忆或训练数据作答。查不到就说查不到，绝不许编数字。',
    )
  } else {
    L.push(
      '1. **现在没有联网工具。** 涉及当前数据的部分必须明确说「这需要查证」，' +
        '然后**仅基于你的框架**推演，绝不许编数字。',
    )
  }
  L.push(
    '2. **用框架推演，不要类比历史。** 不要说「我以前怎么看X」，' +
      '而要说「按我的逻辑，这个情况意味着…」。历史观点只在真的相关时才引用。',
  )
  L.push('3. **区分事实与判断。** 明确标出哪些是查到的数据、哪些是你的推断。')
  L.push('4. **允许说不。** 如果这个标的触发了你的否决条件，直接说你没兴趣，并说明为什么。')
  L.push('5. **不确定就承认。** 不要为了显得专业而编造。')
  L.push('6. **不要荐股。** 用户问「能买吗」时，用你的框架帮他分析，而不是给出「买/不买」的指令。')
  L.push('7. 用第一人称，保持你的语气。')

  return L.join('\n')
}

/** 给 UI 用的一句话摘要 */
export function personaSummary(persona: Persona | null | undefined): string {
  if (!persona) return '（无决策框架）'
  const bits: string[] = []
  if (persona.frameworks?.length) bits.push(`${persona.frameworks.length} 个方法论`)
  if (persona.decision_rules?.length) bits.push(`${persona.decision_rules.length} 条规则`)
  if (persona.vetoes?.length) bits.push(`${persona.vetoes.length} 条否决`)
  if (persona.checklist?.length) bits.push(`${persona.checklist.length} 步清单`)
  return bits.join(' · ') || '（框架为空）'
}
