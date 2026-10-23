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
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import KnowledgeView from '@/views/KnowledgeView.vue'
import SessionsView from '@/views/SessionsView.vue'
import { useKnowledge } from '@/stores/knowledge'
import { useSessions } from '@/stores/sessions'
import { useProviders } from '@/stores/providers'
import { parseKbBytes } from '@/services/kb'
import { hasPersona } from '@/services/persona'
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

describe('仓库里所有演示知识库都必须带决策框架', () => {
  /**
   * 曾经踩过的坑：demo_junshi_1/2/3 只有历史观点、没有 persona，
   * 用户载入后新建会话，App 提示「请教军师需要知识库里带决策框架」——
   * 看起来像 bug，其实是那几份库确实没有。
   *
   * 演示库的用途就是让人一眼看懂功能，**每一份都应该能直接演示军师模式**。
   */
  const KB_DIR = resolve(__dirname, '../../data/kb')
  const files = readdirSync(KB_DIR).filter(
    (f) => f.startsWith('demo_junshi') && f.endsWith('.stkb'),
  )

  it('至少存在一个演示知识库', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const name of files) {
    it(`${name} 带可用的决策框架`, () => {
      const bytes = new Uint8Array(readFileSync(resolve(KB_DIR, name)))
      const { kb } = parseKbBytes(bytes, bytes.byteLength)
      expect(hasPersona(kb.author)).toBe(true)
      // 军师模式渲染需要方法论；只有 rules 没有 frameworks 也能跑，但有框架更好
      expect((kb.author.persona?.frameworks?.length ?? 0)).toBeGreaterThan(0)
      expect((kb.author.persona?.decision_rules?.length ?? 0)).toBeGreaterThan(0)
    })

    it(`${name} 的 kb_id 不与其它演示库重复`, () => {
      const bytes = new Uint8Array(readFileSync(resolve(KB_DIR, name)))
      const { kb } = parseKbBytes(bytes, bytes.byteLength)
      const same = files.filter((f) => {
        if (f === name) return false
        const b = new Uint8Array(readFileSync(resolve(KB_DIR, f)))
        return parseKbBytes(b, b.byteLength).kb.manifest.kb_id === kb.manifest.kb_id
      })
      // 相同 kb_id 会被 App 当成「同库升级、覆盖」，载入多个只剩一个
      expect(same).toEqual([])
    })
  }
})

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

