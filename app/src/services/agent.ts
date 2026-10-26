/**
 * Agent 循环：让 AI 自己决定调用哪些工具、调几次。
 *
 * 几个关键决定：
 *
 * 1. **工具调用必须可见。** 每条工具调用都会作为记录留在消息里，
 *    用户能看到 AI 查了什么、查到了几条。这是判断答案可信度的唯一依据，
 *    也是防幻觉最有效的手段 —— 模型编造时，那一栏会是空的。
 *
 * 2. **有轮数上限。** 默认 9 轮。没有上限的 Agent 会在模型犯轴时
 *    无限调用工具烧 token，而用户只能看着进度条转。
 *    但也不能太小：一次"自己去看行情再推荐"的任务实测就会用掉十几个工具调用，
 *    6 轮完全不够 —— 会出现「工具全跑完了、却没留下写答案的轮次」，
 *    用户只看到一句"已到上限，可能不完整"而看不到任何结论。
 *
 * 3. **工具失败不是错误。** 失败结果照样回给模型，并在提示里明确
 *    「如实告知用户拿不到，不要编造」。断网时模型仍能基于知识库回答。
 *
 * 4. **工具轮里的"思考文本"单独存放。** 模型常常先说一句
 *    「让我查一下最新价格」，然后才发起调用。这段文字不是答案，
 *    混进正文会让人误以为那就是回答。
 */

import type { ModelProvider, ToolCallRecord } from '@/types'
import { chat, abortError, type LlmMessage, type ToolSchema } from './llm'
import { activeTools, availabilityNote, toolByName, toSchemas, type ToolContext } from './tools'

export interface ToolCallDetail {
  id: string
  name: string
  title: string
  args: Record<string, unknown>
  ok: boolean
  display: string
  summary?: string
  error?: string
  ms: number
  /** 回给模型的完整内容，便于排查 */
  content: string
}

export interface AgentCallbacks {
  /** 最终答案的流式增量 */
  onAnswerDelta?: (chunk: string) => void
  /** 工具轮里的思考文本（不是答案） */
  onThinking?: (text: string) => void
  onToolStart?: (call: ToolCallDetail) => void
  onToolEnd?: (call: ToolCallDetail) => void
  onRound?: (round: number) => void
}

export interface AgentOptions {
  provider: ModelProvider
  systemPrompt: string
  history: LlmMessage[]
  question: string
  questionImages?: string[]
  ctx: ToolContext
  maxRounds?: number
  signal?: AbortSignal
  callbacks?: AgentCallbacks
}

