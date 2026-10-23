/**
 * 返回键 / 侧滑返回处理（src/lib/back.ts）的行为测试。
 *
 * 语义（用户约定）：
 *   - 根路由 '/' → 退出 App
 *   - 其他页面（有历史）→ 路由后退
 *   - 其他页面（深链直入，无历史）→ 回落 '/'
 *   - 浏览器开发环境 → 不注册任何原生监听
 *
 * 稳定性说明：jsdom 的 window.history 在同一测试文件内共享，
 * 真实 push/back 会产生跨用例泄漏，所以集成用例统一用
 * `vi.spyOn(window.history, 'state', 'get')` 控制「有没有历史」，
 * 不用真实历史栈。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router } from 'vue-router'
import { decideBack, installBackHandler } from '@/lib/back'

const mocks = vi.hoisted(() => {
  const listeners: Array<(data?: { canGoBack?: boolean }) => void> = []
  const removes: Array<() => void> = []
  return {
    listeners,
    removes,
    addListener: vi.fn(
      (_event: string, cb: (data?: { canGoBack?: boolean }) => void) => {
        listeners.push(cb)
        const remove = vi.fn(() => {})
        removes.push(remove)
        return Promise.resolve({ remove })
      },
    ),
    exitApp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@capacitor/app', () => ({
  App: { addListener: mocks.addListener, exitApp: mocks.exitApp },
}))

const routes = [
  { path: '/', name: 'sessions', component: { template: '<div/>' } },
  { path: '/s/:id', name: 'session', component: { template: '<div/>' } },
]

async function makeRouter(): Promise<Router> {
  const router = createRouter({ history: createWebHashHistory(), routes })
  await router.push('/')
  return router
}

function setNative(isNative: boolean): void {
  Object.defineProperty(window, 'Capacitor', {
    value: { isNativePlatform: () => isNative },
    configurable: true,
  })
}

/** 控制 history.state.back，模拟「有没有可回退的历史」 */
function mockHistoryState(back: string | null): void {
  vi.spyOn(window.history, 'state', 'get').mockReturnValue({
    back,
    current: '/current',
    forward: null,
  })
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mocks.listeners.length = 0
  mocks.removes.length = 0
  mocks.addListener.mockClear()
  mocks.exitApp.mockClear()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '#/')
})

describe('decideBack 纯决策', () => {
  it('根路由 → exit', () => {
    expect(decideBack('/', '/')).toBe('exit')
    expect(decideBack('/', null)).toBe('exit')
  })

  it('非根路由 + 有历史 → back', () => {
    expect(decideBack('/s/1', '/')).toBe('back')
  })

  it('非根路由 + 无历史 → home（回落会话列表）', () => {
    expect(decideBack('/s/1', null)).toBe('home')
    expect(decideBack('/settings', undefined)).toBe('home')
  })
})

describe('installBackHandler 集成', () => {
  it('浏览器开发环境不注册原生监听', async () => {
    setNative(false)
    const router = await makeRouter()
    const uninstall = installBackHandler(router)
    await flush()

    expect(mocks.addListener).not.toHaveBeenCalled()
    uninstall()
  })

  it('原生环境注册 backButton 监听', async () => {
    setNative(true)
    const router = await makeRouter()
    installBackHandler(router)
    await flush()

    expect(mocks.addListener).toHaveBeenCalledTimes(1)
    expect(mocks.addListener.mock.calls[0][0]).toBe('backButton')
    expect(mocks.listeners).toHaveLength(1)
  })

  it('根路由按返回 → 退出 App', async () => {
    setNative(true)
    const router = await makeRouter()
    const uninstall = installBackHandler(router)
    await flush()

    mockHistoryState('/')
    mocks.listeners[0]?.({ canGoBack: true })
    await flush()

    expect(mocks.exitApp).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/')
    uninstall()
  })

  it('二级页面（有历史）按返回 → 调用路由后退', async () => {
    setNative(true)
    const router = await makeRouter()
    const uninstall = installBackHandler(router)
    await flush()

    await router.push('/s/1')
    const backSpy = vi.spyOn(router, 'back').mockImplementation(() => Promise.resolve())
    mockHistoryState('/')

    mocks.listeners[0]?.({ canGoBack: true })
    await flush()

    expect(backSpy).toHaveBeenCalledTimes(1)
    expect(mocks.exitApp).not.toHaveBeenCalled()
    uninstall()
  })

  it('二级页面（深链直入，无历史）按返回 → 回落会话列表', async () => {
    setNative(true)
    const router = await makeRouter()
    const uninstall = installBackHandler(router)
    await flush()

    await router.push('/s/9')
    mockHistoryState(null)

    mocks.listeners[0]?.({ canGoBack: false })
    await flush()

    expect(router.currentRoute.value.path).toBe('/')
    expect(mocks.exitApp).not.toHaveBeenCalled()
    uninstall()
  })

  it('卸载后移除监听', async () => {
    setNative(true)
    const router = await makeRouter()
    const uninstall = installBackHandler(router)
    await flush()
    expect(mocks.removes).toHaveLength(1)

    uninstall()
    expect(mocks.removes[0]).toHaveBeenCalledTimes(1)
  })
})
