/**
 * 行情工具：实时股价与基金持仓。
 *
 * 数据源用腾讯与东财的公开接口 —— 不引入付费数据商，
 * 也就不用 API key。代价是这两个接口都不返回 CORS 头，
 * 浏览器里会被拦；打包成 App 走原生 HTTP 才可用。
 * 失败时给出明确原因，绝不让模型拿训练数据里的旧价格冒充实时行情。
 */

import { request } from '@/lib/http'
import { asString, type ToolDef, type ToolContext, type ToolResult } from './types'

/** 把各种写法归一成腾讯用的 symbol（sh600519 / sz300750 / bj920000） */
export function resolveSymbol(input: string, ctx: ToolContext): string | null {
  const raw = input.trim()
  if (!raw) return null

  // 已经是 sh600519 这种形式
  const prefixed = /^(sh|sz|bj)(\d{6})$/i.exec(raw)
  if (prefixed) return `${prefixed[1].toLowerCase()}${prefixed[2]}`

  // 纯 6 位代码
  if (/^\d{6}$/.test(raw)) {
    if (/^(6|9)/.test(raw)) return `sh${raw}`
    if (/^(0|2|3)/.test(raw)) return `sz${raw}`
    if (/^(4|8)/.test(raw) || raw.startsWith('920')) return `bj${raw}`
    return `sz${raw}`
  }

  // 名称：用已载入知识库的标的字典反查
  for (const kb of ctx.kbs) {
    for (const inst of kb.instruments) {
      if (inst.name === raw || inst.aliases?.includes(raw)) {
        const ex = (inst.exchange || '').toLowerCase()
        if (ex === 'sh' || ex === 'sz' || ex === 'bj') return `${ex}${inst.code}`
        const m = /^(\d)\.(\d{6})$/.exec(inst.secid)
        if (m) return `${m[1] === '1' ? 'sh' : 'sz'}${m[2]}`
      }
    }
    // 别名表
    for (const [alias, secid] of Object.entries(kb.nameIndex)) {
      if (alias === raw) {
        const inst = kb.instrumentIndex[secid]
        if (inst) {
          const ex = (inst.exchange || '').toLowerCase()
          if (ex === 'sh' || ex === 'sz' || ex === 'bj') return `${ex}${inst.code}`
          const m = /^(\d)\.(\d{6})$/.exec(secid)
          if (m) return `${m[1] === '1' ? 'sh' : 'sz'}${m[2]}`
        }
      }
    }
  }
  return null
}

interface Quote {
  name: string
  code: string
  price: number
  prevClose: number
  change: number
  changePct: number
  open: number
  high: number
  low: number
  volume: number
  amount: number
  turnover: number
  pe: number
  pb: number
  marketCap: number
  time: string
}

function parseTencentQuote(line: string): Quote | null {
  const m = /v_(\w+)="([^"]*)"/.exec(line)
  if (!m) return null
  const f = m[2].split('~')
  if (f.length < 35) return null
  const num = (i: number) => {
    const v = Number(f[i])
    return Number.isFinite(v) ? v : 0
  }
  return {
    name: f[1] || '',
    code: f[2] || m[1],
    price: num(3),
    prevClose: num(4),
    open: num(5),
    // 腾讯的字段顺序：31=涨跌 32=涨跌% 33=最高 34=最低 36=成交量(手) 37=成交额(万)
    change: num(31),
    changePct: num(32),
    high: num(33),
    low: num(34),
    volume: num(36),
    amount: num(37),
    turnover: num(38),
    pe: num(39),
    marketCap: num(45),
    pb: num(46),
    time: f[30] || '',
  }
}

