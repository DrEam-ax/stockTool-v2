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
    // 1 复选框 + 1 名称 + 6 个数字字段 = 8；
    // 定投关着时只有那一个「这是一笔定投」复选框，不再多出输入框
    const inputs = w.findAll('input')
    const amountInput = inputs.find((i) => i.attributes('placeholder') === '每期金额')
    expect(amountInput).toBeUndefined() // 定投未开启
    const main = inputs.filter((i) => i.attributes('type') !== 'checkbox')
    expect(main.length).toBe(7) // 名称 + 6 个数字字段
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

/**
 * 状态栏遮挡 + CSS 文件本身必须是合法 UTF-8。
 *
 * 背景：Android 15+ 对 targetSdk >= 35 强制「边到边」，WebView 会画到屏幕顶端，
 * 页面标题和时间/电量叠在一起。Capacitor 8 的 insetsHandling 默认是 "css"，
 * 它会注入 --safe-area-inset-top 等变量 —— 但样式表必须真的去用它，否则等于没注入。
 *
 * 另一个更隐蔽的坑：有人用 PowerShell 的 Set-Content（默认 ANSI）
 * 写回过这个文件，中文注释被替换成 `?`、多字节序列被截断，文件不再是合法 UTF-8。
 * 浏览器能容错渲染，所以肉眼看不出来 —— 必须由测试守住。
 */
describe('状态栏安全区（Android 15 边到边）', () => {
  const raw = readFileSync(resolve(__dirname, '../src/styles.css'))
  const cssText = raw.toString('utf8')

  it('styles.css 是合法 UTF-8（防 ANSI 写回损坏）', () => {
    // toString('utf8') 会用 U+FFFD 替换非法字节，所以查替换字符最直接
    expect(cssText.includes('\uFFFD')).toBe(false)
    // 再确认能严格解码
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(raw)).not.toThrow()
  })

  it('定义了 --safe-t / --safe-b，且优先用 Capacitor 注入的变量', () => {
    expect(/--safe-t:\s*var\(--safe-area-inset-top/.test(cssText)).toBe(true)
    expect(/--safe-b:\s*var\(--safe-area-inset-bottom/.test(cssText)).toBe(true)
    // 必须有 env() 兜底，否则 Capacitor 没注入时会全 0
    expect(/--safe-t:[^;]*env\(safe-area-inset-top/.test(cssText)).toBe(true)
  })

  it('页面顶部让开了安全区', () => {
    // .page 的 padding-top 里必须含 --safe-t
    const pageBlock = /\.page\s*\{[^}]*\}/.exec(cssText)?.[0] ?? ''
    expect(pageBlock).toContain('--safe-t')
  })

  it('有一条固定的纯色遮挡条（滚动了也不会被内容盖住）', () => {
    const before = /body::before\s*\{[^}]*\}/.exec(cssText)?.[0] ?? ''
    expect(before).toContain('position: fixed')
    expect(before).toContain('height: var(--safe-t)')
    expect(before).toContain('background: var(--bg)')
    // 不能吃点击事件（纯装饰）
    expect(before).toContain('pointer-events: none')
  })

  it('遮挡条的层级在内容之上、弹层之下', () => {
    const before = /body::before\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? ''
    const z = Number(/z-index:\s*(\d+)/.exec(before)?.[1] ?? NaN)
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThan(40) // 高于底栏
    expect(z).toBeLessThan(60) // 低于弹层
  })
})

/**
 * 元素互相挤占。
 *
 * 用户反馈手机上有几处元素互相压：长名称把徽章挤走、金额位数一多撑破格子。
 * 根因是三条 CSS 默认行为，这里逐条钉住，避免以后又被改回去：
 *   1. flex 行不换行
 *   2. flex/grid 子项默认 min-width:auto（内容不肯缩）
 *   3. 徽章参与压缩
 */
