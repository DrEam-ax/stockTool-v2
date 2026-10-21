/**
 * 设置页的**完整交互流程**测试 —— 就是用户真实会走的那些路。
 *
 * 这一层是为之前那几个 bug 专门补的。它们全都是
 * 「用户点了几下 → 值没了 / 保存没反应」，函数级和渲染级测试都拦不住：
 *
 *   · 填完 API Key，点「显示密钥」或「支持识图」→ key 没了
 *   · 填完点保存 → 什么都没发生（IndexedDB 无法克隆 Vue Proxy，
 *     异常被吞掉，界面上毫无提示）
 *   · 点「拉取模型列表」→ 报「该服务不提供接口」，
 *     实际是 key 丢了导致的 401
 *
 * 所以这里**不看函数返回值，只模拟点击和输入，然后断言界面**。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import SettingsView from '@/views/SettingsView.vue'
import { useProviders } from '@/stores/providers'
import { useTools } from '@/stores/tools'
import * as db from '@/lib/db'

const Blank = defineComponent({ render: () => h('div') })

/**
 * 等条件成立。
 *
 * 为什么不能只用 flushPromises()：IndexedDB 的回调**不是微任务**，
 * flushPromises 刷不掉它。一开始就是只用了 flushPromises，
 * 于是断言跑在写入之前，误判成「保存没生效」。
 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

/**
 * 清干净用例间的状态。
 *
 * 不能用 indexedDB.deleteDatabase —— App 里的 openDb 把连接缓存住永不 close，
 * fake-indexeddb 的删除会被 blocked 挂死。直接清各个 store 即可。
 */
async function resetAll() {
  for (const s of Object.values(db.STORES)) {
    try {
      await db.clear(s)
    } catch {
      /* store 还没建出来，忽略 */
    }
  }
  const p = useProviders()
  p.providers.value = []
  p.loaded.value = false
  useTools().loaded.value = false
}

async function mountSettings() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: Blank }],
  })
  await router.push('/settings')
  await router.isReady()
  const w = mount(SettingsView, { global: { plugins: [router] } })
  await flushPromises()
  await nextTick()
  return w
}

/** 打开「添加模型」弹层 */
async function openAddModel(w: Awaited<ReturnType<typeof mountSettings>>) {
  const btns = w.findAll('button')
  const add = btns.find((b) => b.text().includes('添加模型'))
  expect(add, '找不到「添加模型」按钮').toBeTruthy()
  await add!.trigger('click')
  await nextTick()
  return w
}

/** 弹层里的 API Key 输入框（它刻意不绑 value，所以要按 placeholder 找） */
function keyInput(w: Awaited<ReturnType<typeof mountSettings>>) {
  const el = w
    .find('.modal')
    .findAll('input[type="text"]')
    .find((i) => i.attributes('placeholder') === 'sk-...')
  expect(el, '找不到 API Key 输入框').toBeTruthy()
  return el!
}

function findButton(w: Awaited<ReturnType<typeof mountSettings>>, label: string) {
  const b = w.findAll('button').find((x) => x.text().trim() === label)
  expect(b, `找不到「${label}」按钮`).toBeTruthy()
  return b!
}

