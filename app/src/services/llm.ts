/**
 * OpenAI 兼容的 LLM 客户端（支持 function calling）。
 *
 * 只依赖 fetch，不引第三方 SDK —— 因为「用户自己填 baseUrl + key」
 * 意味着必须兼容尽可能多的服务（DeepSeek / 通义 / Kimi / 本地 vLLM / Ollama…），
 * 而它们都实现了 /chat/completions。
 *
 * 工具调用走原生 function calling 协议。流式响应里 tool_calls 的
 * arguments 是**分片到达**的，必须按 index 累积后再解析 —— 这是最容易写错的地方。
 */

import type { ModelProvider, ProviderCheck } from '@/types'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}
export type ContentPart = TextPart | ImagePart

export interface ToolCallPayload {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LlmMessage {
  role: Role
  content: string | ContentPart[] | null
  /** assistant 消息里请求调用的工具 */
  tool_calls?: ToolCallPayload[]
  /** role=tool 时必填，指回对应的 tool_call */
  tool_call_id?: string
  name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串；模型偶尔会给出坏 JSON，所以保留原文 */
  argsText: string
  args: Record<string, unknown>
}

export interface ChatOptions {
  messages: LlmMessage[]
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  tools?: ToolSchema[]
  toolChoice?: 'auto' | 'none'
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  usage?: { prompt: number; completion: number }
  model?: string
  finishReason?: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'auth' | 'network' | 'cors' | 'format' | 'unknown' = 'unknown',
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

function normalizeBase(baseUrl: string): string {
  let b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new LlmError('baseUrl 为空', undefined, 'format')
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`
  b = b.replace(/\/chat\/completions$/i, '')
  return b
}

function headers(p: ModelProvider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`
  return h
}

function translateError(e: unknown, baseUrl: string): LlmError {
  if (e instanceof LlmError) return e
  const msg = e instanceof Error ? e.message : String(e)
  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    return new LlmError(
      `无法连接到 ${baseUrl}。\n` +
        '可能原因：\n' +
        '1) baseUrl 写错（注意填到 /v1 为止，不要带 /chat/completions）\n' +
        '2) 浏览器跨域(CORS)被拦 —— 部分服务不允许网页直连，\n' +
        '   打包成 App 后没有这个限制\n' +
        '3) 网络不通',
      undefined,
      'cors',
    )
  }
  if (/aborted|AbortError/i.test(msg)) return new LlmError('已取消')
  return new LlmError(msg, undefined, 'network')
}

/** 统一的中止异常：上层（agent/sessions）用 name==='AbortError' 识别「用户主动停止」 */
export function abortError(): DOMException {
  return new DOMException('操作已中止', 'AbortError')
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    try {
      const j = JSON.parse(t)
      return j?.error?.message || j?.message || t.slice(0, 300)
    } catch {
      return t.slice(0, 300)
    }
  } catch {
    return ''
  }
}

/** 解析工具参数。模型可能给出坏 JSON，这里要能兜住而不是整个失败。 */
function parseArgs(text: string): Record<string, unknown> {
  const t = (text || '').trim()
  if (!t) return {}
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    const s = t.indexOf('{')
    const e = t.lastIndexOf('}')
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1)) as Record<string, unknown>
      } catch {
        /* 放弃 */
      }
    }
    return {}
  }
}

