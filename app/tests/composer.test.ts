/**
 * 输入框光标护栏的单元测试。
 *
 * 背景：真机上出现「把光标移到内容中间，打字还是出现在末尾」。
 * 只要有什么东西重新给 `el.value` 赋值，光标就会被甩到末尾
 * （Vue 的 v-model 在中文输入法组合态下会用自己的过期状态覆盖 DOM）。
 *
 * 对策是「动手前记住光标、动完还回去」——本文件钉住这个还原逻辑。
 */

import { describe, expect, it } from 'vitest'
import { readCaret, restoreCaret, shouldUseNativeFieldSizing, imeCaretTarget } from '@/lib/composer'

function makeTextarea(value = '', attach = true): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  el.value = value
  if (attach) document.body.appendChild(el)
  return el
}

describe('光标快照与还原', () => {
  it('readCaret 读到当前选区', () => {
    const el = makeTextarea('abcdef')
    el.setSelectionRange(2, 4)
    expect(readCaret(el)).toMatchObject({ start: 2, end: 4 })
  })

  it('光标未被移动时不做事（返回 false）', () => {
    const el = makeTextarea('abcdef')
    el.focus()
    el.setSelectionRange(3, 3)
    expect(restoreCaret(el, { start: 3, end: 3 })).toBe(false)
  })

  it('光标被甩到末尾时还原到原位置', () => {
    const el = makeTextarea('abcdef')
    el.focus()
    el.setSelectionRange(3, 3)
    const caret = readCaret(el)

    // 模拟「有东西重新赋值 value」把光标甩到末尾。
    // 注意：jsdom 给 value 赋同值不会移动光标，所以要显式模拟。
    el.setSelectionRange(6, 6)
    expect(el.selectionStart).toBe(6)

    expect(restoreCaret(el, caret)).toBe(true)
    expect(el.selectionStart).toBe(3)
    expect(el.selectionEnd).toBe(3)
  })

  it('选区（非折叠光标）也能还原', () => {
    const el = makeTextarea('abcdef')
    el.focus()
    el.setSelectionRange(1, 4)
    const caret = readCaret(el)
    el.setSelectionRange(6, 6) // 模拟被甩到末尾
    restoreCaret(el, caret)
    expect(el.selectionStart).toBe(1)
    expect(el.selectionEnd).toBe(4)
  })

  it('内容变短时把位置夹在合法范围内（不抛错）', () => {
    const el = makeTextarea('abcdef')
    el.focus()
    el.value = 'ab'
    expect(() => restoreCaret(el, { start: 5, end: 5 })).not.toThrow()
    expect(el.selectionStart).toBe(2)
    expect(el.selectionEnd).toBe(2)
  })

  it('没有聚焦时不动光标（用户已经离开，别抢）', () => {
    const el = makeTextarea('abcdef')
    // 不 focus，document.activeElement 不是它
    el.setSelectionRange(6, 6) // 模拟被甩到末尾
    expect(restoreCaret(el, { start: 1, end: 1 })).toBe(false)
    expect(el.selectionStart).toBe(6) // 没聚焦就不抢，保持原样
  })

  it('传 null 时安全返回', () => {
    const el = makeTextarea('abc')
    expect(restoreCaret(el, null)).toBe(false)
  })

  it('组合态（isComposing=true）里绝不 setSelectionRange', () => {
    const el = makeTextarea('abcdef')
    el.focus()
    el.setSelectionRange(3, 3)
    const caret = readCaret(el)
    // 模拟输入法组合态：浏览器把 isComposing 置 true
    Object.defineProperty(el, 'isComposing', { configurable: true, value: true })
    // 光标被（某个未知路径）甩到末尾 —— 组合态下也不能还原：
    // Android WebView 组合态手动 setSelectionRange 会打断输入法，字落末尾
    el.setSelectionRange(6, 6)
    expect(restoreCaret(el, caret)).toBe(false)
    expect(el.selectionStart).toBe(6) // 宁可不动，也不帮倒忙
    // 组合态结束后恢复正常还原
    Object.defineProperty(el, 'isComposing', { configurable: true, value: false })
    expect(restoreCaret(el, caret)).toBe(true)
    expect(el.selectionStart).toBe(3)
  })
})

describe('field-sizing 收手判定', () => {
  const yes = () => true
  const no = () => false

  it('安卓 + 支持 field-sizing → 让原生接管（JS 收手）', () => {
    expect(shouldUseNativeFieldSizing('Mozilla/5.0 (Linux; Android 15)', yes)).toBe(true)
  })

  it('安卓但不支持 field-sizing → JS 兜底', () => {
    expect(shouldUseNativeFieldSizing('Mozilla/5.0 (Linux; Android 15)', no)).toBe(false)
  })

  it('桌面浏览器即使支持也走 JS（不受输入法组合态影响，行为保持不变）', () => {
    expect(shouldUseNativeFieldSizing('Mozilla/5.0 (Windows NT 10.0)', yes)).toBe(false)
  })
})

describe('IME 光标锚定（imeCaretTarget）', () => {
  // 场景：光标在「贵州茅台怎么样」第 3 个字符后，输入法上屏「的」
  // 文本 "贵州茅台怎么样" → "贵州的茅台怎么样"，光标应停在 3+1=4

  it('上屏后光标被甩到末尾 → 返回锚点+新增长度', () => {
    const target = imeCaretTarget(
      3, // 组合开始前光标
      6, // 组合开始前文本长度 "贵州茅台怎么样"
      7, // 上屏后长度 "贵州的茅台怎么样"
      7, // 上屏后光标在末尾（被甩）
      false, // 已出组合态
      false, // 无选区
    )
    expect(target).toBe(4)
  })

  it('上屏后光标位置本来就对 → 不修正', () => {
    const target = imeCaretTarget(
      3, 6, 7,
      4, // 光标正确停在插入处
      false, false,
    )
    expect(target).toBeNull()
  })

  it('输入前光标本来就在末尾 → 上屏后在末尾是正常行为，不修正', () => {
    expect(imeCaretTarget(6, 6, 9, 9, false, false)).toBeNull()
  })

  it('组合态中绝不修正（输入法全权管理光标）', () => {
    expect(imeCaretTarget(3, 6, 7, 7, true, false)).toBeNull()
  })

  it('有选区（用户正在选词）→ 不修正', () => {
    expect(imeCaretTarget(3, 6, 7, 7, false, true)).toBeNull()
  })

  it('光标不在末尾（如用户上屏后自己点了一下中间）→ 不修正', () => {
    expect(imeCaretTarget(3, 6, 7, 5, false, false)).toBeNull()
  })

  it('锚点文本比现在长（内容被删除/替换）→ 期望位置越界则不修正', () => {
    // 纯函数算出负数（不存在的插入位置），宁可不修正也不乱放光标
    expect(imeCaretTarget(2, 8, 5, 5, false, false)).toBeNull()
  })

  it('回车上屏英文（compositionend 被吞后手动触发）同样能修正', () => {
    // 光标在 2，输入 nihao 回车上屏 → 文本长 2+5=7，光标被甩到 7
    expect(imeCaretTarget(2, 4, 9, 9, false, false)).toBe(7)
  })
})
