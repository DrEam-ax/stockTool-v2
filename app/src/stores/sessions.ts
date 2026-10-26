/**
 * 会话：多会话 + 每个会话独立的「是否共享全局记忆」开关。
 *
 * 开关的语义必须清晰，这是用户能信任这个功能的前提：
 *   开 —— AI 看得到你的持仓与画像，回答会针对你的仓位
 *   关 —— AI 看不到任何个人信息，只做纯粹的标的分析
 * 所以关掉时，提示词里会明确写「用户已关闭全局记忆」，
 * 而不是仅仅不喂数据 —— 避免模型自己去猜、去假设用户持有。
 */

import { computed, ref } from 'vue'
import type { ChatMessage, KnowledgeBase, ParallelSide, Session, ToolCallRecord } from '@/types'
import * as db from '@/lib/db'
import { nowIso, uid } from '@/lib/fmt'
import type { LlmMessage } from '@/services/llm'
import { buildSystemPrompt, buildAnalystSystemPrompt, type MemoryContext } from '@/services/prompt'
import { runAgent, type ToolCallDetail } from '@/services/agent'
import { activeTools } from '@/services/tools'
import type { ToolContext } from '@/services/tools/types'
import { fetchQuoteSnapshot, resolveSymbol } from '@/services/tools/market'
import { useProviders } from './providers'
import { useKnowledge } from './knowledge'
import { useMemory } from './memory'
import { useTools } from './tools'

const sessions = ref<Session[]>([])
const loaded = ref(false)
const streamingId = ref<string | null>(null)
/** 上次打开的会话 id：从其它模块点回「会话」时用它落回原处 */
const lastSessionId = ref<string | null>(null)
let abortController: AbortController | null = null

export function newSession(patch: Partial<Session> = {}): Session {
  const now = nowIso()
  return {
    id: uid('ss_'),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    useGlobalMemory: true,
    activeKbIds: [],
    mode: 'research',
    personaAuthorUid: null,
    focusSubject: null,
    messages: [],
    ...patch,
  }
}

const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 12000

/**
 * 决定发问时给哪个标的做行情快照：
 * 优先消息里出现的 6 位代码，其次会话的「聚焦标的」；都没有就不做。
 */
export function pickSnapshotSymbol(
  text: string,
  s: Session,
  kbs: KnowledgeBase[],
): string | null {
  const code = /(?<!\d)(\d{6})(?!\d)/.exec(text)?.[1]
  const probe = code ?? s.focusSubject?.name ?? ''
  if (!probe) return null
  return resolveSymbol(probe, { kbs } as ToolContext)
}

