/** 知识库工具：让 AI 自己决定查什么，而不是我们预先塞给它。 */

import type { KbOpinion, KnowledgeBase } from '@/types'
import { matchSubjects } from '../kb'
import { hitStats, verdict } from '@/lib/stats'
import { fmtPct, fmtSignedPct, fmtDate } from '@/lib/fmt'
import { asNumber, asString, type ToolDef, type ToolResult } from './types'

function outcomeText(kb: KnowledgeBase, o: KbOpinion, horizons = [5, 20, 60]): string {
  const evs = (kb.evalIndex[o.opinion_id] ?? []).filter((e) => horizons.includes(e.horizon_days))
  if (!evs.length) return '暂无回测'
  return evs
    .sort((a, b) => a.horizon_days - b.horizon_days)
    .map((e) => {
      if (e.status === 'pending') return `T+${e.horizon_days}未走完`
      if (e.status === 'no_data') return `T+${e.horizon_days}缺数据`
      const v = e.signed_excess
      if (v == null) return `T+${e.horizon_days}—`
      return `T+${e.horizon_days} ${fmtSignedPct(v)}${v > 0 ? '命中' : '未命中'}`
    })
    .join('；')
}

function opinionLine(kb: KnowledgeBase, o: KbOpinion): string {
  const inst = o.subject?.secid ? kb.instrumentIndex[o.subject.secid] : undefined
  const name = inst?.name || o.subject?.raw || '未指明'
  const dir = o.polarity > 0 ? '看多' : '看空'
  const hz: Record<string, string> = { short: '短期', mid: '中期', long: '长期' }
  const bits = [
    `[${kb.author?.name || kb.manifest.title}]`,
    `${fmtDate(o.stated_date)} ${dir} ${name}`,
    `强度${o.strength}/5`,
    hz[o.horizon] || '',
    `\n    理由：${(o.thesis || o.evidence || '').replace(/\s+/g, ' ').slice(0, 180)}`,
    `\n    结果：${outcomeText(kb, o)}`,
  ]
  return bits.filter(Boolean).join(' ')
}

/** 跨知识库检索历史观点 */
export const kbSearchTool: ToolDef = {
  name: 'kb_search',
  title: '检索知识库',
  description:
    '在已载入的知识库里检索大V的历史观点。返回每条观点的方向、理由，' +
    '以及该观点发出后 T+5/20/60 交易日的真实超额收益与是否命中。\n' +
    '当用户问到某个板块、某只票、某种市场状况时，**先调用这个工具**，' +
    '不要凭记忆回答。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索关键词，例如「半导体」「新能源 政策」「大盘 下跌」',
      },
      subject: {
        type: 'string',
        description: '限定标的（名称或代码），可选。填了就只看这个标的的观点',
      },
      author: { type: 'string', description: '限定某个大V的名字，可选' },
      limit: { type: 'integer', description: '最多返回几条，默认 12' },
    },
    required: ['query'],
  },
  available: (ctx) => {
    if (!ctx.config.kb.enabled) return { ok: false, reason: '知识库工具已在设置里关闭' }
    if (!ctx.kbs.length) return { ok: false, reason: '没有已启用的知识库' }
    return { ok: true }
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = asString(args.query)
    const subjectFilter = asString(args.subject)
    const authorFilter = asString(args.author)
    const limit = Math.min(
      Math.max(asNumber(args.limit, ctx.config.kb.maxResults), 1),
      40,
    )

    const wanted = new Set<string>()
    for (const kb of ctx.kbs) {
      for (const s of matchSubjects(kb, `${query} ${subjectFilter}`)) wanted.add(s)
    }

    type Hit = { kb: KnowledgeBase; o: KbOpinion; score: number }
    const hits: Hit[] = []
    const q = query.trim()

    for (const kb of ctx.kbs) {
      if (authorFilter && !(kb.author?.name || '').includes(authorFilter)) continue
      for (const o of kb.opinions) {
        const secid = o.subject?.secid ?? ''
        const inst = secid ? kb.instrumentIndex[secid] : undefined
        const hay = `${inst?.name ?? ''} ${o.subject?.raw ?? ''} ${o.thesis ?? ''} ${o.evidence ?? ''}`
        let score = 0
        if (secid && wanted.has(secid)) score += 100
        if (q && hay.includes(q)) score += 40
        // 关键词拆词再匹配一次，提升召回
        for (const part of q.split(/[\s,，、]+/).filter((x) => x.length >= 2)) {
          if (hay.includes(part)) score += 12
        }
        if (!score) continue
        const t = Date.parse(o.stated_at || o.stated_date)
        if (Number.isFinite(t)) score += Math.max(0, 25 - (Date.now() - t) / 86400000 / 40)
        score += o.strength
        hits.push({ kb, o, score })
      }
    }

    hits.sort((a, b) => b.score - a.score)
    const top = hits.slice(0, limit)

    if (!top.length) {
      return {
        ok: true,
        display: `检索「${query}」：无相关观点`,
        summary: '0 条',
        content:
          `在已载入的 ${ctx.kbs.length} 个知识库里没有检索到与「${query}」相关的历史观点。\n` +
          '请如实告诉用户知识库中没有相关记录，不要编造。',
      }
    }

    const lines = top.map((h) => opinionLine(h.kb, h.o))
    return {
      ok: true,
      display: `检索「${query}」：${top.length} 条相关观点`,
      summary: `${top.length} 条`,
      content:
        `检索到 ${top.length} 条相关历史观点（按相关度排序）：\n\n` +
        lines.map((l, i) => `${i + 1}. ${l}`).join('\n\n'),
    }
  },
}

