/**
 * 键盘监听：弹出时把底部导航收起来。
 *
 * 为什么需要：
 *   底栏是 `position: fixed; bottom: 0`。键盘弹出后视口变矮，
 *   底栏就贴在键盘上沿，白占 56px —— 而这时候用户根本不需要导航。
 *   微信等主流 App 的做法都是输入时把底栏收走。
 *
 * 判别方式：
 *   没有可靠的「键盘高度」API，所以用 visualViewport 的高度变化来推断 ——
 *   记录见过的最大高度作为基准，比基准矮 150px 以上就认为键盘弹出。
 *   用「历史最大值」而不是「初始值」，这样横竖屏切换、地址栏收起
 *   都不会误判成键盘。
 */

const KEYBOARD_MIN_PX = 150

export function isKeyboardOpen(): boolean {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  return h < baseline - KEYBOARD_MIN_PX
}

let baseline = 0
let installed = false

export function installKeyboardWatcher(): () => void {
  if (installed) return () => {}
  installed = true

  const root = document.documentElement
  const vv = window.visualViewport
  baseline = vv ? vv.height : window.innerHeight

  const apply = () => {
    const h = vv ? vv.height : window.innerHeight
    if (h > baseline) baseline = h
    const open = h < baseline - KEYBOARD_MIN_PX
    root.classList.toggle('kbd-open', open)
    // 输入法弹出时 iOS/Android 都会滚动视口，顺便把内容顶到位
    if (open) {
      requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null
        el?.scrollIntoView?.({ block: 'nearest' })
      })
    }
  }

  const target: EventTarget = vv ?? window
  target.addEventListener('resize', apply)
  // 键盘收起后有的浏览器不触发 resize，用 focusout 兜一下
  window.addEventListener('focusout', () => setTimeout(apply, 120))
  apply()

  return () => {
    target.removeEventListener('resize', apply)
    root.classList.remove('kbd-open')
    installed = false
  }
}