export async function chat(
  provider: ModelProvider,
  opts: ChatOptions,
): Promise<ChatResult> {
  const base = normalizeBase(provider.baseUrl)
  const url = `${base}/chat/completions`
  const stream = Boolean(opts.onDelta)

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: opts.messages,
    temperature: opts.temperature ?? provider.temperature ?? 0.3,
  }
  const maxTokens = opts.maxTokens ?? provider.maxTokens
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens
  if (opts.jsonMode && provider.supportsJson) {
    body.response_format = { type: 'json_object' }
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = opts.toolChoice ?? 'auto'
  }
  if (stream) body.stream = true

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    throw translateError(e, base)
  }

  if (!res.ok) {
    const detail = await readErrorBody(res)
    const kind: LlmError['kind'] =
      res.status === 401 || res.status === 403 ? 'auth' : 'unknown'
    throw new LlmError(
      `HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`,
      res.status,
      kind,
    )
  }

  // ---------------- 非流式 ----------------
  if (!stream) {
    const j = await res.json()
    const msg = j?.choices?.[0]?.message ?? {}
    const rawCalls: ToolCallPayload[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const u = j?.usage
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: rawCalls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name ?? '',
        argsText: tc.function?.arguments ?? '',
        args: parseArgs(tc.function?.arguments ?? ''),
      })),
      usage: u
        ? { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 }
        : undefined,
      model: j?.model,
      finishReason: j?.choices?.[0]?.finish_reason,
    }
  }

  // ---------------- 流式 ----------------
  // 先检查中止：signal 已断就不要再发起读取
  if (opts.signal?.aborted) throw abortError()
  const reader = res.body?.getReader?.()
  if (!reader) {
    // 原生 HTTP（Capacitor 的 CapacitorHttp）不提供可读流。
    // 这时整段内容已经拿到了，按 SSE 或普通 JSON 解析即可 ——
    // 结果一样，只是回答会一次性出现而不是逐字蹦。
    const text = await res.text()
    return parseBufferedResponse(text, opts.onDelta)
  }
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let full = ''
  let usage: ChatResult['usage']
  let finishReason: string | undefined
  // tool_calls 的 arguments 分片到达，按 index 累积
  const slots: Record<number, { id: string; name: string; args: string }> = {}

  while (true) {
    // ⭐ 每读一块都查中止：真机上 abort 不一定让 reader.read() 立刻 reject
    // （部分 WebView 会继续吐已缓冲的数据），不查就停不下来、内容继续往外蹦。
    if (opts.signal?.aborted) throw abortError()
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || !line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let j: Record<string, unknown>
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0]
      if (!choice) continue
      const delta = choice.delta as Record<string, unknown> | undefined
      if (delta) {
        const c = delta.content
        if (typeof c === 'string' && c) {
          full += c
          opts.onDelta?.(c)
        }
        const tcs = delta.tool_calls as
          | {
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }[]
          | undefined
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = tc.index ?? 0
            const slot = (slots[idx] ||= { id: '', name: '', args: '' })
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name = tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
          }
        }
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason)
      const u = j.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
      if (u) {
        usage = { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 }
      }
    }
  }

  const toolCalls: ToolCall[] = Object.keys(slots)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((idx) => {
      const s = slots[idx]
      return {
        id: s.id || `call_${idx}`,
        name: s.name,
        argsText: s.args,
        args: parseArgs(s.args),
      }
    })
    .filter((tc) => tc.name)

  return { text: full, toolCalls, usage, finishReason }
}

/** 一次性拿到整段响应时的解析：可能是 SSE 文本，也可能是普通 JSON。 */
function parseBufferedResponse(text: string, onDelta?: (c: string) => void): ChatResult {
  const trimmed = text.trim()

  // 普通 JSON（服务端忽略了 stream 参数）
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed)
      const msg = j?.choices?.[0]?.message ?? {}
      const rawCalls: ToolCallPayload[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (content) onDelta?.(content)
      const u = j?.usage
      return {
        text: content,
        toolCalls: rawCalls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name ?? '',
          argsText: tc.function?.arguments ?? '',
          args: parseArgs(tc.function?.arguments ?? ''),
        })),
        usage: u
          ? { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 }
          : undefined,
        model: j?.model,
        finishReason: j?.choices?.[0]?.finish_reason,
      }
    } catch {
      /* 落到下面按 SSE 处理 */
    }
  }

  // SSE：逐行 data:，按 index 累积 tool_calls
  let full = ''
  let usage: ChatResult['usage']
  let finishReason: string | undefined
  const slots: Record<number, { id: string; name: string; args: string }> = {}

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(payload)
    } catch {
      continue
    }
    const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0]
    if (!choice) continue
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta) {
      const c = delta.content
      if (typeof c === 'string' && c) {
        full += c
        onDelta?.(c)
      }
      const tcs = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0
          const slot = (slots[idx] ||= { id: '', name: '', args: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.args += tc.function.arguments
        }
      }
    }
    if (choice.finish_reason) finishReason = String(choice.finish_reason)
  }

  const toolCalls: ToolCall[] = Object.keys(slots)
    .map(Number)
    .sort((a, b) => a - b)
    .map((idx) => {
      const s = slots[idx]
      return {
        id: s.id || `call_${idx}`,
        name: s.name,
        argsText: s.args,
        args: parseArgs(s.args),
      }
    })
    .filter((tc) => tc.name)

  return { text: full, toolCalls, usage, finishReason }
}

