/**
 * 定投计划。
 *
 * 为什么持仓要带定投：
 *   基金定投和一次性买入是**两种不同的操作**，军师对它们的判断完全不同 ——
 *   「左侧埋伏、越跌越买」对定投是常态，对一次性买入就是加仓失控。
 *   所以定投周期和金额必须让 AI 看到，否则它会把人家的自动扣款
 *   当成「高位补仓」来批评。
 */

export type DcaPeriod = 'daily' | 'weekly' | 'biweekly' | 'monthly'

export interface DcaPlan {
  /** 关闭时保留原有参数，方便再次打开 */
  enabled: boolean
  /** 每期投入金额（元） */
  amount?: number
  period: DcaPeriod
  /** weekly 时为 1-7（周一~周日）；monthly 时为 1-28（每月几号）；daily 忽略 */
  dayOfPeriod?: number
  /** 首次扣款日期 YYYY-MM-DD，可为空 */
  startAt?: string
  note?: string
}

/** 频率由高到低，UI 下拉按这个顺序显示 */
export const DCA_PERIODS: { value: DcaPeriod; label: string; every: string }[] = [
  { value: 'daily', label: '每日', every: '日' },
  { value: 'weekly', label: '每周', every: '周' },
  { value: 'biweekly', label: '每两周', every: '两周' },
  { value: 'monthly', label: '每月', every: '月' },
]

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function periodLabel(p: DcaPeriod): string {
  return DCA_PERIODS.find((x) => x.value === p)?.label ?? '每月'
}

/** 一句话描述，UI 和提示词共用，避免两边说法不一致 */
export function describeDca(plan: DcaPlan | undefined | null): string {
  if (!plan?.enabled) return ''
  const amount = plan.amount != null && plan.amount > 0 ? `¥${Math.round(plan.amount)}` : '金额未填'
  const period = periodLabel(plan.period)
  // 每日定投不谈「几号/周几」，直接说每日
  let when = ''
  if (plan.dayOfPeriod != null && plan.period !== 'daily') {
    if (plan.period === 'monthly') when = `每月 ${plan.dayOfPeriod} 号`
    else when = WEEKDAYS[Math.max(0, Math.min(6, plan.dayOfPeriod - 1))] ?? ''
  }
  const head = when ? `${when} ${amount}` : `${period} ${amount}`
  const tail = plan.startAt ? `，自 ${plan.startAt} 起` : ''
  const note = plan.note ? `（${plan.note}）` : ''
  return `${head}${tail}${note}`
}

/** 折算成「平均每月投入」，用于估算仓位节奏 */
export function monthlyDcaAmount(plan: DcaPlan | undefined | null): number {
  if (!plan?.enabled || !plan.amount || plan.amount <= 0) return 0
  if (plan.period === 'daily') return plan.amount * 365 / 12
  if (plan.period === 'weekly') return plan.amount * 52 / 12
  if (plan.period === 'biweekly') return plan.amount * 26 / 12
  return plan.amount
}

export function isDcaActive(plan: DcaPlan | undefined | null): boolean {
  return !!plan?.enabled
}
