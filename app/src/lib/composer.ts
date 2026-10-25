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
