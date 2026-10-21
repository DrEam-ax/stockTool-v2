/**
 * 联网工具：搜索与抓页。
 *
 * 搜索 API 由用户自己配（Tavily / Brave / Serper / 自建）。
 * 我们不内置搜索服务、不代管 key —— 这和「模型自带 key」是同一个原则。
 *
 * 现实约束：这些服务大多不返回 CORS 头，**浏览器里会失败**。
 * 打包成 Capacitor 后走原生 HTTP 就没有限制。
 * 失败时必须明确告诉用户原因，不能静默返回空结果让模型瞎编。
 */

import { htmlToText, request } from '@/lib/http'
import { asNumber, asString, type ToolDef, type ToolResult } from './types'

interface SearchHit {
  title: string
  url: string
  snippet: string
  published?: string
}

async function searchTavily(
  apiKey: string,
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: max,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const data = (res.json ?? JSON.parse(res.text)) as {
    results?: { title?: string; url?: string; content?: string; published_date?: string }[]
  }
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    published: r.published_date,
  }))
}

async function searchBrave(
  apiKey: string,
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`
  const res = await request(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const data = (res.json ?? JSON.parse(res.text)) as {
    web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] }
  }
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
    published: r.age,
  }))
}

async function searchSerper(
  apiKey: string,
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const res = await request('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: max }),
    signal,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const data = (res.json ?? JSON.parse(res.text)) as {
    organic?: { title?: string; link?: string; snippet?: string; date?: string }[]
  }
  return (data.organic ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
    published: r.date,
  }))
}

/** 自建代理：约定收 {query,max_results,api_key}，返回 {results:[{title,url,snippet}]} */
async function searchCustom(
  baseUrl: string,
  apiKey: string,
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const res = await request(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ query, max_results: max, api_key: apiKey }),
    signal,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const data = (res.json ?? JSON.parse(res.text)) as Record<string, unknown>
  const arr = (data.results ?? data.data ?? data.items ?? []) as {
    title?: string
    url?: string
    link?: string
    snippet?: string
    content?: string
  }[]
  return (Array.isArray(arr) ? arr : []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? r.link ?? '',
    snippet: r.snippet ?? r.content ?? '',
  }))
}

// ============================================================
// 内置免密搜索（provider = 'builtin'）
// ============================================================
//
// 为什么要有这一层：
//   DSH 那种宿主能直接联网，是因为宿主有**服务端**代管搜索。
//   本 App 是纯客户端、没有后端，只能自己在客户端解决。
//   但客户端能解决的部分比想象的多 —— 下面这两个源都**不需要任何 key**，
//   而且恰好覆盖了"查证"需求的大头（财经新闻、政策、公告）。
//
// 实测（2026-10，国内网络）：
//   · 东财财经新闻搜索  HTTP 200，命中上万条，带日期与摘要   ← 首选
//   · 必应中国          HTTP 200，10 个结果块，可解析
//   · DuckDuckGo        **超时**，国内不可用，故不采用

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** JSONP 拆壳：cb({...}) → {...} */
function parseJsonp(text: string): unknown {
  const t = text.trim()
  const m = /^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(t)
  return JSON.parse(m ? m[1] : t)
}

/**
 * 东方财富财经新闻搜索 —— **免密钥**，中文财经新闻质量最好。
 * 返回带日期，正好符合"查最新消息"的场景。
 */
async function searchEastmoneyNews(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const param = {
    uid: '',
    keyword: query,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'time',
        pageIndex: 1,
        pageSize: Math.min(Math.max(max, 1), 20),
        preTag: '',
        postTag: '',
      },
    },
  }
  const url =
    'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' +
    encodeURIComponent(JSON.stringify(param))
  const res = await request(url, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://so.eastmoney.com/' },
    signal,
    timeoutMs: 15000,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const data = parseJsonp(res.text) as {
    result?: { cmsArticleWebOld?: { title?: string; url?: string; content?: string; date?: string; mediaName?: string }[] }
  }
  return (data.result?.cmsArticleWebOld ?? []).map((r) => ({
    title: stripTags(r.title ?? ''),
    url: r.url ?? '',
    snippet: stripTags(r.content ?? ''),
    published: r.date,
  }))
}

/** 必应中国 —— **免密钥**通用搜索，财经之外的兜底 */
async function searchBing(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url =
    'https://cn.bing.com/search?q=' +
    encodeURIComponent(query) +
    `&count=${Math.min(Math.max(max, 1), 20)}&setlang=zh-CN`
  const res = await request(url, {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
    signal,
    timeoutMs: 20000,
  })
  if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
  const out: SearchHit[] = []
  // 每个结果是 <li class="b_algo"> … </li>
  for (const block of res.text.split(/<li class="b_algo"/i).slice(1)) {
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? ''
    out.push({
      title: stripTags(a[2]),
      url: a[1],
      snippet: stripTags(snip),
    })
    if (out.length >= max) break
  }
  return out
}

/**
 * 内置搜索：按可靠性依次尝试，**第一个有结果的胜出**。
 * 不把两个源的结果合并 —— 财经新闻和通用网页混在一起噪声太大。
 */
async function builtinSearch(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; via: string }> {
  const errors: string[] = []

  try {
    const hits = await searchEastmoneyNews(query, max, signal)
    if (hits.length) return { hits, via: '东方财富财经新闻' }
    errors.push('东财新闻：无结果')
  } catch (e) {
    errors.push(`东财新闻：${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const hits = await searchBing(query, max, signal)
    if (hits.length) return { hits, via: '必应中国' }
    errors.push('必应：无结果')
  } catch (e) {
    errors.push(`必应：${e instanceof Error ? e.message : String(e)}`)
  }

  throw new Error(`内置搜索两个源都没成功（${errors.join('；')}）`)
}

