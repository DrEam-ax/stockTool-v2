/**
 * DOM / 组件层测试。
 *
 * 为什么非要有这一层：
 *   之前的测试全是「函数返回对不对」。而用户实际踩到的几个 bug
 *   **函数返回值全都正常，坏在渲染和样式上**：
 *
 *     1. `.check input` 是后代选择器（特异性与 `input[type='text']` 相同、
 *        但写在后面），把核对卡片里的文本输入框也压成了 16×16 ——
 *        识别出来的持仓名称、市值一个都看不见。单元测试完全测不出来。
 *     2. `<label class="check">` 里套了 7 个输入框 —— HTML 规定点击 label
 *        任意位置都会激活它的第一个控件，于是每点一个输入框都会误触复选框。
 *     3. API Key 输入框绑了 v-model，WebView 重渲染时被回写成空。
 *
 *   这三类问题只有「真的 mount 起来看 DOM」才能发现。
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import HoldingEditor from '@/components/HoldingEditor.vue'

const sample = {
  name: '中欧中证全指软件开发指数发起C',
  shares: 1270.14,
  costPrice: undefined as number | undefined,
  lastPrice: undefined as number | undefined,
  marketValue: 1270.14,
  profitAmount: -357.59,
  profitPct: -0.2206,
  confidence: 0.95,
  _checked: true,
  _id: 'h1',
}

function mountCard(patch: Partial<typeof sample> = {}) {
  const holding = { ...sample, ...patch }
  const w = mount(HoldingEditor, { props: { holding } })
  return { w, holding }
}

describe('持仓核对卡片：识别出来的内容必须真的看得见', () => {
  it('名称渲染到 input 的 value 上', () => {
    const { w } = mountCard()
    const el = w.find('input.holding-name').element as HTMLInputElement
    expect(el.value).toBe(sample.name)
  })

  /**
   * 注意：**不能用 `wrapper.html()` 检查输入框的值**。
   * value 是 DOM 属性而不是 HTML 属性，outerHTML 不会把它序列化出来 ——
   * 一开始就是这么写的，结果测试误报失败，差点让我以为数据没绑上。
   * 必须逐个读 `.element.value`。
   */
  it('每个字段的值都落在对应的输入框上', () => {
    const { w } = mountCard()
    const byPlaceholder = (ph: string) =>
      (w.findAll('input').find((i) => i.attributes('placeholder') === ph)!
        .element as HTMLInputElement).value
    expect(byPlaceholder('股数')).toBe('1270.14')
    expect(byPlaceholder('市值')).toBe('1270.14')
    expect(byPlaceholder('盈亏金额')).toBe('-357.59')
    expect(byPlaceholder('盈亏比例(小数)')).toBe('-0.2206')
  })

  it('置信度渲染成百分比', () => {
    const { w } = mountCard()
    expect(w.html()).toContain('95%')
  })

  it('字段缺失时显示 placeholder 而不是崩掉', () => {
    const { w } = mountCard({ costPrice: undefined, lastPrice: undefined })
    // 1 复选框 + 1 名称 + 6 个数字字段 = 8
    const inputs = w.findAll('input')
    expect(inputs.length).toBe(8)
    const cost = inputs.find((i) => i.attributes('placeholder') === '成本价')
    expect(cost).toBeTruthy()
    expect((cost!.element as HTMLInputElement).value).toBe('')
  })
})

describe('复选框不能误触（label 只包复选框）', () => {
  it('label 里只有复选框这一个控件', () => {
    const { w } = mountCard()
    const label = w.findAll('label').find((l) => l.find('input[type="checkbox"]').exists())
    expect(label).toBeTruthy()
    expect(label!.findAll('input').length).toBe(1)
  })

  it('文本输入框不在 label 内部', () => {
    const { w } = mountCard()
    const label = w.findAll('label').find((l) => l.find('input[type="checkbox"]').exists())
    expect(label!.find('input.holding-name').exists()).toBe(false)
  })
})

describe('编辑一个字段不影响其他字段', () => {
  it('改名称不会动市值', async () => {
    const { w, holding } = mountCard()
    await w.find('input.holding-name').setValue('新名称')
    expect(holding.name).toBe('新名称')
    expect(holding.marketValue).toBe(1270.14)
  })

  it('切换复选框不会清空名称', async () => {
    const { w, holding } = mountCard()
    await w.find('input[type="checkbox"]').setValue(false)
    expect(holding._checked).toBe(false)
    expect(holding.name).toBe(sample.name)
  })

  it('数值字段改动能回写', async () => {
    const { w, holding } = mountCard()
    const mv = w.findAll('input').find((i) => i.attributes('placeholder') === '市值')
    await mv!.setValue('2000')
    expect(holding.marketValue).toBe(2000)
  })
})

/**
 * 样式层：jsdom 不做完整 CSS 层叠，所以用「选择器可匹配性」断言。
 * 这条能精确挡住那个把输入框压扁的后代选择器。
 */
describe('样式不会把 .check 里的文本输入框压扁', () => {
  const rawCss = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8')
  // 必须先去注释：注释里为了解释这个坑，本来就会写 `.check input`，
  // 不剥掉会被解析器当成真选择器，造成误报。
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

  const selectors: string[] = []
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)) {
    for (const one of m[2].split(',')) {
      const s = one.trim()
      if (s) selectors.push(s)
    }
  }

  /** 会不会命中「.check 内部的文本输入框」？ */
  function hitsCheckTextInput(sel: string): boolean {
    if (!sel.includes('.check')) return false
    if (!/(^|[\s>+~])input\b/.test(sel)) return false
    if (/input\[type=['"]?checkbox/.test(sel)) return false
    if (/\.check\s*>\s*input/.test(sel)) return false
    return true
  }

  it('解析器拿到了真实选择器（先把注释剥干净）', () => {
    expect(selectors.length).toBeGreaterThan(50)
    expect(selectors.some((s) => s.includes('/*'))).toBe(false)
  })

  it('没有会泄漏到文本输入框的选择器', () => {
    expect(selectors.filter(hitsCheckTextInput)).toEqual([])
  })

  it('复选框样式限定为直接子级', () => {
    expect(/\.check\s*>\s*input\[type=['"]?checkbox/.test(css)).toBe(true)
  })

  it('文本输入框有全局宽度规则（否则会退化成浏览器默认的窄框）', () => {
    expect(/input\[type=['"]text['"]\][\s\S]{0,200}width:\s*100%/.test(css)).toBe(true)
  })
})