describe('布局：元素不能互相挤占', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8')

  function block(selector: string): string {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
    return re.exec(css)?.[1] ?? ''
  }

  it('卡片标题允许换行（长名称 + 徽章不再互相挤）', () => {
    expect(block('.card-title')).toContain('flex-wrap: wrap')
  })

  it('徽章不参与压缩、不折行', () => {
    const b = block('.badge')
    expect(b).toContain('flex-shrink: 0')
    expect(b).toContain('white-space: nowrap')
  })

  it('统计卡可缩（金额位数多时不会撑破格子）', () => {
    expect(block('.stat')).toContain('min-width: 0')
  })

  it('三宫格里的金额字号自适应', () => {
    const b = block('.grid3 .stat .v')
    expect(b).toMatch(/font-size:\s*clamp\(/)
  })

  it('顶部标题可缩、按钮不被挤扁', () => {
    expect(block('.hdr h1')).toContain('min-width: 0')
    expect(block('.hdr .btn')).toContain('flex-shrink: 0')
  })

  it('键盘弹出时底栏收起', () => {
    expect(css).toMatch(/html\.kbd-open\s+\.tabbar\s*\{[^}]*transform:\s*translateY/)
    // 收起后不能再吃点击，否则用户点不到底下的输入区
    expect(css).toMatch(/html\.kbd-open\s+\.tabbar\s*\{[^}]*pointer-events:\s*none/)
  })

  // 逐页自查后补的几条，防止以后被改回去
  it('上下文 chip 超长时不溢出', () => {
    const b = block('.chip')
    expect(b).toContain('max-width: 100%')
    expect(b).toContain('overflow-wrap')
  })

  it('模式选择头可换行', () => {
    expect(block('.mode-head')).toContain('flex-wrap: wrap')
  })

  it('工具 chip 可换行且能断长名', () => {
    const b = block('.tool-row')
    expect(b).toContain('flex-wrap: wrap')
    expect(b).toContain('overflow-wrap')
  })

  it('space-between 行两侧都能缩、按钮不被挤走', () => {
    expect(css).toMatch(/\.spread\s*>\s*\*\s*\{[^}]*min-width:\s*0/)
    expect(css).toMatch(/\.spread\s+\.btn[^{]*\{[^}]*flex-shrink:\s*0/)
  })

  it('开关控件不被压扁', () => {
    expect(block('.switch')).toContain('flex-shrink: 0')
  })

  it('三宫格统计卡与下方卡片之间要有间距', () => {
    // 用户截图里「板块分布」紧贴着上面三张统计卡。
    // .grid3 本身没有 margin-bottom，用相邻选择器补，避免影响
    // SettingsView 里「卡片内部的 .grid3」。
    expect(css).toMatch(/\.grid3\s*\+\s*\.card\s*\{[^}]*margin-top:\s*\d+px/)
  })
})

describe('定投：识别结果卡片上能勾选周期和金额', () => {
  it('默认没有定投，勾选后才出现周期与金额', async () => {
    const { w, holding } = mountCard()
    // 默认不显示定投输入
    expect(w.text()).toContain('这是一笔定投')
    expect(w.findAll('select').length).toBe(0)

    // 勾上
    const boxes = w.findAll("input[type='checkbox']")
    const dcaBox = boxes[boxes.length - 1]
    await dcaBox.setValue(true)
    await w.vm.$nextTick()
    expect(w.findAll('select').length).toBe(1)
    // 周期下拉里要有日/周/双周/月四个选项（频率由高到低）
    const opts = w.findAll('select option').map((o) => o.text())
    expect(opts).toEqual(['每日', '每周', '每两周', '每月'])
    expect(holding.dca?.enabled).toBe(true)
  })

  it('填了金额后给出人话预览', async () => {
    const { w } = mountCard()
    const boxes = w.findAll("input[type='checkbox']")
    await boxes[boxes.length - 1].setValue(true)
    await w.vm.$nextTick()
    // 通过输入框写值，才能走 v-model（直接改对象 Vue 观察不到）
    const amount = w
      .findAll('input')
      .find((i) => i.attributes('placeholder') === '每期金额')
    expect(amount).toBeTruthy()
    await amount!.setValue('500')
    await w.vm.$nextTick()
    expect(w.text()).toContain('¥500')
  })
})