/** 查询某个大V/某个标的历史命中率统计 */
export const kbPerformanceTool: ToolDef = {
  name: 'kb_performance',
  title: '查询命中率',
  description:
    '查询知识库的历史命中率统计（含样本量、Wilson 95% 置信区间下界、符号检验 p 值）。\n' +
    '回答里只要涉及「他准不准」，就必须用这个工具拿真实数字，不要凭感觉说。\n' +
    '注意：样本量小于 10 时统计上没有意义，必须如实说明。',
  parameters: {
    type: 'object',
    properties: {
      author: { type: 'string', description: '大V名字，可选；不填则统计全部' },
      subject: { type: 'string', description: '限定标的（名称或代码），可选' },
      horizon_days: {
        type: 'integer',
        description: '评价周期，默认 20 个交易日。可选 5 / 20 / 60',
      },
    },
    required: [],
  },
  available: (ctx) => {
    if (!ctx.config.kb.enabled) return { ok: false, reason: '知识库工具已关闭' }
    if (!ctx.kbs.length) return { ok: false, reason: '没有已启用的知识库' }
    return { ok: true }
  },
  async run(args, ctx): Promise<ToolResult> {
    const author = asString(args.author)
    const subject = asString(args.subject)
    const horizon = asNumber(args.horizon_days, 20)

    const lines: string[] = []
    for (const kb of ctx.kbs) {
      if (author && !(kb.author?.name || '').includes(author)) continue

      let secids = new Set<string>()
      if (subject) {
        secids = new Set(matchSubjects(kb, subject))
        if (!secids.size) {
          lines.push(
            `【${kb.author?.name}】知识库里没有「${subject}」这个标的，无法统计。`,
          )
          continue
        }
      }

      const signed: number[] = []
      for (const o of kb.opinions) {
        if (secids.size && !(o.subject?.secid && secids.has(o.subject.secid))) continue
        for (const e of kb.evalIndex[o.opinion_id] ?? []) {
          if (e.horizon_days === horizon && e.status === 'ok' && e.signed_excess != null) {
            signed.push(e.signed_excess)
          }
        }
      }
      const s = hitStats(signed)
      if (!s.n) {
        lines.push(`【${kb.author?.name}】T+${horizon} 没有可评价的样本。`)
        continue
      }
      lines.push(
        `【${kb.author?.name}】${subject ? `标的「${subject}」` : '全部'} · T+${horizon}：\n` +
          `  样本 ${s.n} 条，命中 ${s.hits} 条，命中率 ${fmtPct(s.hitRate)}\n` +
          `  Wilson 95% 置信区间 [${fmtPct(s.wilsonLow)}, ${fmtPct(s.wilsonHigh)}]\n` +
          `  符号检验 p = ${(s.pValue ?? 1).toFixed(4)}\n` +
          `  平均超额 ${fmtSignedPct(s.avgExcess)}，中位 ${fmtSignedPct(s.medianExcess)}\n` +
          `  判定：${verdict(s)}` +
          (s.n < 10 ? '\n  ⚠️ 样本量不足 10，该数字没有统计意义' : ''),
      )
    }

    if (!lines.length) {
      return {
        ok: true,
        display: '命中率：无匹配数据',
        summary: '0 条',
        content: '没有匹配的知识库或没有回测数据。',
      }
    }
    return {
      ok: true,
      display: `查询命中率（T+${horizon}）`,
      summary: lines.length ? '已返回' : '无',
      content: lines.join('\n\n'),
    }
  },
}