/** 从模型回复里抠出 JSON —— 模型经常加寒暄或 ```json 围栏 */
export function parseJsonLoose<T>(raw: string): T {
  let text = (raw || '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  try {
    return JSON.parse(text) as T
  } catch {
    /* 继续 */
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const s = text.indexOf(open)
    const e = text.lastIndexOf(close)
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1)) as T
      } catch {
        /* 试下一种 */
      }
    }
  }
  throw new LlmError('模型没有返回可解析的 JSON', undefined, 'format')
}

export async function chatJson<T>(
  provider: ModelProvider,
  opts: Omit<ChatOptions, 'onDelta' | 'tools'>,
): Promise<{ data: T; raw: string }> {
  const res = await chat(provider, { ...opts, jsonMode: true })
  return { data: parseJsonLoose<T>(res.text), raw: res.text }
}

export async function testProvider(provider: ModelProvider): Promise<ProviderCheck> {
  const t0 = performance.now()
  try {
    await chat(provider, {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      temperature: 0,
    })
    return { ok: true, message: '连接正常', latencyMs: Math.round(performance.now() - t0) }
  } catch (e) {
    const err = e as LlmError
    return { ok: false, message: err.message, latencyMs: Math.round(performance.now() - t0) }
  }
}

export async function listModels(provider: ModelProvider): Promise<string[]> {
  const base = normalizeBase(provider.baseUrl)

  // 没 key 就直接说清楚。之前会带着空 Authorization 去请求，
  // 拿到 401，然后报「该服务可能不提供 /models 接口」—— 完全误导用户。
  if (!(provider.apiKey || '').trim()) {
    throw new LlmError('还没有填 API Key。填好后再拉取模型列表。', undefined, 'auth')
  }

  // 有些服务只在 /v1 下暴露 /models，而用户可能只填了主机名。
  const candidates = [base]
  if (!/\/v\d+$/i.test(base)) candidates.push(`${base}/v1`)

  let lastErr: LlmError | null = null
  const tried: string[] = []

  for (const b of candidates) {
    tried.push(`${b}/models`)
    let res: Response
    try {
      res = await fetch(`${b}/models`, { headers: headers(provider) })
    } catch (e) {
      lastErr = translateError(e, b)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        `API Key 被拒绝（HTTP ${res.status}）。\n` +
          '请检查：Key 是否复制完整、是否已过期、账户是否有余额。',
        res.status,
        'auth',
      )
    }
    if (!res.ok) {
      lastErr = new LlmError(`HTTP ${res.status}`, res.status)
      continue
    }
    let j: { data?: unknown; models?: unknown }
    try {
      j = await res.json()
    } catch {
      lastErr = new LlmError('返回的不是 JSON', res.status, 'format')
      continue
    }
    const arr = (j.data ?? j.models ?? []) as { id?: string; name?: string }[]
    const out = (Array.isArray(arr) ? arr : [])
      .map((m) => m.id || m.name || '')
      .filter(Boolean)
    if (out.length) return out
    lastErr = new LlmError('接口返回了空的模型列表', res.status, 'format')
  }

  throw new LlmError(
    `${lastErr?.message || '拉取失败'}。\n` +
      `已尝试：${tried.join('、')}\n` +
      '若该服务确实不提供 /models 接口，**直接手填模型名即可**，不影响使用。',
    lastErr?.status,
  )
}

/** 探测服务是否支持 function calling（发一个最小工具定义） */
export async function probeToolSupport(provider: ModelProvider): Promise<boolean> {
  try {
    const res = await chat(provider, {
      messages: [{ role: 'user', content: '调用 ping 工具' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ping',
            description: '测试用',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      toolChoice: 'auto',
      maxTokens: 64,
      temperature: 0,
    })
    return res.toolCalls.length > 0 || res.finishReason !== undefined
  } catch {
    return false
  }
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

export async function compressImage(
  dataUrl: string,
  maxEdge = 1400,
  quality = 0.82,
): Promise<string> {
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
  if (scale >= 1 && dataUrl.length < 400_000) return dataUrl
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}