export const webSearchTool: ToolDef = {
  name: 'web_search',
  title: '联网搜索',
  description:
    '联网搜索最新信息：新闻、政策、公告、研报观点、突发消息等。\n' +
    '**知识库里没有时效性内容**，凡是涉及「最近」「今天」「最新」的问题，' +
    '都应该用这个工具，而不是凭训练数据回答。\n' +
    '搜到结果后请注明来源链接，并提醒用户自行核实。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词，尽量具体，如「碳酸锂 价格 最新」' },
      max_results: { type: 'integer', description: '返回条数，默认 6' },
    },
    required: ['query'],
  },
  available: (ctx) => {
    const w = ctx.config.webSearch
    if (!w.enabled) return { ok: false, reason: '联网功能未启用（设置 → 工具）' }
    // builtin 免密，永远可用 —— 用户什么都不用配
    if (w.provider === 'builtin') return { ok: true }
    if (w.provider === 'none') return { ok: false, reason: '未选择搜索服务商' }
    if (w.provider !== 'custom' && !w.apiKey) {
      return { ok: false, reason: `未填写 ${w.provider} 的 API Key` }
    }
    if (w.provider === 'custom' && !w.baseUrl) return { ok: false, reason: '未填写自建搜索地址' }
    return { ok: true }
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = asString(args.query)
    const cfg = ctx.config.webSearch
    const max = Math.min(Math.max(asNumber(args.max_results, cfg.maxResults), 1), 20)
    if (!query) {
      return { ok: false, display: '搜索：参数缺失', content: 'query 不能为空', error: 'query 为空' }
    }

    try {
      let hits: SearchHit[]
      let via = ''
      if (cfg.provider === 'builtin') {
        const r = await builtinSearch(query, max, ctx.signal)
        hits = r.hits
        via = r.via
      } else if (cfg.provider === 'tavily') {
        hits = await searchTavily(cfg.apiKey, query, max, ctx.signal)
      } else if (cfg.provider === 'brave') {
        hits = await searchBrave(cfg.apiKey, query, max, ctx.signal)
      } else if (cfg.provider === 'serper') {
        hits = await searchSerper(cfg.apiKey, query, max, ctx.signal)
      } else {
        hits = await searchCustom(cfg.baseUrl || '', cfg.apiKey, query, max, ctx.signal)
      }

      if (!hits.length) {
        return {
          ok: true,
          display: `搜索「${query}」：无结果`,
          summary: '0 条',
          content: `搜索「${query}」没有返回结果。请如实告知用户没搜到，不要编造。`,
        }
      }
      const body = hits
        .map(
          (h, i) =>
            `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, ' ').slice(0, 400)}` +
            (h.published ? `\n   （发布时间：${h.published}）` : ''),
        )
        .join('\n\n')
      return {
        ok: true,
        display: `搜索「${query}」：${hits.length} 条${via ? `（${via}）` : ''}`,
        summary: `${hits.length} 条`,
        detail: body,
        content:
          `搜索「${query}」的结果${via ? `（来源：${via}）` : ''}：\n\n${body}\n\n` +
          '引用时请附上链接，并提醒用户自行核实。',
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        display: `搜索失败：${msg.slice(0, 60)}`,
        error: msg,
        content:
          `联网搜索失败：${msg}\n` +
          '请如实告诉用户搜索不可用，**不要用训练数据假装成搜索结果**。',
      }
    }
  },
}