export const stockQuoteTool: ToolDef = {
  name: 'stock_quote',
  title: '查询行情',
  description:
    '查询股票/ETF/指数的最新价格、涨跌幅、成交额、市盈率、市净率、总市值等。\n' +
    '支持 6 位代码（600519）、带市场前缀（sh600519），' +
    '或知识库里出现过的名称（贵州茅台）。\n' +
    '**凡涉及当前价格或涨跌，必须用这个工具，不要用训练数据里的价格。**',
  parameters: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: '要查询的标的，如 ["600519","宁德时代","sh000300"]，最多 10 个',
      },
    },
    required: ['symbols'],
  },
  available: (ctx) =>
    ctx.config.market.enabled ? { ok: true } : { ok: false, reason: '行情工具已在设置里关闭' },
  async run(args, ctx): Promise<ToolResult> {
    const raw = Array.isArray(args.symbols)
      ? (args.symbols as unknown[]).map((s) => asString(s)).filter(Boolean)
      : [asString(args.symbols)].filter(Boolean)
    if (!raw.length) {
      return { ok: false, display: '行情：参数缺失', content: 'symbols 不能为空', error: '参数缺失' }
    }
    const inputs = raw.slice(0, 10)
    const resolved: { input: string; symbol: string | null }[] = inputs.map((s) => ({
      input: s,
      symbol: resolveSymbol(s, ctx),
    }))
    const usable = resolved.filter((r) => r.symbol).map((r) => r.symbol as string)
    const unresolved = resolved.filter((r) => !r.symbol).map((r) => r.input)

    if (!usable.length) {
      return {
        ok: false,
        display: `行情：无法识别 ${unresolved.join('、')}`,
        error: '无法识别标的',
        content:
          `无法识别这些标的：${unresolved.join('、')}。` +
          '请改用 6 位代码重试（如 600519、512480、000300）。',
      }
    }

    try {
      const res = await request(
        `https://qt.gtimg.cn/q=${usable.join(',')}`,
        { encoding: 'gbk', signal: ctx.signal },
      )
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)

      const quotes: Quote[] = []
      for (const part of res.text.split(';')) {
        const q = parseTencentQuote(part.trim())
        if (q && q.name) quotes.push(q)
      }
      if (!quotes.length) {
        throw new Error('返回内容无法解析，接口格式可能已变化')
      }

      const lines = quotes.map((q) => {
        const dir = q.changePct > 0 ? '涨' : q.changePct < 0 ? '跌' : '平'
        return (
          `${q.name}(${q.code})：${q.price}　${dir} ${q.changePct.toFixed(2)}%\n` +
          `    今开 ${q.open}　最高 ${q.high}　最低 ${q.low}　昨收 ${q.prevClose}\n` +
          `    成交额 ${q.amount} 万　换手 ${q.turnover}%　PE ${q.pe}　PB ${q.pb}` +
          (q.marketCap ? `　总市值 ${q.marketCap} 亿` : '') +
          `\n    数据时间 ${q.time}`
        )
      })

      return {
        ok: true,
        display: `查询行情：${quotes.map((q) => q.name).join('、')}`,
        summary: `${quotes.length} 个标的`,
        detail: lines.join('\n'),
        content:
          `实时行情（来源：腾讯财经，${new Date().toLocaleString('zh-CN')}）：\n\n` +
          lines.join('\n\n') +
          (unresolved.length ? `\n\n未能识别：${unresolved.join('、')}` : '') +
          '\n\n请注意：行情有延迟，且不同数据源的复权方式不同。',
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        display: `查询行情失败：${msg.slice(0, 50)}`,
        error: msg,
        content:
          `行情查询失败：${msg}\n` +
          '请如实告知用户拿不到实时行情，**绝对不要用记忆里的价格冒充**。',
      }
    }
  },
}

export const fundHoldingsTool: ToolDef = {
  name: 'fund_holdings',
  title: '查询基金持仓',
  description:
    '查询某只公募基金的最新前十大重仓股（代码、名称、占净值比例、持仓市值）。' +
    '当用户问「这只基金买了什么」「基金的持仓结构」时使用。需要 6 位基金代码。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位基金代码，如 110011' },
    },
    required: ['code'],
  },
  available: (ctx) =>
    ctx.config.market.enabled ? { ok: true } : { ok: false, reason: '行情工具已在设置里关闭' },
  async run(args, ctx): Promise<ToolResult> {
    const code = asString(args.code).replace(/\D/g, '')
    if (code.length !== 6) {
      return {
        ok: false,
        display: '基金持仓：代码无效',
        content: '基金代码必须是 6 位数字。',
        error: '代码无效',
      }
    }
    try {
      const url =
        `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc` +
        `&code=${code}&topline=10&year=&month=&rt=${Math.random()}`
      const res = await request(url, { signal: ctx.signal, timeoutMs: 20000 })
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)

      const contentMatch = /content:"([\s\S]*?)",arryear/.exec(res.text)
      const html = contentMatch ? contentMatch[1].replace(/\\"/g, '"') : res.text
      const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      const holdings: string[] = []
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
          m[1].replace(/<[^>]+>/g, '').trim(),
        )
        // 期望：序号 | 代码 | 名称 | 占净值比例 | 持股数 | 持仓市值
        if (cells.length >= 4 && /^\d+$/.test(cells[0]) && /^\d{6}$/.test(cells[1] ?? '')) {
          holdings.push(
            `${cells[2]}(${cells[1]})　占净值 ${cells[3]}` +
              (cells[4] ? `　持股 ${cells[4]}` : '') +
              (cells[5] ? `　市值 ${cells[5]}` : ''),
          )
        }
      }
      if (!holdings.length) {
        return {
          ok: true,
          display: `基金 ${code}：未取到持仓`,
          content:
            `没有取到基金 ${code} 的前十大持仓。可能是：代码不是基金、` +
            '该基金尚未披露、或接口格式已变化。请如实告知用户。',
        }
      }
      return {
        ok: true,
        display: `基金 ${code} 前十大持仓`,
        summary: `${holdings.length} 只`,
        detail: holdings.join('\n'),
        content:
          `基金 ${code} 的前十大重仓股（来源：天天基金）：\n\n` +
          holdings.map((h, i) => `${i + 1}. ${h}`).join('\n') +
          '\n\n注意：这是定期报告披露的数据，有滞后，不代表当前实时持仓。',
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        display: `基金持仓查询失败：${msg.slice(0, 40)}`,
        error: msg,
        content: `基金持仓查询失败：${msg}\n请如实告知用户，不要编造持仓数据。`,
      }
    }
  },
}

export const marketTools: ToolDef[] = [stockQuoteTool, fundHoldingsTool]
