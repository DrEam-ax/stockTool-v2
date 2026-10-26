/**
 * 「停止」按钮的 Agent 层回归测试。
 *
 * 用户反馈：不小心发出消息后按「停止」却还在跑。根因是 Agent 循环
 * 只在 LLM 的 fetch 里挂了 signal —— 而 fetch 被中止不等于循环会停：
 *  · 流式读取不检查 signal（reader 还会吐已缓冲的数据）
 *  · chat 返回后、工具执行前不检查 signal（中止被当成「工具失败」继续下一轮）
 * 这里钉住 runAgent 对 signal 的三处检查。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAgent } from '@/services/agent'
import type { ToolContext } from '@/services/tools/types'

// 用 mock 的 chat 控制每一轮返回什么，才能真正测「abort 发生在哪一步」
vi.mock('@/services/llm', async (orig) => {
  const actual = await orig()
  return { ...actual, chat: vi.fn() }
})
import { chat, abortError } from '@/services/llm'
const chatMock = vi.mocked(chat)

const ctx: ToolContext = {
  kbs: [],
  config: {
    maxRounds: 3,
    kb: { enabled: false },
    market: { enabled: false },
    webSearch: { enabled: false },
  } as never,
  holdings: [],
  allowOnline: false,
}
const baseOpts = {
  provider: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } as never,
  systemPrompt: 's',
  history: [],
  question: 'q',
  ctx,
}

function toolCall(name = 'stock_quote', args: Record<string, unknown> = { symbols: ['600519'] }) {
  return { id: 'c1', name, argsText: JSON.stringify(args), args }
}

beforeEach(() => {
  chatMock.mockReset()
})

describe('runAgent 响应停止信号', () => {
  it('信号已中止时：立即抛 AbortError，不问模型', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(runAgent({ ...baseOpts, signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(chatMock).not.toHaveBeenCalled()
  })

  it('chat 返回后信号才中止：仍抛 AbortError，不执行工具', async () => {
    const ctrl = new AbortController()
    // 模拟「服务端恰好把工具调用发完、用户同时按了停止」
    chatMock.mockImplementationOnce(async () => {
      ctrl.abort()
      return { text: '', toolCalls: [toolCall()], usage: undefined }
    })
    await expect(runAgent({ ...baseOpts, signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    // 只问了一次模型，没有继续第二轮
    expect(chatMock).toHaveBeenCalledTimes(1)
  })

  it('工具执行中被中止：不把中止当工具失败继续，下一轮也不问模型', async () => {
    const ctrl = new AbortController()
    // 第一轮：给工具调用；执行工具时（工具内部 fetch 走 request → 返回「已取消」
    // 不抛错）循环继续到下一轮开头 —— 那里必须看到 signal 已中止并抛错
    chatMock.mockImplementationOnce(async () => ({
      text: '',
      toolCalls: [toolCall()],
      usage: undefined,
    }))
    // 工具执行期间用户按停止（用全局 fetch 模拟请求被中止）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        ctrl.abort()
        throw new DOMException('The user aborted a request.', 'AbortError')
      }),
    )
    try {
      await expect(runAgent({ ...baseOpts, signal: ctrl.signal })).rejects.toMatchObject({
        name: 'AbortError',
      })
      // 第一轮 chat 之后的下一轮 chat 绝不能再发生（一旦发生就是「还在跑」）
      expect(chatMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('abortError 统一为 name=AbortError（上层靠它区分「停止」与「出错」）', () => {
    expect(abortError().name).toBe('AbortError')
  })
})
