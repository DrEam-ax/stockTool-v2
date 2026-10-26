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
import type { QuoteSnapshot } from '@/types'

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

export function parseTencentQuote(line: string): Quote | null {
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

/* ------------------------------------------------------------------ */
/* 提问时刻行情快照（发问那一分钟的价格存档）                          */
/* ------------------------------------------------------------------ */

/** 把腾讯报价行转成快照（纯函数，便于测试）。 */
export function quoteLineToSnapshot(line: string): QuoteSnapshot | null {
  const q = parseTencentQuote(line)
  if (!q) return null
  return {
    name: q.name,
    code: q.code,
    price: q.price,
    prevClose: q.prevClose,
    change: q.change,
    changePct: q.changePct,
    time: q.time,
  }
}

/**
 * 拉取单个标的的实时快照。失败返回 null（调用方静默跳过：
 * 快照是锦上添花，绝不能阻塞发送或打断对话）。
 */
export async function fetchQuoteSnapshot(symbol: string): Promise<QuoteSnapshot | null> {
  try {
    const res = await request(`https://qt.gtimg.cn/q=${symbol}`, {
      encoding: 'gbk',
      timeoutMs: 10000,
    })
    if (!res.ok) return null
    for (const part of res.text.split(';')) {
      const snap = quoteLineToSnapshot(part.trim())
      if (snap) return snap
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 当日分时走势（stock_trend）的解析与报告                             */
/* ------------------------------------------------------------------ */

/** "0930" → 570（当日第几分钟）；非法输入返回 NaN */
function minutesOfDay(hhmm: string): number {
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(2, 4))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN
  return h * 60 + m
}

/** 570 → "9:30"；900 → "15:00" */
function fmtClock(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** 一个交易分钟点 */
export interface TrendPoint {
  /** 当日第几分钟（570 = 9:30） */
  t: number
  /** "9:30" 样式的可读时间 */
  label: string
  price: number
  /** 累计成交量（手） */
  vol: number
  /** 累计成交额（元） */
  amt: number
}

/** 分时接口解析结果 */
export interface TrendData {
  name: string
  code: string
  date: string
  price: number
  prevClose: number
  open: number
  high: number
  low: number
  change: number
  changePct: number
  /** 成交量（手） */
  vol: number
  /** 成交额（万元） */
  amount: number
  turnover: number
  points: TrendPoint[]
}

/** 解析腾讯分时接口返回（纯函数，便于测试）。失败返回 null。 */
export function parseMinuteResponse(symbol: string, body: string): TrendData | null {
  let j: { data?: Record<string, unknown> }
  try {
    j = JSON.parse(body)
  } catch {
    return null
  }
  const d = (j?.data?.[symbol] ?? null) as
    | { data?: { data?: unknown; date?: unknown }; qt?: Record<string, unknown> }
    | null
  if (!d?.data?.data || !d.qt?.[symbol]) return null
  const q = d.qt[symbol] as unknown[]
  const num = (i: number) => {
    const v = Number(q[i])
    return Number.isFinite(v) ? v : 0
  }
  const rows = d.data.data as unknown[]
  const pts: TrendPoint[] = []
  for (const row of rows) {
    const [time, price, vol, amt] = String(row).split(/\s+/)
    const t = minutesOfDay(String(time))
    // 过滤盘前竞价等异常点：A 股交易时段从 9:30（=570）开始
    if (!Number.isFinite(t) || t < 570) continue
    const np = Number(price)
    const nv = Number(vol)
    const na = Number(amt)
    if (!Number.isFinite(np)) continue
    pts.push({ t, label: fmtClock(t), price: np, vol: Number.isFinite(nv) ? nv : 0, amt: Number.isFinite(na) ? na : 0 })
  }
  if (!pts.length) return null
  return {
    name: String(q[1] || symbol),
    code: String(q[2] || symbol),
    date: String(d.data.date ?? ''),
    price: num(3),
    prevClose: num(4),
    open: num(5),
    change: num(31),
    changePct: num(32),
    high: num(33),
    low: num(34),
    vol: num(36),
    amount: num(37),
    turnover: num(38),
    points: pts,
  }
}

/**
 * 把分时数据编译成"解读友好"的报告：开高低收、成交量额、
 * 早盘/午后/尾盘节奏、分钟量峰、最近几个分钟点。
 */
export function buildTrendReport(td: TrendData): string {
  const pts = td.points
  const last = pts.length - 1
  // 逐分钟成交量 = 累计量差分（首分钟即自身）
  const perMin = pts.map((p, i) => (i === 0 ? p.vol : Math.max(0, p.vol - pts[i - 1].vol)))
  // 段界：早盘到 11:30（690）、午后开盘 13:00（780）、尾盘起点 14:30（870）
  const idxAt = (t: number): number => {
    const i = pts.findIndex((p) => p.t >= t)
    return i < 0 ? last : i
  }
  const iEarly = idxAt(690)
  const iNoon = idxAt(780)
  const iLate = idxAt(870)
  const earlyOpen = pts[0].price
  const earlyClose = pts[iEarly].price
  const noonOpen = pts[iNoon].price
  const lateOpen = pts[iLate].price
  const close = pts[last].price
  const half1Vol = pts[iEarly].vol
  const half2Vol = Math.max(0, pts[last].vol - pts[iEarly].vol)
  // 分钟量峰
  let peak = 0
  for (let i = 1; i < perMin.length; i++) if (perMin[i] > perMin[peak]) peak = i
  // 最近 6 个分钟点
  const recent = pts.slice(Math.max(0, pts.length - 6)).map((p, k) => {
    const base = pts.length - 6 + k
    return `${p.label}　${p.price.toFixed(2)}　${perMin[base]} 手`
  })

  const diff = (a: number, b: number) => {
    const d = b - a
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}`
  }
  const dir = td.changePct > 0 ? '涨' : td.changePct < 0 ? '跌' : '平'
  const amountYi = (td.amount / 10000).toFixed(2)

  const lines: string[] = [
    `${td.name}(${td.code}) ${td.date} 当日分时（腾讯财经）`,
    `昨收 ${td.prevClose}　今开 ${td.open}　最新 ${td.price}　${dir} ${td.changePct.toFixed(2)}%（${diff(td.prevClose, td.price)}）`,
    `最高 ${td.high}　最低 ${td.low}　成交 ${td.vol} 手　成交额 ${amountYi} 亿　换手 ${td.turnover}%`,
    `全天 ${pts.length} 个交易分钟`,
    '',
    '节奏：',
    `· 早盘 9:30→11:30：${earlyOpen.toFixed(2)} → ${earlyClose.toFixed(2)}（${diff(earlyOpen, earlyClose)}）`,
    `· 午后 13:00→14:30：${noonOpen.toFixed(2)} → ${lateOpen.toFixed(2)}（${diff(noonOpen, lateOpen)}）`,
    `· 尾盘 14:30→15:00：${lateOpen.toFixed(2)} → ${close.toFixed(2)}（${diff(lateOpen, close)}）`,
    `· 分钟量峰：${pts[peak].label} 单分钟 ${perMin[peak]} 手`,
    `· 前半日累计 ${half1Vol} 手 / 后半日累计 ${half2Vol} 手`,
    '',
    '最近 6 个分钟点：',
    ...recent,
  ]
  return lines.join('\n')
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

      // 部分标的拿不到时不能整批失败。
      // 腾讯对不支持的代码会返回空内容（例如某些基金/场内代码），
      // 原来只要有一条解析不出、或者整批都解析不出就抛错，
      // 用户看到的是「查询行情失败」，其实其他标的的数据是好的。
      const got = new Set(quotes.map((q) => q.code))
      const missing = usable.filter((s) => !got.has(s.replace(/^(sh|sz|bj)/i, '')))

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
          (missing.length ? `\n\n接口没返回这几只（可能代码不支持）：${missing.join('、')}` : '') +
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

export const stockTrendTool: ToolDef = {
  name: 'stock_trend',
  title: '当日走势',
  description:
    '查询某标的**当天**的分时走势：逐分钟价格与成交量、早盘/午后/尾盘节奏、放量缩量时段。\n' +
    '当用户问「今天怎么走的」「什么时候拉起来的」「几点放量」「尾盘是不是砸了」这类问题时使用。\n' +
    '支持 6 位代码（600519）、带市场前缀（sh600519）或知识库里出现过的名称（贵州茅台）。\n' +
    '**回答涉及当日盘中节奏、分时走势、成交量分布时，必须用这个工具，不要用训练数据里的印象。**',
  parameters: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: '要查询的标的，如 ["600519"]，最多 5 个',
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
      return { ok: false, display: '当日走势：参数缺失', content: 'symbols 不能为空', error: '参数缺失' }
    }
    const inputs = raw.slice(0, 5)
    const resolved: { input: string; symbol: string | null }[] = inputs.map((s) => ({
      input: s,
      symbol: resolveSymbol(s, ctx),
    }))
    const usable = resolved.filter((r) => r.symbol).map((r) => r.symbol as string)
    const unresolved = resolved.filter((r) => !r.symbol).map((r) => r.input)

    if (!usable.length) {
      return {
        ok: false,
        display: `当日走势：无法识别 ${unresolved.join('、')}`,
        error: '无法识别标的',
        content:
          `无法识别这些标的：${unresolved.join('、')}。` +
          '请改用 6 位代码重试（如 600519、512480、000300）。',
      }
    }

    const reports: string[] = []
    const failures: string[] = []
    for (const symbol of usable) {
      try {
        const res = await request(
          `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`,
          { signal: ctx.signal, timeoutMs: 15000 },
        )
        if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
        const td = parseMinuteResponse(symbol, res.text)
        if (!td) throw new Error('返回内容无法解析，接口格式可能已变化')
        reports.push(buildTrendReport(td))
      } catch (e) {
        failures.push(`${symbol}：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (!reports.length) {
      return {
        ok: false,
        display: `当日走势失败：${failures[0]?.slice(0, 50) ?? '未知'}`,
        error: failures.join('；'),
        content:
          `当日走势查询失败：${failures.join('；')}\n` +
          '请如实告知用户拿不到当日分时数据，**绝对不要用记忆里的走势冒充**。',
      }
    }

    const first = reports[0].split('\n')[0]
    return {
      ok: true,
      display: `当日走势：${first}`,
      summary: `${reports.length} 个标的${failures.length ? `（${failures.length} 个失败）` : ''}`,
      detail: reports.join('\n\n'),
      content:
        `当日分时走势（来源：腾讯财经，${new Date().toLocaleString('zh-CN')}）：\n\n` +
        reports.join('\n\n') +
        (failures.length ? `\n\n以下标的没取到：${failures.join('、')}` : '') +
        (unresolved.length ? `\n\n未能识别：${unresolved.join('、')}` : '') +
        '\n\n请注意：分时数据只覆盖当天；行情有延迟，不同数据源复权方式不同。',
    }
  },
}

export const marketTools: ToolDef[] = [stockQuoteTool, fundHoldingsTool, stockTrendTool]
