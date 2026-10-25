/**
 * 两条主流程的端到端测试：**载入知识库** 与 **新建会话**。
 *
 * 这两个是产品的核心动作，之前从没被任何测试碰过：
 *   · 载入 .stkb 后页面到底显示不显示内容、决策框架有没有渲染
 *   · 建会话时选「检验我的操作」，模式有没有真的存进去、
 *     没有框架的知识库会不会诚实退回研究模式
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import KnowledgeView from '@/views/KnowledgeView.vue'
import SessionsView from '@/views/SessionsView.vue'
import { shouldUseNativeFieldSizing } from '@/lib/composer'
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
    // 必须挂到 document 上：定时校验会检查 document.activeElement，
    // 游离节点调 focus() 不会成为 activeElement，那条测试会假失败。
    const w = mount(SessionDetail, {
      global: { plugins: [router] },
      attachTo: document.body,
    })
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

  /**
   * 回归钉子：resizeComposer **不得**强制 `scrollTop = scrollHeight` 滚到底。
   * 真机反馈「输入的文字只会出现在最后面，没法在指针处打字」——
   * 强制到底把正在编辑的中间位置顶出视口；光标可见性交给浏览器原生行为。
   */
  it('不强制把 scrollTop 顶到底（仅代码路径）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    stubScrollHeight(el, 96)
    await ta.trigger('input')
    // 高度按内容算，但 scrollTop 不被程序改写成 scrollHeight
    expect(el.style.height).toBe('96px')
    expect(el.scrollTop).not.toBe(96)
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

  /**
   * 真机上「打字不变高、退格就正常」用事件层无论如何救不回来，
   * 所以加了一层不依赖事件的定时校验：聚焦期间每 150ms 检查一次高度。
   */
  it('聚焦期间定时校验高度（完全不依赖事件）', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement

    // 让 document.activeElement 指向它，否则定时器会跳过
    el.focus()
    await ta.trigger('focus')
    expect(document.activeElement).toBe(el)

    // 只改 scrollHeight，**不派发任何事件**
    stubScrollHeight(el, 84)
    await new Promise((r) => setTimeout(r, 220))
    expect(el.style.height).toBe('84px')

    await ta.trigger('blur')
  })

  it('失焦后停止校验，不再改动高度', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    const el = ta.element as HTMLTextAreaElement
    el.focus()
    await ta.trigger('focus')
    await ta.trigger('blur')
    el.blur()

    stubScrollHeight(el, 96)
    await new Promise((r) => setTimeout(r, 220))
    expect(el.style.height).not.toBe('96px')
  })

  /**
   * 用户反馈：输入框里打了字，点顶部的「已允许联网」开关，文字就没了。
   * 这类"点开关丢输入"通常来自组件重渲染或把 ref 重置了，必须钉住。
   */
  it('点「允许联网」开关不会清空已输入的文字', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    await ta.setValue('结合最近的行情，我这个持仓怎么样')
    expect((ta.element as HTMLTextAreaElement).value).toBe('结合最近的行情，我这个持仓怎么样')

    const chip = w.findAll('.chip.pick').find((c) => c.text().includes('联网'))
    expect(chip).toBeTruthy()
    await chip!.trigger('click')
    await flushPromises()
    await nextTick()

    // 开关生效
    expect(useSessions().sessions.value[0].allowOnline).toBe(true)
    // 文字还在
    const after = w.find('textarea').element as HTMLTextAreaElement
    expect(after.value).toBe('结合最近的行情，我这个持仓怎么样')
  })

  it('点「共享记忆」开关同样不清空文字', async () => {
    const w = await mountSession()
    const ta = w.find('textarea')
    await ta.setValue('测试文字')
    const chip = w.findAll('.chip.pick').find((c) => c.text().includes('记忆'))
    await chip!.trigger('click')
    await flushPromises()
    await nextTick()
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('测试文字')
  })

  /**
   * 真机上真正的成因：中文输入法组合态里 v-model 不会更新状态，
   * 此时点任何开关都会让输入框失焦 + 触发重渲染，
   * Vue 的 v-model 指令发现「DOM 值 ≠ 状态值」就把 DOM 覆盖成空 —— 文字就没了。
   *
   * 这里精确模拟：只改 DOM 的 value、不派发 input 事件（等价于组合态失同步），
   * 然后失焦 + 点开关，文字必须还在。
   */
  it('v-model 失同步时，失焦后点开关不能把文字冲掉', async () => {
    const w = await mountSession()
    const el = w.find('textarea').element as HTMLTextAreaElement
    el.value = '打了一半的句子' // 组合态：DOM 有字，Vue 状态还是空
    await nextTick()

    // 真机上点 chip 会先让输入框失焦
    await w.find('textarea').trigger('blur')

    const chip = w.findAll('.chip.pick').find((c) => c.text().includes('联网'))
    await chip!.trigger('click')
    await flushPromises()
    await nextTick()

    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('打了一半的句子')
  })

  /**
   * 微信式输入框：内容达到 3 行及以上（scrollHeight ≥ 88）时，
   * 左上角出现展开按钮；点击进入全屏编辑，再点收起回普通高度。
   * 全屏层用 <Teleport to="body">，断言走 document。
   */
  describe('微信式输入框：≥3 行出现展开按钮，可切全屏编辑', () => {
    it('不足 3 行（scrollHeight < 88）不显示展开按钮', async () => {
      const w = await mountSession()
      const ta = w.find('textarea')
      stubScrollHeight(ta.element as HTMLTextAreaElement, 70) // 2 行
      await ta.setValue('两行以内')
      await ta.trigger('input')
      await nextTick()
      await flushPromises()
      expect(w.find('.expand-btn').exists()).toBe(false)
    })

    it('达到 3 行（scrollHeight ≥ 88）出现展开按钮，且在回形针按钮上方', async () => {
      const w = await mountSession()
      const ta = w.find('textarea')
      const el = ta.element as HTMLTextAreaElement
      stubScrollHeight(el, 88) // 恰好 3 行
      await ta.setValue('三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十')
      await ta.trigger('input')
      await nextTick()
      await flushPromises()
      const btn = w.find('.expand-btn')
      expect(btn.exists()).toBe(true)
      // 按钮不在输入框内：位于回形针按钮（.attach）上方的 .attach-col 里
      const col = btn.element.parentElement
      expect(col!.classList.contains('attach-col')).toBe(true)
      const children = Array.from(col!.children)
      expect(children[0]).toBe(btn.element)
      expect(children[1].classList.contains('attach')).toBe(true)
      // 输入框仍在独立的 .ta-wrap 里，不包含按钮
      expect(el.parentElement!.classList.contains('ta-wrap')).toBe(true)
      expect(el.parentElement!.querySelector('.expand-btn')).toBeNull()
    })

    it('点击展开按钮进全屏，内容同步；再点收起恢复且内容保留', async () => {
      const w = await mountSession()
      const ta = w.find('textarea')
      const el = ta.element as HTMLTextAreaElement
      stubScrollHeight(el, 110) // 超过 3 行
      await ta.setValue('第一段很长很长需要折行的内容')
      await ta.trigger('input')
      await nextTick()
      await flushPromises()

      // 进入全屏
      await w.find('.expand-btn').trigger('click')
      await nextTick()
      await flushPromises()
      const fs = document.querySelector('.composer-fs')
      expect(fs).toBeTruthy()
      const fsTa = fs!.querySelector('textarea') as HTMLTextAreaElement
      // 全屏输入框带着折叠框里的内容
      expect(fsTa.value).toBe('第一段很长很长需要折行的内容')

      // 全屏里补内容（组合态式 DOM 直写 + input 事件）
      fsTa.value = '全屏里补一句'
      fsTa.dispatchEvent(new Event('input'))
      await nextTick()
      await flushPromises()

      // 收起回普通输入框
      const fsBtn = document.querySelector('.fs-btn') as HTMLElement
      expect(fsBtn).toBeTruthy()
      fsBtn.click()
      await nextTick()
      await flushPromises()
      expect(document.querySelector('.composer-fs')).toBeNull()
      // 折叠输入框带着全屏里补的内容（同一 input 状态）
      expect(el.value).toBe('全屏里补一句')
    })
  })

  describe('加号工具栏与对比请教', () => {
    // 双轨生成会并发 fetch；测试里立即失败（两侧 error 落定），
    // 不依赖真实网络的失败时序，pending 才能在 flushPromises 后稳定为 false
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('mock network down')
        }),
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('点加号展开微信式工具栏（图片/对比），加号变减号，再点收起', async () => {
      const w = await mountSession()
      // 初始：无工具栏
      expect(w.find('.tool-sheet').exists()).toBe(true)
      expect((w.find('.tool-sheet').element as HTMLElement).style.display).toBe('none')
      const plus = w.find('button[aria-label="工具栏"]')
      expect(plus.exists()).toBe(true)

      await plus.trigger('click')
      await nextTick()
      const sheet = w.find('.tool-sheet')
      expect(sheet.isVisible()).toBe(true)
      const cells = w.findAll('.tool-cell')
      expect(cells.length).toBe(2)
      expect(w.text()).toContain('图片')
      expect(w.text()).toContain('对比')
      // 展开态：加号 → 减号（只剩一条横线路径）
      expect(w.find('button[aria-label="工具栏"] .attach').exists() || plus.classes('on')).toBe(true)

      // 再点收起
      await plus.trigger('click')
      await nextTick()
      expect(w.find('.tool-sheet').isVisible()).toBe(false)
    })

    it('点「对比」进入对比模式，出提示条；发送后双轨生成 parallel 消息', async () => {
      const w = await mountSession()
      await w.find('button[aria-label="工具栏"]').trigger('click')
      await nextTick()
      const compareCell = w.findAll('.tool-cell').find((c) => c.text().includes('对比'))
      await compareCell!.trigger('click')
      await nextTick()
      // 对比模式提示条出现，工具栏收起
      expect(w.find('.compare-banner').exists()).toBe(true)
      expect(w.text()).toContain('对比请教')

      const ta = w.find('textarea')
      await ta.setValue('帮我看看半导体这个持仓')
      await nextTick()
      const btn = w.findAll('button').find((b) => b.text().includes('发送'))
      await btn!.trigger('click')
      await flushPromises()
      await nextTick()

      const msgs = useSessions().sessions.value[0].messages
      const last = msgs[msgs.length - 1]
      // 双轨结构：军师 + 专业分析，两套独立
      expect(last.parallel).toBeTruthy()
      expect(last.parallel!.advisor).toBeTruthy()
      expect(last.parallel!.analyst).toBeTruthy()
      expect(last.parallel!.active).toBe('advisor')
      expect(last.pending).toBe(false)
      // 对比模式一次用完退出
      expect(w.find('.compare-banner').exists()).toBe(false)
    })

    it('切换按钮切的是全局视角：所有对比消息一起切换，数据层默认值不变', async () => {
      const w = await mountSession()
      await w.find('button[aria-label="工具栏"]').trigger('click')
      await nextTick()
      const compareCell = w.findAll('.tool-cell').find((c) => c.text().includes('对比'))
      await compareCell!.trigger('click')
      await nextTick()
      const ta = w.find('textarea')
      await ta.setValue('对比测试问题')
      await nextTick()
      const btn = w.findAll('button').find((b) => b.text().includes('发送'))
      await btn!.trigger('click')
      await flushPromises()
      await nextTick()

      // 默认显示军师侧标签
      expect(w.text()).toContain('军师观点')

      // 右侧可拖动切换按钮存在
      const sw = document.querySelector('.cmp-switch') as HTMLElement
      expect(sw).toBeTruthy()

      // 点击切换 → 全局切到专业分析
      sw.click()
      await nextTick()
      expect(w.text()).toContain('专业分析')

      // 再点切回军师
      sw.click()
      await nextTick()
      expect(w.text()).toContain('军师观点')

      // 全局切换只改视图，不改消息数据层默认值（active 仍是生成时的 advisor）
      const msgs = useSessions().sessions.value[0].messages
      expect(msgs[msgs.length - 1].parallel!.active).toBe('advisor')
    })

    it('全局切换覆盖所有对比消息：上翻历史只看到同一种回答', async () => {
      const w = await mountSession()
      // 直接往会话里塞 3 条对比消息（模拟历史对比）
      const s = useSessions().sessions.value[0]
      const makeParallel = (tag: string) => ({
        id: `p_${tag}`,
        role: 'assistant' as const,
        content: '',
        createdAt: new Date().toISOString(),
        pending: false,
        parallel: {
          advisor: { content: `军师-${tag}` },
          analyst: { content: `分析-${tag}` },
          active: 'advisor' as const,
        },
      })
      s.messages.push(makeParallel('第一条'), makeParallel('第二条'), makeParallel('第三条'))
      await nextTick()

      // 默认全部显示军师侧
      expect(w.text()).toContain('军师-第一条')
      expect(w.text()).toContain('军师-第三条')
      expect(w.text()).not.toContain('分析-第一条')

      // 切换按钮 → 全部变专业分析（不是只切最新一条）
      const sw = document.querySelector('.cmp-switch') as HTMLElement
      sw.click()
      await nextTick()
      expect(w.text()).toContain('分析-第一条')
      expect(w.text()).toContain('分析-第三条')
      expect(w.text()).not.toContain('军师-第一条')
    })

    it('对比消息分页：默认只显示最近 5 条，更早的折叠在「加载更多」', async () => {
      const w = await mountSession()
      const s = useSessions().sessions.value[0]
      const makeParallel = (tag: string) => ({
        id: `p_${tag}`,
        role: 'assistant' as const,
        content: '',
        createdAt: new Date().toISOString(),
        pending: false,
        parallel: {
          advisor: { content: `军师-${tag}` },
          analyst: { content: `分析-${tag}` },
          active: 'advisor' as const,
        },
      })
      // 6 条对比消息（超过默认页大小 5）
      for (let i = 1; i <= 6; i++) s.messages.push(makeParallel(`第${i}条`))
      await nextTick()

      // 最近 5 条可见（第2~6条），第 1 条折叠，出现加载更多
      expect(w.text()).toContain('军师-第6条')
      expect(w.text()).toContain('军师-第2条')
      expect(w.text()).not.toContain('军师-第1条')
      expect(w.text()).toContain('加载更多对比回答（还有 1 条）')

      // 点击加载更多 → 第 1 条出现，按钮消失
      await w.find('.load-more').trigger('click')
      await nextTick()
      expect(w.text()).toContain('军师-第1条')
      expect(w.find('.load-more').exists()).toBe(false)

      // 全局切换在分页展开后仍然作用于全部
      const sw = document.querySelector('.cmp-switch') as HTMLElement
      sw.click()
      await nextTick()
      expect(w.text()).toContain('分析-第1条')
      expect(w.text()).not.toContain('军师-第6条')
    })

    it('切换按钮可拖动：pointer 拖动后位置变化', async () => {
      const w = await mountSession()
      await w.find('button[aria-label="工具栏"]').trigger('click')
      await nextTick()
      const compareCell = w.findAll('.tool-cell').find((c) => c.text().includes('对比'))
      await compareCell!.trigger('click')
      await nextTick()
      const ta = w.find('textarea')
      await ta.setValue('拖动测试')
      await nextTick()
      const btn = w.findAll('button').find((b) => b.text().includes('发送'))
      await btn!.trigger('click')
      await flushPromises()
      await nextTick()

      const sw = document.querySelector('.cmp-switch') as HTMLElement
      expect(sw).toBeTruthy()
      const before = sw.style.transform
      // pointerdown 从 (100,100) 拖到 (260,340)：位移 > 4px 视为拖动
      sw.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      sw.dispatchEvent(new PointerEvent('pointermove', { clientX: 260, clientY: 340, bubbles: true }))
      await nextTick()
      const after = sw.style.transform
      expect(after).not.toBe(before)
      expect(after).toContain('translate(')
    })

    it('切换按钮待机：5s 无交互进入半隐（docked），触碰恢复', async () => {
      const w = await mountSession()
      // 发送一条对比，让按钮出现（真实 timers 完成挂载/发送）
      await w.find('button[aria-label="工具栏"]').trigger('click')
      await nextTick()
      const compareCell = w.findAll('.tool-cell').find((c) => c.text().includes('对比'))
      await compareCell!.trigger('click')
      await nextTick()
      const ta = w.find('textarea')
      await ta.setValue('待机测试')
      await nextTick()
      const btn = w.findAll('button').find((b) => b.text().includes('发送'))
      await btn!.trigger('click')
      await flushPromises()
      await nextTick()

      const sw = document.querySelector('.cmp-switch') as HTMLElement
      expect(sw).toBeTruthy()
      expect(sw.classList.contains('docked')).toBe(false)

      // 启用 fake timers，做一次轻点（pointerdown+up，不移动）重新计时
      vi.useFakeTimers()
      try {
        sw.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 20, bubbles: true }))
        sw.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 20, bubbles: true }))
        await vi.advanceTimersByTimeAsync(5000)
        // 5s 无交互 → 半隐
        expect(sw.classList.contains('docked')).toBe(true)
        // 半隐时 transform 带右移偏移（半边出屏）
        expect(sw.style.transform).toContain('28px')

        // 再次触碰 → 恢复全显 + 取消暗淡
        sw.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 20, bubbles: true }))
        await nextTick()
        expect(sw.classList.contains('docked')).toBe(false)
        expect(sw.style.transform).not.toContain('28px')
      } finally {
        vi.useRealTimers()
      }
    })

    it('切换按钮待机：用户主动右移松手立即半隐，触碰恢复', async () => {
      const w = await mountSession()
      await w.find('button[aria-label="工具栏"]').trigger('click')
      await nextTick()
      const compareCell = w.findAll('.tool-cell').find((c) => c.text().includes('对比'))
      await compareCell!.trigger('click')
      await nextTick()
      const ta = w.find('textarea')
      await ta.setValue('右移测试')
      await nextTick()
      const btn = w.findAll('button').find((b) => b.text().includes('发送'))
      await btn!.trigger('click')
      await flushPromises()
      await nextTick()

      const sw = document.querySelector('.cmp-switch') as HTMLElement
      // 拖到屏幕右半（jsdom 视口 1024 宽，中心 512；按钮中心过中线即右移）
      sw.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      sw.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 120, bubbles: true }))
      sw.dispatchEvent(new PointerEvent('pointerup', { clientX: 800, clientY: 120, bubbles: true }))
      await nextTick()
      expect(sw.classList.contains('docked')).toBe(true)

      // 触碰恢复
      sw.dispatchEvent(new PointerEvent('pointerdown', { clientX: 800, clientY: 120, bubbles: true }))
      await nextTick()
      expect(sw.classList.contains('docked')).toBe(false)
    })
  })

  describe('输入框光标保护（field-sizing 收手判定）', () => {
    it('只有安卓真机 + 浏览器支持 field-sizing 时才让 JS 收手', () => {
      // 真机：Android + 支持 → 收手（不碰 height，避免重排打断输入法光标）
      expect(
        shouldUseNativeFieldSizing('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0', () => true),
      ).toBe(true)
      // 桌面浏览器：CSS.supports 对未知属性也可能返回 true，但不能收手
      // （开发调试没有安卓输入法组合态问题，JS 高度兜底继续跑）
      expect(
        shouldUseNativeFieldSizing('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0', () => true),
      ).toBe(false)
      // 安卓但浏览器不支持 field-sizing（旧 WebView）→ 走 JS 兜底
      expect(
        shouldUseNativeFieldSizing('Mozilla/5.0 (Linux; Android 10) Chrome/91.0', () => false),
      ).toBe(false)
    })
  })
})