describe('底栏「会话」：从别的模块点回来要回到上次那个会话', () => {
  /**
   * 用户反馈：在某个会话里 → 点「记忆」→ 点回「会话」，会被踢回列表，
   * 得重新找那一场。底栏的「会话」原来写死跳 `/`。
   */
  beforeEach(resetAll)

  it('create 会记下刚建的会话', async () => {
    const s = useSessions()
    const sess = await s.create({ title: '测试会话' } as never)
    expect(s.lastSessionId.value).toBe(sess.id)
  })

  it('markOpened 能更新，也能清空', () => {
    const s = useSessions()
    s.markOpened('ss_x')
    expect(s.lastSessionId.value).toBe('ss_x')
    s.markOpened(null)
    expect(s.lastSessionId.value).toBeNull()
  })

  it('不在会话模块时，会话 tab 指向上次的会话', async () => {
    const s = useSessions()
    const sess = await s.create({ title: '要回到的会话' } as never)
    s.loaded.value = true

    const router = await makeRouter()
    await router.push('/memory')
    await router.isReady()
    const { default: App } = await import('@/App.vue')
    const w = mount(App, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    const link = w.findAll('.tabbar a')[0]
    expect(link.attributes('href') ?? link.attributes('to')).toContain(`/s/${sess.id}`)
  })

  it('已经在会话模块时，会话 tab 指向列表（方便切换）', async () => {
    const s = useSessions()
    const sess = await s.create({ title: '当前会话' } as never)
    s.loaded.value = true

    const router = await makeRouter()
    await router.push(`/s/${sess.id}`)
    await router.isReady()
    const { default: App } = await import('@/App.vue')
    const w = mount(App, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    const link = w.findAll('.tabbar a')[0]
    const href = link.attributes('href') ?? link.attributes('to') ?? ''
    // 语义：在会话模块内部时不该再指向某个具体会话，而是回列表方便切换
    expect(href).not.toContain('/s/')
  })

  it('上次的会话已被删除时退回列表，不落到空页面', async () => {
    const s = useSessions()
    const sess = await s.create({ title: '将被删除' } as never)
    s.loaded.value = true
    await s.remove(sess.id)

    const router = await makeRouter()
    await router.push('/kb')
    await router.isReady()
    const { default: App } = await import('@/App.vue')
    const w = mount(App, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()

    const link = w.findAll('.tabbar a')[0]
    const href = link.attributes('href') ?? link.attributes('to') ?? ''
    expect(href).not.toContain('/s/')
  })
})

describe('会话详情：能打字就必须能发送', () => {
  /**
   * 用户反馈：输入框里明明有字，但「发送」按钮是灰的、点不动。
   *
   * 按钮的禁用条件是 `!input.trim() && !attached.length` ——
   * 也就是说输入框里只要有字就必须可点。这里把那条款式化地钉住：
   * 打字 → 按钮可用 → 点下去真的把消息进了会话。
   */
  beforeEach(resetAll)

  async function mountSession() {
    // 有模型，避免 noProvider 走「去设置里配」的提示分支
    const p = useProviders()
    p.providers.value = [
      {
        id: 'pv_test',
        name: '测试模型',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        supportsVision: false,
        supportsJson: true,
        temperature: 0.3,
        maxTokens: 512,
        isDefault: true,
        createdAt: new Date().toISOString(),
      },
    ]
    p.loaded.value = true

    const s = useSessions()
    const session = await s.create({
      title: '新会话',
      activeKbIds: [],
      useGlobalMemory: true,
      mode: 'research',
      personaAuthorUid: null,
      auditContext: null,
    } as never)
    s.loaded.value = true

    const router = await makeRouter()
    await router.push(`/s/${session.id}`)
    await router.isReady()
    const { default: SessionDetail } = await import('@/views/SessionDetail.vue')
    const w = mount(SessionDetail, { global: { plugins: [router] } })
    await flushPromises()
    await nextTick()
    return w
  }

  it('发送按钮**永远可点**（不因输入内容变灰）', async () => {
    // 曾经的实现按 `!input.trim()` 禁用按钮。问题在于输入法的组合态下
    // v-model 可能还没同步，输入框里明明有字，按钮却是灰的、点不动。
    // 现在改成永远可点，空内容时给可见提示。
    const w = await mountSession()
    const btn = w.findAll('button').find((b) => b.text().includes('发送'))
    expect(btn).toBeTruthy()
    expect(btn!.attributes('disabled')).toBeUndefined()
  })

  it('输入文字后点击发送，消息真的进入会话', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    expect(ta.exists()).toBe(true)
    await ta.setValue('结合最近的行情，我这个持仓怎么样')
    await nextTick()
    const btn = w.findAll('button').find((b) => b.text().includes('发送'))
    expect(btn!.attributes('disabled')).toBeUndefined()
    await btn!.trigger('click')
    await flushPromises()
    // 发送会给会话追加一条 user 消息（网络请求的失败不影响入列）
    const msgs = useSessions().sessions.value[0].messages
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('持仓'))).toBe(true)
  })

  it('空内容点击发送给可见提示，而不是静默无反应', async () => {
    const w = await mountSession()
    const btn = w.findAll('button').find((b) => b.text().includes('发送'))
    await btn!.trigger('click')
    await flushPromises()
    await nextTick()
    expect(w.text()).toContain('还没输入内容')
  })

  it('v-model 失同步时仍能发送（读 DOM 兜底）', async () => {
    // 模拟真实机型上出现过的情形：DOM 里有字，但 Vue 状态是空的。
    // 做法是直接改 DOM 的 value 而不触发 input 事件 —— v-model 感知不到。
    const w = await mountSession()
    const ta = w.find('textarea').element as HTMLTextAreaElement
    ta.value = '结合最近的行情，我这个持仓怎么样'
    await nextTick()
    const btn = w.findAll('button').find((b) => b.text().includes('发送'))
    await btn!.trigger('click')
    await flushPromises()
    const msgs = useSessions().sessions.value[0].messages
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('持仓'))).toBe(true)
  })

  /**
   * 下面这几条是**只验代码路径**的测试：
   * jsdom 没有布局引擎，scrollHeight 恒为 0，只能打桩。
   * 所以它们能证明「resizeComposer 按 scrollHeight 算出高度并写了 style」，
   * **不能证明真实浏览器里框子会变高**。
   *
   * 真实布局由 `pnpm test:layout`（tools/run_composer_layout_test.mjs，
   * 用 Edge/Chrome headless 实测）覆盖，那条才是交付依据。
   * 这个区分是踩过坑才写清楚的：曾经只靠打桩测试就交付了自增高，
   * 用户在真机上发现根本没变高。
   */
  function stubScrollHeight(el: HTMLTextAreaElement, h: number) {
    Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true })
  }

  it('按 scrollHeight 计算高度（仅代码路径）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    stubScrollHeight(ta.element as HTMLTextAreaElement, 96)
    await ta.trigger('input')
    expect((ta.element as HTMLTextAreaElement).style.height).toBe('96px')
  })

  it('高度封顶 130px（仅代码路径）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    stubScrollHeight(ta.element as HTMLTextAreaElement, 600)
    await ta.trigger('input')
    expect((ta.element as HTMLTextAreaElement).style.height).toBe('130px')
  })

  it('把 scrollTop 顶到底（仅代码路径）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    stubScrollHeight(el, 96)
    await ta.trigger('input')
    expect(el.scrollTop).toBe(96)
  })

  it('发送后高度缩回（仅代码路径）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    stubScrollHeight(el, 96)
    await ta.setValue('发一条测试')
    await ta.trigger('input')
    expect(el.style.height).toBe('96px')

    stubScrollHeight(el, 40)
    const btn = w.findAll('button').find((b) => b.text().includes('发送'))
    await btn!.trigger('click')
    await flushPromises()
    await nextTick()
    expect(el.style.height).toBe('40px')
  })

  /**
   * 中文输入法的组合态问题（真机才暴露）：
   *   打字时文字处于组合态，Android WebView 会推迟重排，
   *   此刻 scrollHeight 还是旧值 → 框子不变高；
   *   退格不是组合态 → 立即重排 → 正常。
   * 所以 `compositionend` 必须也触发重算。
   */
  it('输入法组合结束会重算高度', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    stubScrollHeight(el, 84)
    await ta.trigger('compositionend')
    expect(el.style.height).toBe('84px')
  })

  it('input 之后下一帧会再算一次（兜住组合态的重排推迟）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    stubScrollHeight(el, 50)
    await ta.trigger('input')
    expect(el.style.height).toBe('50px')

    // 模拟「事件当帧读到旧值、重排完成后变高」
    stubScrollHeight(el, 78)
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    expect(el.style.height).toBe('78px')
  })
})
