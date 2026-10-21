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
import type { ChatMessage, KnowledgeBase, Session, ToolCallRecord } from '@/types'
import * as db from '@/lib/db'
import { nowIso, uid } from '@/lib/fmt'
import type { LlmMessage } from '@/services/llm'
import { buildSystemPrompt, type MemoryContext } from '@/services/prompt'
import { runAgent, type ToolCallDetail } from '@/services/agent'
import { activeTools } from '@/services/tools'
import { useProviders } from './providers'
import { useKnowledge } from './knowledge'
import { useMemory } from './memory'
import { useTools } from './tools'

const sessions = ref<Session[]>([])
const loaded = ref(false)
const streamingId = ref<string | null>(null)
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
    return s
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
    await db.remove(db.STORES.sessions, id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
  }

  async function clearMessages(s: Session) {
    s.messages = []
    await save(s)
  }

  function find(id: string): Session | undefined {
    return sessions.value.find((s) => s.id === id)
  }

  /** 截断后的历史消息（不含当前这句提问 —— runAgent 会自己拼上） */
  function buildHistory(s: Session): LlmMessage[] {
    const usable = s.messages.filter((m) => !m.pending && !m.error && m.content)
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
    const hasTools = activeTools({ kbs, config: tools.config.value }).length > 0

    const systemPrompt = buildSystemPrompt({
      kbs,
      question: text,
      memory: memCtx,
      focusSubject: s.focusSubject ?? null,
      mode,
      personaAuthorUid: s.personaAuthorUid ?? null,
      auditContext: s.auditContext,
      hasTools,
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
          kbs,
          config: tools.config.value,
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
      assistant.error = e instanceof Error ? e.message : String(e)
    } finally {
      streamingId.value = null
      abortController = null
      await save(s)
    }
  }

  function abort() {
    abortController?.abort()
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
    load,
    create,
    save,
    remove,
    clearMessages,
    find,
    send,
    abort,
    retryLast,
  }
}
