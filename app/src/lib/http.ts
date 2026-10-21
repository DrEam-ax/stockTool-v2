/**
 * HTTP 抽象层。
 *
 * 为什么需要这一层：**CORS**。
 * 行情接口（腾讯/东财）、新闻页、多数搜索 API 都不返回
 * Access-Control-Allow-Origin，浏览器里 fetch 会被直接拦掉。
 *
 * 三种运行环境，行为完全不同：
 *   1. 浏览器开发模式 —— 普通 fetch，很多接口用不了（会明确报错，不静默失败）
 *   2. Capacitor 打包后 —— `CapacitorHttp.enabled: true` 会**直接 patch window.fetch**，
 *      走原生 HTTP，没有 CORS 限制。业务代码不用改，也不用在这里注册什么。
 *   3. 用户配了自建代理 —— 走代理
 *
 * 注意：原生 HTTP 不提供可读流（SSE 会退化成整段返回），
 * services/llm.ts 已做兼容。
 */

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** 有些接口返回 GBK，需要按指定编码解（浏览器 TextDecoder 支持 gbk） */
  encoding?: string
  timeoutMs?: number
}

export interface HttpResult {
  ok: boolean
  status: number
  text: string
  json?: unknown
  /** 失败时的人话说明（区分 CORS / 网络 / HTTP 错误） */
  error?: string
  errorKind?: 'cors' | 'network' | 'http' | 'timeout' | 'parse'
}

/** 运行环境判定 */
export function runtime(): 'browser' | 'capacitor' {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return w.Capacitor?.isNativePlatform?.() ? 'capacitor' : 'browser'
}

/**
 * Capacitor 原生 HTTP 的挂载点。
 * 打包后在 main.ts 里注入实现，业务代码不用改。
 */
export type NativeHttpImpl = (url: string, opts: HttpOptions) => Promise<HttpResult>
let nativeHttp: NativeHttpImpl | null = null

export function registerNativeHttp(impl: NativeHttpImpl): void {
  nativeHttp = impl
}

export async function httpGet(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  return request(url, { ...opts, method: opts.method ?? 'GET' })
}

export async function request(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  if (nativeHttp && runtime() === 'capacitor') {
    return nativeHttp(url, opts)
  }

  const timeoutMs = opts.timeoutMs ?? 15000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
      // 原生（Capacitor 的 fetch patch）不认 mode，
      // 传了也无害但语义上不该传 —— 原生根本没有同源策略。
      ...(runtime() === 'browser' ? { mode: 'cors' as RequestMode } : {}),
    })
    const buf = await res.arrayBuffer()
    const text = decode(buf, opts.encoding, res.headers.get('content-type'))
    let json: unknown
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) {
      try {
        json = JSON.parse(text)
      } catch {
        /* 交给调用方处理 */
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
      error: res.ok ? undefined : `HTTP ${res.status}`,
      errorKind: res.ok ? undefined : 'http',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/abort/i.test(msg)) {
      return {
        ok: false,
        status: 0,
        text: '',
        error: /timeout/i.test(String(opts.signal?.reason ?? '')) ? '请求超时' : '已取消',
        errorKind: 'timeout',
      }
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return {
        ok: false,
        status: 0,
        text: '',
        error:
          '跨域(CORS)或网络被拦。该接口不允许网页直连 —— ' +
          '打包成 App 后走原生 HTTP 就没有这个限制。',
        errorKind: 'cors',
      }
    }
    return { ok: false, status: 0, text: '', error: msg, errorKind: 'network' }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function decode(buf: ArrayBuffer, encoding: string | undefined, contentType: string | null): string {
  const enc =
    encoding ||
    (/charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(enc).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 从 HTML 里抽正文文本（够用即可，不引 readability） */
export function htmlToText(html: string, maxChars = 6000): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  s = s.replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  s = lines.join('\n')
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s
}