export interface AgentResult {
  answer: string
  thinking: string
  toolCalls: ToolCallRecord[]
  rounds: number
  usage: { prompt: number; completion: number }
  hitRoundLimit: boolean
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const cb = opts.callbacks ?? {}
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? opts.ctx.config.maxRounds ?? 6, 12))

  const usable = activeTools(opts.ctx)
  const schemas: ToolSchema[] = usable.length ? toSchemas(usable) : []

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `${opts.systemPrompt}\n\n## 可用工具\n${availabilityNote(opts.ctx)}`,
    },
    ...opts.history,
  ]

  // 当前问题（可能带图）
  if (opts.questionImages?.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: opts.question || '请分析这张图' },
        ...opts.questionImages.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      ],
    })
  } else {
    messages.push({ role: 'user', content: opts.question })
  }

  const records: ToolCallRecord[] = []
  const thinkingParts: string[] = []
  const usage = { prompt: 0, completion: 0 }
  let answer = ''
  let rounds = 0

  for (let round = 1; round <= maxRounds; round++) {
    // 用户点了「停止」：立刻停，别再去问模型/跑工具
    if (opts.signal?.aborted) throw abortError()
    rounds = round
    cb.onRound?.(round)

    let roundText = ''
    const res = await chat(opts.provider, {
      messages,
      tools: schemas.length ? schemas : undefined,
      toolChoice: schemas.length ? 'auto' : 'none',
      signal: opts.signal,
      onDelta: (chunk) => {
        roundText += chunk
        // 先当答案流出去；若这一轮其实是工具轮，下面会把它挪到 thinking
        cb.onAnswerDelta?.(chunk)
      },
    })
    // chat 返回后也可能已被中止（服务端恰好发完）：同样直接停
    if (opts.signal?.aborted) throw abortError()

    usage.prompt += res.usage?.prompt ?? 0
    usage.completion += res.usage?.completion ?? 0

    if (!res.toolCalls.length) {
      answer = res.text || roundText
      if (answer.trim() && answer !== roundText) cb.onAnswerDelta?.(answer)
      return {
        answer,
        thinking: thinkingParts.join('\n\n'),
        toolCalls: records,
        rounds,
        usage,
        hitRoundLimit: false,
      }
    }

    // 这一轮是工具轮：把刚流出去的文本收回成"思考"
    if (roundText.trim()) {
      thinkingParts.push(roundText.trim())
      cb.onThinking?.(roundText.trim())
    }

    messages.push({
      role: 'assistant',
      content: res.text || null,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsText || '{}' },
      })),
    })

    for (const tc of res.toolCalls) {
      // 停止信号来了：不再执行下一个工具
      if (opts.signal?.aborted) throw abortError()
      const tool = toolByName(tc.name)
      const t0 = performance.now()
      const detail: ToolCallDetail = {
        id: tc.id,
        name: tc.name,
        title: tool?.title ?? tc.name,
        args: tc.args,
        ok: false,
        display: tool ? `${tool.title}…` : `未知工具 ${tc.name}`,
        ms: 0,
        content: '',
      }
      cb.onToolStart?.(detail)

      if (!tool) {
        detail.ok = false
        detail.error = `工具 ${tc.name} 不存在`
        detail.display = `未知工具 ${tc.name}`
        detail.content = `错误：不存在名为 ${tc.name} 的工具。请改用可用工具，或直接回答。`
      } else {
        try {
          const r = await tool.run(tc.args, opts.ctx)
          detail.ok = r.ok
          detail.display = r.display
          detail.summary = r.summary
          detail.error = r.error
          detail.content = r.content
        } catch (e) {
          // ⭐ 中止不是「工具失败」：信号已断就向上抛，让整个 Agent 立刻停，
          // 不要再记录一条失败结果、继续问模型（那样看起来像「还在跑」）。
          if (opts.signal?.aborted) throw abortError()
          const msg = e instanceof Error ? e.message : String(e)
          detail.ok = false
          detail.error = msg
          detail.display = `${tool.title} 失败：${msg.slice(0, 50)}`
          detail.content = `工具执行异常：${msg}`
        }
      }
      detail.ms = Math.round(performance.now() - t0)
      cb.onToolEnd?.(detail)

      records.push({
        id: detail.id,
        name: detail.name,
        display: detail.display,
        args: detail.args,
        ok: detail.ok,
        summary: detail.summary,
        error: detail.error,
        ms: detail.ms,
        detail: detail.content.slice(0, 1200),
      })

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: detail.content || '（无内容）',
      })
    }
  }

  // 轮数用尽：让模型基于已有工具结果做最后一次纯文本总结
  if (opts.signal?.aborted) throw abortError()
  messages.push({
    role: 'user',
    content:
      '已达到工具调用轮数上限。请基于上面已获得的信息直接给出最终回答，' +
      '不要再请求调用工具。若信息不足，如实说明。',
  })
  let finalText = ''
  const finalRes = await chat(opts.provider, {
    messages,
    signal: opts.signal,
    onDelta: (c) => {
      finalText += c
      cb.onAnswerDelta?.(c)
    },
  })
  usage.prompt += finalRes.usage?.prompt ?? 0
  usage.completion += finalRes.usage?.completion ?? 0
  answer = finalRes.text || finalText

  // 兜底：收尾那次也可能什么都没返回（模型超时/被截断/返回空）。
  // 这时不能让用户面对一个空回答 + 一句"不完整"，至少把已查到的东西列出来。
  if (!answer.trim()) {
    const lines = ['（模型没有给出完整回答，下面是这次已经查到的结果）', '']
    for (const r of records) {
      lines.push(`- ${r.display}${r.summary ? `：${r.summary}` : ''}`)
    }
    if (!records.length) lines.push('- 没有成功调用任何工具')
    answer = lines.join('\n')
  }

  return {
    answer,
    thinking: thinkingParts.join('\n\n'),
    toolCalls: records,
    rounds,
    usage,
    hitRoundLimit: true,
  }
}
