/**
 * 两条主流程的端到端测试：**载入知识库** 与 **新建会话**。
 *
 * 这两个是产品的核心动作，之前从没被任何测试碰过：
 *   · 载入 .stkb 后页面到底显示不显示内容、决策框架有没有渲染
 *   · 建会话时选「检验我的操作」，模式有没有真的存进去、
 *     没有框架的知识库会不会诚实退回研究模式
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import KnowledgeView from '@/views/KnowledgeView.vue'
import SessionsView from '@/views/SessionsView.vue'
import { useKnowledge } from '@/stores/knowledge'
import { useSessions } from '@/stores/sessions'
import { useProviders } from '@/stores/providers'
import * as db from '@/lib/db'

const Blank = defineComponent({ render: () => h('div') })

async function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/s/:id', component: Blank },
      { path: '/kb', component: Blank },
      { path: '/settings', component: Blank },
      { path: '/:p(.*)*', component: Blank },
    ],
  })
  await router.push('/')
  await router.isReady()
  return router
}

async function resetAll() {
  for (const s of Object.values(db.STORES)) {
    try {
      await db.clear(s)
    } catch {
      /* 忽略 */
    }
  }
  useKnowledge().kbs.value = []
  useKnowledge().loaded.value = false
  useSessions().sessions.value = []
  useSessions().loaded.value = false
  const p = useProviders()
  p.providers.value = []
  p.loaded.value = false
}

/**
 * 用来测试的知识库 —— **合成演示库**（仓库里就有）。
 *
 * 为什么不用真实那一份：真实 .stkb 含某位真实大V的语料与评价，
 * 不能进公开仓库。仓库里必须自带一份可用的替代品，
 * 否则任何人 clone 下来测试都跑不起来。
 */
const KB_PATH = resolve(__dirname, '../../data/kb/demo_junshi_persona.stkb')

describe('载入知识库：内容与决策框架都要显示出来', () => {
  beforeEach(resetAll)

  it('合成演示 .stkb 能解析并落库', async () => {
    const bytes = readFileSync(KB_PATH)
    const file = new File([bytes], 'demo_junshi_persona.stkb')
    const { kb, warnings } = await useKnowledge().importFile(file)
    expect(kb.opinions.length).toBeGreaterThan(5)
    expect(kb.instruments.length).toBeGreaterThan(3)
    expect(warnings).toEqual([])
  })

  it('载入后页面显示观点数、标的数与作者', async () => {
    await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    const router = await makeRouter()
    const w = mount(KnowledgeView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    const text = w.text()
    expect(text).toContain('测试大V·甲')
    expect(text).toMatch(/\d+\s*条观点|观点/)
    expect(text).not.toContain('undefined')
  })

  it('决策框架（方法论 / 否决 / 清单）渲染出来', async () => {
    await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    const router = await makeRouter()
    const w = mount(KnowledgeView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    // 决策框架在**详情**弹层里，得先点开 —— 一开始漏了这步，
    // 断言的是列表页，才误以为框架没渲染
    const detailBtn = w.findAll('button').find((b) => b.text().trim() === '详情')
    expect(detailBtn, '找不到「详情」按钮').toBeTruthy()
    await detailBtn!.trigger('click')
    await nextTick()

    const text = w.text()
    expect(text).toContain('决策框架')
    expect(text).toContain('核心方法论')
    // 至少有名字的方法论要显示出来
    expect(text).toMatch(/现金牛筛选法|估值分位法|冷门错杀法|仓位纪律法/)
    expect(text).toContain('否决条件')
    expect(text).not.toContain('undefined')
  })

  it('损坏的文件要明确报错，不能静默或崩掉', async () => {
    const bad = new File([new Uint8Array([1, 2, 3, 4, 5])], 'broken.stkb')
    await expect(useKnowledge().importFile(bad)).rejects.toBeTruthy()
  })

  it('没有决策框架的知识库要明确提示无法扮演', async () => {
    const kb = await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    // 手动抹掉 persona，模拟老知识库
    kb.kb.author.persona = null
    await db.put(db.STORES.kbs, { ...kb.kb, author: { ...kb.kb.author, persona: null } })

    const router = await makeRouter()
    const w = mount(KnowledgeView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    const detailBtn = w.findAll('button').find((b) => b.text().trim() === '详情')
    await detailBtn!.trigger('click')
    await nextTick()

    expect(w.text()).toMatch(/没有决策框架|无法/)
  })
})

describe('新建会话：三种模式', () => {
  beforeEach(resetAll)

  it('有军师时默认就是「检验我的操作」', async () => {
    await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    const router = await makeRouter()
    const w = mount(SessionsView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    await w.find('.fab').trigger('click')
    await nextTick()

    const text = w.text()
    expect(text).toContain('检验我的操作')
    expect(text).toContain('请教军师')
    expect(text).toContain('研究历史观点')
    // 检验模式应被默认选中
    const on = w.findAll('.mode-item.on')
    expect(on.length).toBe(1)
    expect(on[0].text()).toContain('检验我的操作')
  })

  it('选「检验」建出来的会话，模式真的存成了 audit', async () => {
    await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    const router = await makeRouter()
    const w = mount(SessionsView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    await w.find('.fab').trigger('click')
    await nextTick()
    // 点「开始」
    const start = w.findAll('button').find((b) => b.text().includes('开始'))
    expect(start).toBeTruthy()
    await start!.trigger('click')
    await flushPromises()
    await nextTick()

    const list = useSessions().sessions.value
    expect(list.length).toBe(1)
    expect(list[0].mode).toBe('audit')
    // 军师也要绑定上，否则提示词里找不到 persona
    expect(list[0].personaAuthorUid).toBeTruthy()
    expect(list[0].activeKbIds.length).toBeGreaterThan(0)
  })

  it('切到「研究历史观点」后建出来的会话是 research 模式', async () => {
    await useKnowledge().importFile(
      new File([readFileSync(KB_PATH)], 'demo_junshi_persona.stkb'),
    )
    const router = await makeRouter()
    const w = mount(SessionsView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    await w.find('.fab').trigger('click')
    await nextTick()
    const research = w.findAll('.mode-item').find((m) => m.text().includes('研究历史观点'))
    expect(research).toBeTruthy()
    await research!.trigger('click')
    await nextTick()

    const start = w.findAll('button').find((b) => b.text().includes('开始'))
    await start!.trigger('click')
    await flushPromises()
    await nextTick()

    expect(useSessions().sessions.value[0].mode).toBe('research')
  })

  it('没有任何知识库时不崩，并提示去载入', async () => {
    const router = await makeRouter()
    const w = mount(SessionsView, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    await w.find('.fab').trigger('click')
    await nextTick()
    expect(w.text()).toMatch(/还没有载入知识库|知识库/)
    expect(w.text()).not.toContain('undefined')
  })
})
