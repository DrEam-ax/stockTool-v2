import type { Holding, KnowledgeBase, ToolConfig } from '@/types'

export interface ToolContext {
  kbs: KnowledgeBase[]
  config: ToolConfig
  signal?: AbortSignal
  /** 用户已确认 + 待确认的持仓。check_holdings 用它核对「是不是已经持有」 */
  holdings?: Holding[]
  /**
   * 用户是否已预先授权联网查证。
   * false 时提示词要求模型先问一句再调工具（会话里的「允许联网」开关）。
   */
  allowOnline?: boolean
}

export interface ToolResult {
  ok: boolean
  /** 回给模型的内容 */
  content: string
  /** 给用户看的一句话动作描述，如「检索「半导体」」 */
  display: string
  /** 给用户看的结果摘要，如「12 条」 */
  summary?: string
  /** 给用户看的详细结果（展开时显示），可选 */
  detail?: string
  error?: string
}

export interface Availability {
  ok: boolean
  reason?: string
}

export interface ToolDef {
  name: string
  /** 中文动作名，显示在聊天里 */
  title: string
  /** 给模型看的说明。写得好不好直接决定模型会不会正确使用工具 */
  description: string
  parameters: Record<string, unknown>
  available: (ctx: ToolContext) => Availability
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export function asString(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback
  return String(v)
}

export function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : fallback
}
