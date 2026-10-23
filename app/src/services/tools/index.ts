import type { ToolSchema } from '../llm'
import { checkHoldingsTool } from './holdings'
import { kbTools } from './kb'
import { marketTools } from './market'
import type { ToolContext, ToolDef } from './types'
import { webTools } from './web'

export const ALL_TOOLS: ToolDef[] = [
  ...kbTools,
  ...marketTools,
  ...webTools,
  // 「推荐之后核对持仓」—— 顺序放最后，模型会先查数据再核对
  checkHoldingsTool,
]

export function toolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name)
}

/** 当前上下文下真正可用的工具 */
export function activeTools(ctx: ToolContext): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.available(ctx).ok)
}

/** 转成 OpenAI 的 tools 参数 */
export function toSchemas(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export interface ToolAvailability {
  name: string
  title: string
  ok: boolean
  reason?: string
}

/** 设置页用来展示「哪些工具现在能用、哪些不能、为什么」 */
export function describeAvailability(ctx: ToolContext): ToolAvailability[] {
  return ALL_TOOLS.map((t) => {
    const a = t.available(ctx)
    return { name: t.name, title: t.title, ok: a.ok, reason: a.reason }
  })
}

/** 给系统提示词用的工具说明 —— 让模型知道哪些工具现在不可用，
 *  免得它反复尝试一个注定失败的工具（既浪费 token 又让回答变慢） */
export function availabilityNote(ctx: ToolContext): string {
  const list = describeAvailability(ctx)
  const usable = list.filter((t) => t.ok)
  const blocked = list.filter((t) => !t.ok)
  const lines: string[] = []
  if (usable.length) {
    lines.push(`当前可用的工具：${usable.map((t) => t.title).join('、')}`)
  }
  if (blocked.length) {
    lines.push(
      '当前**不可用**的工具（不要尝试调用）：\n' +
        blocked.map((t) => `  - ${t.title}：${t.reason}`).join('\n'),
    )
  }
  return lines.join('\n')
}

export type { ToolContext, ToolDef, ToolResult } from './types'