export const fetchPageTool: ToolDef = {
  name: 'fetch_page',
  title: '读取网页',
  description:
    '读取指定网址的正文内容。当搜索结果里有看起来有价值的链接、' +
    '或用户直接给了链接时用它。正文会被截断到 6000 字。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整网址，需以 http:// 或 https:// 开头' },
    },
    required: ['url'],
  },
  // 注意：只依赖总开关，**不依赖搜索服务商** ——
  // 读一个已知网址（政策原文、公告页、新闻页）根本不需要搜索 API。
  available: (ctx) =>
    ctx.config.webSearch.enabled
      ? { ok: true }
      : { ok: false, reason: '联网功能未启用（设置 → 工具）' },
  async run(args, ctx): Promise<ToolResult> {
    const url = asString(args.url)
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, display: '读取网页：网址无效', content: '网址必须以 http(s):// 开头', error: '网址无效' }
    }
    try {
      const res = await request(url, { signal: ctx.signal, timeoutMs: 20000 })
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
      const ct = res.text.slice(0, 200).toLowerCase()
      const text = /<html|<!doctype/.test(ct) ? htmlToText(res.text) : res.text.slice(0, 6000)
      if (!text.trim()) {
        return { ok: true, display: '读取网页：正文为空', content: '该页面没有可提取的正文。' }
      }
      return {
        ok: true,
        display: `读取网页：${new URL(url).hostname}`,
        summary: `${text.length} 字`,
        detail: text.slice(0, 1500),
        content: `页面内容（${url}）：\n\n${text}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        display: `读取网页失败：${msg.slice(0, 50)}`,
        error: msg,
        content: `读取 ${url} 失败：${msg}`,
      }
    }
  },
}

/**
 * 个股公告 —— **免密钥**，东方财富。
 *
 * 为什么值得单独做一个工具：公告是"查证"里最高频的刚需，
 * 而且它**天然不需要搜索** —— 有股票代码就能直接查。
 * 让模型为此去配一个搜索服务商是没道理的。
 */
export const announcementTool: ToolDef = {
  name: 'stock_announcements',
  title: '查个股公告',
  description:
    '查某只股票最近的公司公告标题与日期（免密钥）。\n' +
    '想知道「公司最近有没有发什么公告」「业绩预告出了吗」时用它，' +
    '比联网搜索更快更准。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6 位股票代码，如 600519' },
      limit: { type: 'integer', description: '返回条数，默认 8' },
    },
    required: ['code'],
  },
  available: (ctx) =>
    ctx.config.webSearch.enabled
      ? { ok: true }
      : { ok: false, reason: '联网功能未启用（设置 → 工具）' },
  async run(args, ctx): Promise<ToolResult> {
    const code = asString(args.code).replace(/\D/g, '')
    if (code.length !== 6) {
      return { ok: false, display: '查公告：代码无效', content: '需要 6 位股票代码', error: '代码无效' }
    }
    const limit = Math.min(Math.max(asNumber(args.limit, 8), 1), 30)
    const url =
      'https://np-anotice-stock.eastmoney.com/api/security/ann' +
      `?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${code}`
    try {
      const res = await request(url, {
        headers: { ...BROWSER_HEADERS, Referer: 'https://data.eastmoney.com/' },
        signal: ctx.signal,
        timeoutMs: 15000,
      })
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`)
      const data = (res.json ?? JSON.parse(res.text)) as {
        data?: { list?: { title?: string; notice_date?: string; art_code?: string }[] }
      }
      const list = data.data?.list ?? []
      if (!list.length) {
        return {
          ok: true,
          display: `查公告 ${code}：无`,
          summary: '0 条',
          content: `股票 ${code} 没有查到公告。请如实告知用户。`,
        }
      }
      const body = list
        .map(
          (r, i) =>
            `${i + 1}. [${(r.notice_date ?? '').slice(0, 10)}] ${r.title ?? ''}\n` +
            `   https://data.eastmoney.com/notices/detail/${code}/${r.art_code ?? ''}.html`,
        )
        .join('\n')
      return {
        ok: true,
        display: `查公告 ${code}：${list.length} 条`,
        summary: `${list.length} 条`,
        detail: body,
        content:
          `股票 ${code} 的近期公告（来源：东方财富）：\n\n${body}\n\n` +
          '请注明日期，并提醒用户以交易所原文为准。',
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        display: `查公告失败：${msg.slice(0, 50)}`,
        error: msg,
        content: `查询 ${code} 公告失败：${msg}`,
      }
    }
  },
}

export const webTools: ToolDef[] = [webSearchTool, fetchPageTool, announcementTool]