describe('设置页：填 API Key 后点各种复选框，Key 不能丢', () => {
  beforeEach(resetAll)

  it('点「显示密钥」不影响已填的 Key', async () => {
    const w = await mountSettings()
    await openAddModel(w)

    const KEY = 'sk-test-1234567890abcdef'
    await keyInput(w).setValue(KEY)
    expect((keyInput(w).element as HTMLInputElement).value).toBe(KEY)

    const showKey = w.findAll('.modal input[type="checkbox"]')[0]
    await showKey.setValue(true)
    await nextTick()

    expect(
      (keyInput(w).element as HTMLInputElement).value,
      '点「显示密钥」后 key 被清空了',
    ).toBe(KEY)
  })

  it('点「支持识图」「支持 JSON 输出」也不影响 Key', async () => {
    const w = await mountSettings()
    await openAddModel(w)

    const KEY = 'sk-abcdef1234567890'
    await keyInput(w).setValue(KEY)
    for (const c of w.findAll('.modal input[type="checkbox"]')) {
      await c.setValue(true)
      await nextTick()
    }

    expect(
      (keyInput(w).element as HTMLInputElement).value,
      '点复选框后 key 被清空了',
    ).toBe(KEY)
    // 'sk-abcdef1234567890' 是 19 个字符
    expect(w.text()).toContain(`已记录 ${KEY.length} 个字符`)
  })

  it('填完 Key 点保存，模型真的进了列表', async () => {
    const w = await mountSettings()
    await openAddModel(w)

    await keyInput(w).setValue('sk-save-me-123456')
    await w.find('.modal input[type="text"]').setValue('我的测试模型')

    await findButton(w, '保存').trigger('click')
    const ok = await waitFor(() => useProviders().providers.value.length === 1)

    expect(ok, `保存后应有 1 个模型，实际 ${useProviders().providers.value.length}`).toBe(true)
    expect(useProviders().providers.value[0].apiKey).toBe('sk-save-me-123456')
    // 保存成功要有明确反馈，不能静默
    expect(w.text()).toMatch(/已保存/)
  })

  it('没填 Key 点保存要给出可见提示，不能毫无反应', async () => {
    const w = await mountSettings()
    await openAddModel(w)

    await findButton(w, '保存').trigger('click')
    await flushPromises()
    await nextTick()

    expect(useProviders().providers.value.length).toBe(0)
    expect(w.text(), '保存失败必须显示原因').toMatch(/API Key 是空的/)
  })

  it('Key 只存在于 DOM（没触发 input 事件）时，保存也能拿到', async () => {
    const w = await mountSettings()
    await openAddModel(w)

    // 直接改 DOM 值、**不派发 input** —— 模拟 WebView 里粘贴不触发 input 的情况
    const el = keyInput(w).element as HTMLInputElement
    el.value = 'sk-pasted-without-event'

    await findButton(w, '保存').trigger('click')
    const ok = await waitFor(() => useProviders().providers.value.length === 1)

    expect(ok, 'DOM 里有值就应该能存下来').toBe(true)
    expect(useProviders().providers.value[0].apiKey).toBe('sk-pasted-without-event')
  })
})

describe('设置页：编辑已有模型', () => {
  beforeEach(resetAll)

  it('打开编辑后原有 Key 与字段都在', async () => {
    const p = useProviders()
    p.providers.value = [
      {
        id: 'pv_x',
        name: '已有模型',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-existing-key',
        model: 'deepseek-chat',
        supportsVision: false,
        supportsJson: true,
        temperature: 0.3,
        maxTokens: 2048,
        isDefault: true,
        createdAt: new Date().toISOString(),
      },
    ]
    // 必须把 loaded 置为 true，否则页面的 onMounted 会调 load()，
    // 从（空的）IndexedDB 重新读一遍，把刚注入的这份覆盖掉。
    p.loaded.value = true

    const w = await mountSettings()
    const edit = w.findAll('button').find((b) => b.text().trim() === '编辑')
    expect(edit, '找不到「编辑」按钮').toBeTruthy()
    await edit!.trigger('click')
    await nextTick()
    await nextTick()

    expect((keyInput(w).element as HTMLInputElement).value).toBe('sk-existing-key')
    const texts = w.findAll('.modal input[type="text"]')
    expect(texts.some((i) => (i.element as HTMLInputElement).value === '已有模型')).toBe(true)
  })
})

describe('设置页：工具开关', () => {
  beforeEach(resetAll)

  it('默认配置下联网工具就是可用的（开箱零配置）', async () => {
    const w = await mountSettings()
    expect(w.text()).toContain('工具当前状态')
    expect(w.text()).toMatch(/联网|搜索/)
  })
})
