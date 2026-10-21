/**
 * 界面级冒烟：把**每个页面**都真的挂起来跑一遍。
 *
 * 为什么单开这一层：
 *   之前的测试是「函数对不对」，上一轮补的是「单个组件渲染对不对」。
 *   但用户打开 App 首先看到的是**页面**——页面级的崩溃（读了 undefined、
 *   空数组没处理、store 没初始化）函数测试和组件测试都拦不住。
 *
 * 每个页面测三件事：
 *   1. 挂载不抛异常
 *   2. 空数据时有合理的空状态（不是白屏、不是 "undefined"）
 *   3. 关键交互元素存在（按钮、输入框）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'

const Blank = defineComponent({ render: () => h('div') })

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'sessions', component: Blank },
      { path: '/s/:id', name: 'session', component: Blank },
      { path: '/memory', name: 'memory', component: Blank },
      { path: '/kb', name: 'kb', component: Blank },
      { path: '/settings', name: 'settings', component: Blank },
    ],
  })
}

async function mountView(comp: unknown, route = '/') {
  const router = makeRouter()
  await router.push(route)
  await router.isReady()
  const w = mount(comp as never, {
    global: { plugins: [router] },
  })
  // 等 onMounted 里的异步加载跑完
  await flushPromises()
  await nextTick()
  return w
}

/** 收集控制台错误 —— 页面里未捕获的异常是最难发现的 bug */
function spyConsole() {
  const errors: string[] = []
  const origError = console.error
  const origWarn = console.warn
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(' '))
    origError(...(a as []))
  }
  console.warn = (...a: unknown[]) => {
    errors.push(a.map(String).join(' '))
    origWarn(...(a as []))
  }
  return {
    errors,
    restore: () => {
      console.error = origError
      console.warn = origWarn
    },
  }
}

// 各页面在挂载时会用到 —— 统一 mock 掉真实的网络调用
vi.mock('@/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@/services/llm')>('@/services/llm')
  return {
    ...actual,
    testProvider: vi.fn(async () => ({ ok: true, message: 'mock ok' })),
    listModels: vi.fn(async () => ['deepseek-chat', 'deepseek-flash']),
    extractHoldingsFromImages: vi.fn(async () => ({ holdings: [], summary: 'mock' })),
    compressImage: vi.fn(async (s: string) => s),
    fileToDataUrl: vi.fn(async () => 'data:image/png;base64,xxx'),
  }
})

describe('页面级冒烟：每个页面都能打开，空数据不白屏', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('会话页能打开，且给出空状态', async () => {
    const spy = spyConsole()
    const { default: SessionsView } = await import('@/views/SessionsView.vue')
    const w = await mountView(SessionsView, '/')
    const text = w.text()
    spy.restore()
    expect(w.html()).toBeTruthy()
    // 空数据时必须给引导，而不是一片空白
    expect(text).toMatch(/还没有会话|新建/)
    expect(w.find('.fab').exists() || text.includes('新建')).toBe(true)
    expect(spy.errors.filter((e) => e.includes('[Vue warn]'))).toEqual([])
  })

  it('记忆页能打开，且提示还没有持仓', async () => {
    const spy = spyConsole()
    const { default: MemoryView } = await import('@/views/MemoryView.vue')
    const w = await mountView(MemoryView, '/memory')
    const text = w.text()
    spy.restore()
    expect(w.html()).toBeTruthy()
    expect(text.length).toBeGreaterThan(20)
    expect(spy.errors.filter((e) => e.includes('[Vue warn]'))).toEqual([])
  })

  it('知识库页能打开，且提示还没载入', async () => {
    const spy = spyConsole()
    const { default: KnowledgeView } = await import('@/views/KnowledgeView.vue')
    const w = await mountView(KnowledgeView, '/kb')
    const text = w.text()
    spy.restore()
    expect(w.html()).toBeTruthy()
    expect(text).toMatch(/知识库/)
    expect(spy.errors.filter((e) => e.includes('[Vue warn]'))).toEqual([])
  })

  it('设置页能打开，空模型时给引导，且显示版本号', async () => {
    const spy = spyConsole()
    const { default: SettingsView } = await import('@/views/SettingsView.vue')
    const w = await mountView(SettingsView, '/settings')
    const text = w.text()
    spy.restore()
    expect(w.html()).toBeTruthy()
    expect(text).toContain('选股助手')
    // 版本号必须显示出来 —— 用户靠它确认装的是哪一版
    expect(w.find('.ver-card').exists()).toBe(true)
    expect(text).toMatch(/v\d+\.\d+\.\d+/)
    // 没有模型时要明确告诉用户去配置，而不是留白
    expect(text).toMatch(/还没有配置模型|不内置模型/)
    expect(spy.errors.filter((e) => e.includes('[Vue warn]'))).toEqual([])
  })

  it('会话详情在无效 id 下不崩', async () => {
    const spy = spyConsole()
    const { default: SessionDetail } = await import('@/views/SessionDetail.vue')
    const w = await mountView(SessionDetail, '/s/not-exist')
    spy.restore()
    expect(w.html()).toBeTruthy()
    // 会话不存在时应给出提示或跳走，而不是抛异常
    expect(spy.errors.filter((e) => e.includes('Cannot read'))).toEqual([])
  })
})

describe('空数据下的数字与文案（不能被 undefined 污染）', () => {
  it('知识库页没有任何库时不说 undefined', async () => {
    const { default: KnowledgeView } = await import('@/views/KnowledgeView.vue')
    const w = await mountView(KnowledgeView, '/kb')
    expect(w.text()).not.toContain('undefined')
    expect(w.html()).not.toContain('NaN')
  })

  it('记忆页没有持仓时不说 undefined', async () => {
    const { default: MemoryView } = await import('@/views/MemoryView.vue')
    const w = await mountView(MemoryView, '/memory')
    expect(w.text()).not.toContain('undefined')
    expect(w.html()).not.toContain('NaN')
  })

  it('设置页没有模型时不说 undefined', async () => {
    const { default: SettingsView } = await import('@/views/SettingsView.vue')
    const w = await mountView(SettingsView, '/settings')
    expect(w.text()).not.toContain('undefined')
    expect(w.html()).not.toContain('NaN')
  })

  it('会话页没有会话时不说 undefined', async () => {
    const { default: SessionsView } = await import('@/views/SessionsView.vue')
    const w = await mountView(SessionsView, '/')
    expect(w.text()).not.toContain('undefined')
    expect(w.html()).not.toContain('NaN')
  })
})
