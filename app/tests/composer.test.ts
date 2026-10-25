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
import { readCaret, restoreCaret, shouldUseNativeFieldSizing } from '@/lib/composer'

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
