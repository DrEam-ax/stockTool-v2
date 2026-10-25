/**
 * 当日分时走势工具（stock_trend）的解析与报告测试。
 *
 * 纯函数测试：不联网，喂构造的腾讯分时接口样本，验证解析与
 * 报告生成逻辑（字段映射、分钟点过滤、节奏/量峰统计）。
 */
import { describe, expect, it } from 'vitest'
import { buildTrendReport, parseMinuteResponse } from '../src/services/tools/market'

/** 构造一个最小合法样本：3 个分钟点 + 内嵌的 qt 报价数组 */
function bodyWith(points: string[]): string {
  const qt = [
    '1', '贵州茅台', '600519', '1335.00', '1318.49', '1311.84',
    ...Array<string>(24).fill(''),
    '20261023161458',
    '16.51', '1.25', '1343.88', '1310.00', '1335.00/57686/7677216283',
    '57686', '767722', '0.46', '20.49',
  ]
  return JSON.stringify({
    code: 0,
    data: {
      sh600519: {
        data: { date: '20261023', data: points },
        qt: { sh600519: qt },
      },
    },
  })
}

/** 构造一个最小合法样本：3 个分钟点 + 内嵌的 qt 报价数组 */
function sampleBody(): string {
  return bodyWith([
    '0930 1311.84 1049 137612016.00',
    '0931 1315.00 2100 276000000.00',
    '1500 1335.00 57695 7678427099.06',
  ])
}

describe('parseMinuteResponse：腾讯分时接口解析', () => {
  it('字段正确映射（qt 报价数组 + 分钟点）', () => {
    const td = parseMinuteResponse('sh600519', sampleBody())
    expect(td).not.toBeNull()
    expect(td!.name).toBe('贵州茅台')
    expect(td!.code).toBe('600519')
    expect(td!.date).toBe('20261023')
    expect(td!.price).toBe(1335)
    expect(td!.prevClose).toBe(1318.49)
    expect(td!.open).toBe(1311.84)
    expect(td!.changePct).toBe(1.25)
    expect(td!.high).toBe(1343.88)
    expect(td!.low).toBe(1310)
    expect(td!.vol).toBe(57686)
    expect(td!.turnover).toBe(0.46)
  })

  it('分钟点解析：数量、时间标签、过滤盘前点', () => {
    const td = parseMinuteResponse('sh600519', sampleBody())
    expect(td!.points.length).toBe(3)
    expect(td!.points[0].label).toBe('9:30')
    expect(td!.points[0].price).toBe(1311.84)
    expect(td!.points[0].vol).toBe(1049)
    expect(td!.points[2].label).toBe('15:00')

    // 盘前点（0925）应被过滤：只留 0925 + 0930 + 1500 时，0925 被剔除
    const td2 = parseMinuteResponse('sh600519', bodyWith(['0925 1310.00 10 1000000.00', '0930 1311.84 1049 137612016.00', '1500 1335.00 57695 7678427099.06']))
    expect(td2).not.toBeNull()
    expect(td2!.points.length).toBe(2)
    expect(td2!.points.every((p) => p.t >= 570)).toBe(true)
  })

  it('非法 JSON / 缺少结构 → null', () => {
    expect(parseMinuteResponse('sh600519', 'not json')).toBeNull()
    expect(parseMinuteResponse('sh600519', '{"data":{}}')).toBeNull()
    expect(parseMinuteResponse('sh600519', JSON.stringify({ data: { sh600519: { data: { data: [] } } } }))).toBeNull()
  })
})

describe('buildTrendReport：分时报告生成', () => {
  it('包含核心要素：概况、节奏、量峰、最近分钟点', () => {
    const td = parseMinuteResponse('sh600519', sampleBody())!
    const report = buildTrendReport(td)
    expect(report).toContain('贵州茅台(600519)')
    expect(report).toContain('20261023')
    expect(report).toContain('1335.00')
    expect(report).toContain('早盘 9:30→11:30')
    expect(report).toContain('午后 13:00→14:30')
    expect(report).toContain('尾盘 14:30→15:00')
    expect(report).toContain('分钟量峰')
    expect(report).toContain('最近 6 个分钟点')
    expect(report).toContain('9:30　1311.84')
  })

  it('涨跌方向与差值正确（+/- 前缀）', () => {
    const td = parseMinuteResponse('sh600519', sampleBody())!
    const report = buildTrendReport(td)
    // 昨收 1318.49 → 现价 1335.00，涨（注意报告用全角括号）
    expect(report).toContain('涨 1.25%')
    expect(report).toContain('（+16.51）')
  })
})
