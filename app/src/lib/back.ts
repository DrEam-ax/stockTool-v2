/**
 * Android 返回键 / 侧滑返回的处理。
 *
 * 问题：不监听 backButton 时，Capacitor 的默认行为会让「会话详情」这类
 * 二级页面在按返回 / 侧滑返回时**直接退出 App**，而不是回到上一页。
 *
 * 语义（用户约定）：
 *   - 当前在根路由（'/' 会话列表）→ 没有上一页，退出 App
 *   - 在其他页面 → 路由级后退（回到进入该页之前的页面）
 *   - 深链直入（路由栈没有可回退的历史）→ 回落 '/'（会话列表）
 *
 * 只在原生（Capacitor）环境注册；浏览器开发模式返回 noop，不影响开发。
 * 插件用动态 import：测试 / 浏览器环境不加载原生模块。
 */

import type { Router } from 'vue-router'

export function isNativePlatform(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return w.Capacitor?.isNativePlatform?.() ?? false
}

export type BackDecision = 'exit' | 'back' | 'home'

/**
 * 返回行为的纯决策（便于单测，不依赖真实 history 栈）：
 *   - 根路由 '/' → 没有上一页，退出 App
 *   - 有路由历史 → 路由后退
 *   - 无路由历史（深链直入）→ 回落 '/'（会话列表）
 */
export function decideBack(path: string, historyBack: string | null | undefined): BackDecision {
  if (path === '/') return 'exit'
  if (historyBack) return 'back'
  return 'home'
}

export function installBackHandler(router: Router): () => void {
  if (!isNativePlatform()) return () => {}

  let disposed = false
  let removeListener: (() => void) | null = null

  void import('@capacitor/app')
    .then(({ App }) => {
      if (disposed) return
      App.addListener('backButton', () => {
        const path = router.currentRoute.value.path
        const back = window.history.state?.back as string | null | undefined
        const decision = decideBack(path, back)
        if (decision === 'exit') {
          void App.exitApp()
        } else if (decision === 'back') {
          router.back()
        } else {
          void router.replace('/')
        }
      })
        .then((listener) => {
          if (disposed) {
            listener.remove()
          } else {
            removeListener = () => listener.remove()
          }
        })
        .catch(() => {
          /* 注册失败就保持 Capacitor 默认行为，不让 App 崩 */
        })
    })
    .catch(() => {
      /* 插件加载失败（例如被 tree-shake）→ 保持默认行为 */
    })

  return () => {
    disposed = true
    removeListener?.()
  }
}