/** 列出知识库里都覆盖了哪些标的 —— 让 AI 知道"能问什么" */
export const kbCoverageTool: ToolDef = {
  name: 'kb_coverage',
  title: '查看知识库覆盖范围',
  description:
    '列出知识库覆盖了哪些标的（按观点数量排序），以及大V的基本画像。\n' +
    '当你不确定知识库里有没有某个方向的内容，或用户问「这个军师擅长什么」时用它。',
  parameters: {
    type: 'object',
    properties: {
      author: { type: 'string', description: '限定大V名字，可选' },
      limit: { type: 'integer', description: '最多列几个标的，默认 25' },
    },
    required: [],
  },
  available: (ctx) => (ctx.kbs.length ? { ok: true } : { ok: false, reason: '没有知识库' }),
  async run(args, ctx): Promise<ToolResult> {
    const author = asString(args.author)
    const limit = Math.min(Math.max(asNumber(args.limit, 25), 1), 80)
    const out: string[] = []

    for (const kb of ctx.kbs) {
      if (author && !(kb.author?.name || '').includes(author)) continue
      const count = new Map<string, { n: number; bull: number; bear: number }>()
      for (const o of kb.opinions) {
        const secid = o.subject?.secid
        if (!secid) continue
        const c = count.get(secid) ?? { n: 0, bull: 0, bear: 0 }
        c.n++
        if (o.polarity > 0) c.bull++
        else c.bear++
        count.set(secid, c)
      }
      const top = [...count.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, limit)
      const a = kb.author
      out.push(
        `【${a?.name || kb.manifest.title}】\n` +
          (a?.summary ? `  画像：${a.summary}\n` : '') +
          (a?.methodology ? `  方法论：${a.methodology.slice(0, 400)}\n` : '') +
          (a?.known_biases?.length ? `  已知偏见：${a.known_biases.join('；')}\n` : '') +
          `  覆盖标的（共 ${count.size} 个，按提及次数）：\n` +
          top
            .map(([secid, c]) => {
              const inst = kb.instrumentIndex[secid]
              return `    - ${inst?.name || secid}：${c.n} 次（看多 ${c.bull} / 看空 ${c.bear}）`
            })
            .join('\n'),
      )
    }
    return {
      ok: true,
      display: '查看知识库覆盖范围',
      summary: `${out.length} 个知识库`,
      content: out.join('\n\n') || '没有匹配的知识库。',
    }
  },
}

export const kbTools: ToolDef[] = [kbSearchTool, kbPerformanceTool, kbCoverageTool]