export function useSessions() {
  const { defaultProvider, load: loadProviders } = useProviders()
  const knowledge = useKnowledge()
  const memory = useMemory()
  const tools = useTools()

  async function load() {
    if (loaded.value) return
    await Promise.all([loadProviders(), knowledge.load(), memory.load(), tools.load()])
    sessions.value = (await db.getAll<Session>(db.STORES.sessions)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
    loaded.value = true
  }

  async function create(patch: Partial<Session> = {}): Promise<Session> {
    const s = newSession(patch)
    await db.put(db.STORES.sessions, s)
    sessions.value.unshift(s)
    lastSessionId.value = s.id
    return s
  }

  /** 记下「上次在看的会话」。
   *
   * 为什么需要：底栏的「会话」原来固定跳列表页，
   * 于是「进会话 → 去记忆页 → 点回会话」会把人踢回列表，得重新找。
   * 记住 id 之后，从其它模块点回来能直接落回原来那个会话。 */
  function markOpened(id: string | null) {
    lastSessionId.value = id
  }

  async function save(s: Session) {
    s.updatedAt = nowIso()
    await db.put(db.STORES.sessions, s)
    const i = sessions.value.findIndex((x) => x.id === s.id)
    if (i > 0) {
      sessions.value.splice(i, 1)
      sessions.value.unshift(s)
    } else if (i < 0) {
      sessions.value.unshift(s)
    }
  }

  async function remove(id: string) {
    // 先同步更新内存（UI 立即反馈、行收起不卡），再异步落盘。
    // 顺序反过来会在慢速 IndexedDB 上让界面滞后于用户操作。
    sessions.value = sessions.value.filter((s) => s.id !== id)
    await db.remove(db.STORES.sessions, id)
  }

  async function clearMessages(s: Session) {
    s.messages = []
    await save(s)
  }

  function find(id: string): Session | undefined {
    return sessions.value.find((s) => s.id === id)
  }

  /** 截断后的历史消息（不含当前这句提问 —— runAgent 会自己拼上）。
   *  对比请教（parallel）消息是"双轨演示"，不进入后续上下文，
   *  避免两套回答互相污染之后的对话。 */
  function buildHistory(s: Session): LlmMessage[] {
    const usable = s.messages.filter(
      (m) => !m.pending && !m.error && m.content && !m.parallel,
    )
    const recent = usable.slice(-MAX_HISTORY_MESSAGES)

    let budget = MAX_HISTORY_CHARS
    const kept: ChatMessage[] = []
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i]
      const cost = (m.content?.length ?? 0) + (m.images?.length ?? 0) * 800
      if (budget - cost < 0 && kept.length) break
      budget -= cost
      kept.unshift(m)
    }

    return kept.map((m) =>
      m.role === 'user' && m.images?.length
        ? {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: m.content || '请分析这张图' },
              ...m.images.map((url) => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          }
        : {
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: m.content,
          },
    )
  }

  function memoryContextFor(s: Session): MemoryContext | null {
    if (!s.useGlobalMemory) return null
    if (!memory.hasMemory.value) return null
    return {
      profile: memory.profile.value ?? {
        preferredHorizons: [],
        sectorFocus: [],
        styleTags: [],
        notes: '',
        updatedAt: nowIso(),
      },
      holdings: memory.holdings.value,
      facts: memory.facts.value,
    }
  }

  /** 真正发送。走 Agent 循环，工具调用实时反映到消息上。 */
  async function send(
    sessionId: string,
    text: string,
    images: string[] = [],
  ): Promise<void> {
    const s = find(sessionId)
    if (!s) throw new Error('会话不存在')
    const provider = defaultProvider.value
    if (!provider) throw new Error('还没有配置模型，请先到「设置 → 模型」添加一个')

    const kbs: KnowledgeBase[] = knowledge.resolve(s.activeKbIds)
    const memCtx = memoryContextFor(s)

    // 工具是否真的可用，决定提示词里"先查证"的口径：
    // 有工具却说"这需要查证"会浪费能力，没工具却说"先调用工具"会让模型硬编。
    const mode = s.mode ?? 'research'
    const toolCtx = {
      kbs,
      config: tools.config.value,
      holdings: memCtx?.holdings ?? [],
      allowOnline: Boolean(s.allowOnline),
    }
    const hasTools = activeTools(toolCtx).length > 0

    const systemPrompt = buildSystemPrompt({
      kbs,
      question: text,
      memory: memCtx,
      focusSubject: s.focusSubject ?? null,
      mode,
      personaAuthorUid: s.personaAuthorUid ?? null,
      auditContext: s.auditContext,
      hasTools,
      allowOnline: Boolean(s.allowOnline),
    })

    // 历史必须在 push 当前提问之前取
    const history = buildHistory(s)

    const userMsg: ChatMessage = {
      id: uid('m_'),
      role: 'user',
      content: text,
      images: images.length ? images : undefined,
      createdAt: nowIso(),
    }
    s.messages.push(userMsg)

    // 提问时刻行情快照：发问那分钟的价格存档，事后可回看。
    // 异步拉取、失败静默跳过 —— 快照绝不能阻塞发送。
    const snapSymbol = pickSnapshotSymbol(text, s, kbs)
    if (snapSymbol) {
      void fetchQuoteSnapshot(snapSymbol)
        .then((snap) => {
          if (snap) {
            userMsg.snapshot = snap
            return save(s)
          }
        })
        .catch(() => {})
    }

    if (s.messages.filter((m) => m.role === 'user').length === 1) {
      s.title = text.slice(0, 24) || '图片分析'
    }

    const assistant: ChatMessage = {
      id: uid('m_'),
      role: 'assistant',
      content: '',
      createdAt: nowIso(),
      providerName: provider.name,
      model: provider.model,
      usedKb: kbs.map((k) => ({
        id: k.id,
        title: k.manifest.title,
        author: k.author?.name ?? '',
      })),
      usedMemory: Boolean(memCtx),
      mode,
      toolCalls: [],
      pending: true,
    }
    s.messages.push(assistant)
    await save(s)

    streamingId.value = s.id
    abortController = new AbortController()

    const recordIndex = new Map<string, ToolCallRecord>()

    try {
      const result = await runAgent({
        provider,
        systemPrompt,
        history,
        question: text,
        questionImages: images,
        ctx: {
          ...toolCtx,
          signal: abortController.signal,
        },
        maxRounds: tools.config.value.maxRounds,
        signal: abortController.signal,
        callbacks: {
          onAnswerDelta: (chunk) => {
            assistant.content += chunk
          },
          onThinking: (t) => {
            // 这一轮是工具轮，刚才流出去的文本不是答案 —— 收回到 thinking
            assistant.content = ''
            assistant.thinking = assistant.thinking
              ? `${assistant.thinking}\n\n${t}`
              : t
          },
          onToolStart: (call: ToolCallDetail) => {
            const rec: ToolCallRecord = {
              id: call.id,
              name: call.name,
              display: `正在${call.title}…`,
              args: call.args,
              ok: false,
              ms: 0,
            }
            recordIndex.set(call.id, rec)
            assistant.toolCalls = [...(assistant.toolCalls ?? []), rec]
          },
          onToolEnd: (call: ToolCallDetail) => {
            const rec = recordIndex.get(call.id)
            if (!rec) return
            rec.display = call.display
            rec.ok = call.ok
            rec.summary = call.summary
            rec.error = call.error
            rec.ms = call.ms
            rec.detail = call.content.slice(0, 1200)
            assistant.toolCalls = [...(assistant.toolCalls ?? [])]
          },
        },
      })

      assistant.content = result.answer || assistant.content
      assistant.thinking = result.thinking || assistant.thinking
      assistant.hitRoundLimit = result.hitRoundLimit
      assistant.usage = result.usage
      assistant.pending = false
    } catch (e) {
      assistant.pending = false
      // 用户主动停止不是错误：标记 aborted，UI 显示「已停止」而非红条
      if (isAbort(e)) {
        assistant.aborted = true
      } else {
        assistant.error = e instanceof Error ? e.message : String(e)
      }
    } finally {
      streamingId.value = null
      abortController = null
      await save(s)
    }
  }

  /** 判断异常是不是「用户主动停止」（AbortError / 我们抛的 DOMException） */
  function isAbort(e: unknown): boolean {
    if (e instanceof DOMException && e.name === 'AbortError') return true
    if (e instanceof Error && /aborted|AbortError|已取消/i.test(e.message)) return true
    return false
  }

  function abort() {
    abortController?.abort()
  }

  /**
   * 对比请教：同一问题生成**两套互不影响**的回答——
   *   · 军师侧（advisor）：走知识库 persona / 研究模式，用大V的决策框架回答
   *   · 专业分析侧（analyst）：不带知识库，用「专业金融分析师」自带提示词，
   *     基于通用金融逻辑 + 工具查到的真实数据分析
   * 两套并行生成、各自记录工具调用；结果都挂在同一条 parallel 消息里，
   * 由用户通过右侧切换按钮切换显示。
   */
  async function sendCompare(
    sessionId: string,
    text: string,
    images: string[] = [],
  ): Promise<void> {
    const s = find(sessionId)
    if (!s) throw new Error('会话不存在')
    const provider = defaultProvider.value
    if (!provider) throw new Error('还没有配置模型，请先到「设置 → 模型」添加一个')

    const kbs: KnowledgeBase[] = knowledge.resolve(s.activeKbIds)
    const memCtx = memoryContextFor(s)
    const mode = s.mode ?? 'research'
    const toolCtx = {
      kbs,
      config: tools.config.value,
      holdings: memCtx?.holdings ?? [],
      allowOnline: Boolean(s.allowOnline),
    }
    const hasTools = activeTools(toolCtx).length > 0

    const advisorSystem = buildSystemPrompt({
      kbs,
      question: text,
      memory: memCtx,
      focusSubject: s.focusSubject ?? null,
      mode,
      personaAuthorUid: s.personaAuthorUid ?? null,
      auditContext: s.auditContext,
      hasTools,
      allowOnline: Boolean(s.allowOnline),
    })
    const analystSystem = buildAnalystSystemPrompt({
      question: text,
      memory: memCtx,
      focusSubject: s.focusSubject ?? null,
      hasTools,
      allowOnline: Boolean(s.allowOnline),
    })

    // 历史必须在 push 当前提问之前取
    const history = buildHistory(s)

    const userMsg: ChatMessage = {
      id: uid('m_'),
      role: 'user',
      content: text,
      images: images.length ? images : undefined,
      createdAt: nowIso(),
    }
    s.messages.push(userMsg)
    if (s.messages.filter((m) => m.role === 'user').length === 1) {
      s.title = text.slice(0, 24) || '图片分析'
    }

    const assistant: ChatMessage = {
      id: uid('m_'),
      role: 'assistant',
      content: '',
      createdAt: nowIso(),
      providerName: provider.name,
      model: provider.model,
      usedKb: kbs.map((k) => ({
        id: k.id,
        title: k.manifest.title,
        author: k.author?.name ?? '',
      })),
      usedMemory: Boolean(memCtx),
      mode,
      toolCalls: [],
      pending: true,
      parallel: {
        advisor: { content: '', toolCalls: [] },
        analyst: { content: '', toolCalls: [] },
        active: 'advisor',
      },
    }
    s.messages.push(assistant)
    await save(s)

    streamingId.value = s.id
    abortController = new AbortController()

    /** 给某一侧跑完整 Agent 循环，流式回调只写该侧，互不影响 */
    async function runOne(side: ParallelSide, system: string) {
      const recordIndex = new Map<string, ToolCallRecord>()
      try {
        const result = await runAgent({
          provider,
          systemPrompt: system,
          history,
          question: text,
          questionImages: images,
          ctx: { ...toolCtx, signal: abortController!.signal },
          maxRounds: tools.config.value.maxRounds,
          signal: abortController!.signal,
          callbacks: {
            onAnswerDelta: (chunk) => {
              side.content += chunk
            },
            onThinking: (t) => {
              side.content = ''
              side.thinking = side.thinking ? `${side.thinking}\n\n${t}` : t
            },
            onToolStart: (call) => {
              const rec: ToolCallRecord = {
                id: call.id,
                name: call.name,
                display: `正在${call.title}…`,
                args: call.args,
                ok: false,
                ms: 0,
              }
              recordIndex.set(call.id, rec)
              side.toolCalls = [...(side.toolCalls ?? []), rec]
            },
            onToolEnd: (call) => {
              const rec = recordIndex.get(call.id)
              if (!rec) return
              rec.display = call.display
              rec.ok = call.ok
              rec.summary = call.summary
              rec.error = call.error
              rec.ms = call.ms
              rec.detail = call.content.slice(0, 1200)
              side.toolCalls = [...(side.toolCalls ?? [])]
            },
          },
        })
        side.content = result.answer || side.content
        side.thinking = result.thinking || side.thinking
        side.hitRoundLimit = result.hitRoundLimit
        side.usage = result.usage
      } catch (e) {
        // 用户主动停止：两侧都标记「已停止」，不显示为错误
        if (isAbort(e)) {
          assistant.aborted = true
          side.aborted = true
        } else {
          side.error = e instanceof Error ? e.message : String(e)
        }
      }
    }

    const parallel = assistant.parallel! // 上面刚赋值，一定存在
    try {
      // 两套并行生成，互不影响
      await Promise.all([runOne(parallel.advisor, advisorSystem), runOne(parallel.analyst, analystSystem)])
    } finally {
      assistant.pending = false
      streamingId.value = null
      abortController = null
      await save(s)
    }
  }

  /** 重试最后一条失败的回答 */
  async function retryLast(sessionId: string): Promise<void> {
    const s = find(sessionId)
    if (!s) return
    const lastUser = [...s.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    const idx = s.messages.indexOf(lastUser)
    const text = lastUser.content
    const images = lastUser.images ?? []
    s.messages.splice(idx)
    await save(s)
    await send(sessionId, text, images)
  }

  const isStreaming = computed(() => streamingId.value !== null)

  return {
    sessions,
    loaded,
    streamingId,
    isStreaming,
    lastSessionId,
    markOpened,
    load,
    create,
    save,
    remove,
    clearMessages,
    find,
    send,
    sendCompare,
    abort,
    retryLast,
  }
}
