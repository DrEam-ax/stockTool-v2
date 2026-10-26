/**
 * 输入框高度策略：原生 field-sizing 是否接管（JS 收手）。
 *
 * 为什么必须让 JS 收手 —— 这是「输入的字强制在最后、不在光标处」的根因：
 *   真机 Android WebView 上，中文输入法组合态里每打一个键，聚焦定时器
 *   （150ms）和 @input 都会执行 `el.style.height='auto'` → 强制重排 →
 *   正在编辑的 textarea 被浏览器重新布局 → 输入法关联的光标定位被打断，
 *   新输入的字就落到文本末尾。
 *   原生 field-sizing（Chrome/WebView 123+）已经接管「内容变 → 高度变」，
 *   JS 那套只留给不支持 field-sizing 的旧内核做兜底，两者绝不重复跑。
 */

/**
 * 判定是否应该由原生 `field-sizing` 接管输入框高度（JS 收手）。
 *
 * 抽成纯函数便于单测：防回归 —— 若有人去掉 Android 判断或改坏
 * CSS.supports 调用，真机输入法光标被顶到末尾的 bug 会复现。
 */
export function shouldUseNativeFieldSizing(
  ua: string,
  supports: (prop: string, value: string) => boolean,
): boolean {
  return supports('field-sizing', 'content') && /Android/i.test(ua)
}

export const HAS_FIELD_SIZING = shouldUseNativeFieldSizing(
  navigator.userAgent,
  (p, v) =>
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports(p, v)
      : false,
)

/**
 * 光标位置快照 / 还原。
 *
 * 为什么需要：真机上出现过「把光标移到中间，再打字还是出现在末尾」。
 * 成因是任何一次 `el.value = ...` 重新赋值都会把光标甩到末尾 ——
 * 而 Vue 的 `v-model` 在中文输入法组合态下会用自己的（过期的）状态覆盖 DOM，
 * 于是就发生了。
 *
 * 与其去堵所有可能触发覆盖的路径（历史上已经堵过三次，每次换机型又冒出来），
 * 不如**动手前记住光标、动完还回去**：只要文本内容没变，光标就一定能回到原处。
 * 这样即使某个未知路径又去动了 value，用户也不会察觉。
 */
export interface Caret {
  start: number
  end: number
  dir?: 'forward' | 'backward' | 'none'
}

/** 读当前光标（只读，不会引起任何 DOM 变更） */
export function readCaret(el: HTMLTextAreaElement): Caret {
  return {
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? 0,
    dir: el.selectionDirection ?? undefined,
  }
}

/**
 * 元素是否处于输入法组合态（拼音还没上屏）。
 *
 * `isComposing` 是标准属性，但 TS 的 lib.dom 只在 HTMLInputElement 上声明了它，
 * textarea 上没有 —— 用宽松接口接收，避免到处断言。
 * 部分老内核不暴露该属性，拿不到就当「不在组合态」，由上层全局状态兜底。
 */
export function inImeComposition(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  return Boolean((el as { isComposing?: boolean }).isComposing)
}

/**
 * 把光标还原到快照位置；不需要还原时返回 false。
 *
 * 保守策略：只在**仍然聚焦**且**光标确实被移走**时才动它，
 * 并且把位置夹在文本长度内（万一内容变短了）。
 *
 * 组合态（输入法拼音还没上屏）时**绝不 setSelectionRange**：
 * Android WebView 上组合态读到的 selectionStart 是输入法组合区的位置，
 * 此刻手动移动光标会打断输入法自身的组合状态 —— 上一轮修复没拦住这条，
 * 用户实测「把光标移到中间、字仍落到末尾」依旧复现。
 * 组合态下光标由输入法全权管理，JS 一动就是帮倒忙。
 */
export function restoreCaret(el: HTMLTextAreaElement, caret: Caret | null): boolean {
  if (!caret) return false
  if (typeof document !== 'undefined' && document.activeElement !== el) return false
  // 组合态守卫：`isComposing` 是标准属性（Chrome/WebView 支持，jsdom 也有）。
  // 部分老内核不暴露它 —— 拿不到就当「不在组合态」，由上层 composing 状态兜底。
  if (inImeComposition(el)) return false
  const len = el.value.length
  const start = Math.max(0, Math.min(caret.start, len))
  const end = Math.max(start, Math.min(caret.end, len))
  if (el.selectionStart === start && el.selectionEnd === end) return false
  try {
    el.setSelectionRange(start, end, caret.dir)
    return true
  } catch {
    return false
  }
}
