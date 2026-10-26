<script setup lang="ts">
/**
 * 会话详情（聊天）。
 *
 * 顶部常驻三个状态，因为它们决定了答案的解读方式：
 *   · 记忆开/关 —— 这条回答有没有考虑我的持仓
 *   · 军师 —— 用的是哪个知识库
 *   · 消息脚注 —— 每条回答生成时实际用了什么（事后可追溯）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AdvisorMode, ChatMessage, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import TabIcon from '@/components/TabIcon.vue'
import type { IconName } from '@/components/TabIcon.vue'
import { useMemory } from '@/stores/memory'
import { useProviders } from '@/stores/providers'
import SessionDrawer from '@/components/SessionDrawer.vue'
import NewSessionModal from '@/components/NewSessionModal.vue'
import { renderMarkdown } from '@/lib/fmt'
import { compressImage, fileToDataUrl } from '@/services/llm'

const MODE_META: Record<AdvisorMode, { icon: IconName; name: string }> = {
  audit: { icon: 'search', name: '检验模式' },
  persona: { icon: 'person', name: '军师模式' },
  research: { icon: 'kb', name: '研究模式' },
}

function modeIcon(m: AdvisorMode): IconName {
  return MODE_META[m]?.icon ?? 'kb'
}

function modeName(m: AdvisorMode): string {
  return MODE_META[m]?.name ?? '研究模式'
}

/** 快照时间 "20261026161458" → "10-26 16:14" */
function fmtSnapTime(t: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t)
  if (!m) return t
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/** 快照涨跌方向符号 */
function snapDir(s: { changePct: number }): string {
  return s.changePct > 0 ? '+' : s.changePct < 0 ? '-' : ''
}

const route = useRoute()
const router = useRouter()
const sessions = useSessions()
const knowledge = useKnowledge()
const memory = useMemory()
const { providers, load: loadProviders } = useProviders()

const sessionId = computed(() => String(route.params.id || ''))
const session = computed<Session | undefined>(() => sessions.find(sessionId.value))

const input = ref('')
const taEl = ref<HTMLTextAreaElement | null>(null)
const attached = ref<string[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const chatEl = ref<HTMLElement | null>(null)
const showKbPicker = ref(false)
const kbDraft = ref<string[]>([])
const error = ref('')

/** 左侧会话栏（三横线打开） */
const drawerOpen = ref(false)

/** 新建会话弹窗：从会话栏「＋ 新建会话」在当前页直接展开（不跳列表页） */
const newSessionOpen = ref(false)

/**
 * 微信式输入框：内容达到 3 行及以上时，左上角出现小按钮，
 * 点击进入全屏编辑；全屏时左上角按钮点击收起回普通高度。
 */
const composerFs = ref(false)
const showExpandBtn = ref(false)
const fsEl = ref<HTMLTextAreaElement | null>(null)
// 3 行阈值：单行 = 15px × 1.55 行高 = 23.25px，3 行内容 = 69.75px，
// 加上下 padding 18px → scrollHeight ≥ 88 即表示内容已到 3 行
const EXPAND_THRESHOLD = 88

function updateExpandBtn() {
  const el = taEl.value
  if (!el || composerFs.value) return
  showExpandBtn.value = el.scrollHeight >= EXPAND_THRESHOLD
}

function openComposerFs() {
  composerFs.value = true
  // 等全屏层挂好：先把折叠框的内容搬进全屏框（非受控，必须手动搬），再聚焦
  nextTick(() => {
    if (fsEl.value) fsEl.value.value = input.value
    fsEl.value?.focus()
  })
}

function closeComposerFs() {
  composerFs.value = false
  nextTick(() => {
    // 全屏框内容搬回折叠框（非受控，必须手动搬）
    if (taEl.value) taEl.value.value = input.value
    taEl.value?.focus()
    updateExpandBtn()
  })
}

/** 全屏输入框（非受控）：把 DOM 值同步进影子状态，组合态里不动（见 onComposerInput） */
function onFsInput() {
  const el = fsEl.value
  if (!el) return
  // 与折叠框同一规则：组合态里不同步 value、不动光标（见 onComposerInput 注释）
  if (composing || inImeComposition(el)) return
  const caret = snapshotCaret(el)
  if (el.value !== input.value) input.value = el.value
  restoreAfterRender(el, caret)
}

/** 全屏框失焦：非组合态把最新文本收进影子状态；组合态残渣不进状态 */
function onFsBlur() {
  const el = fsEl.value
  if (el && !(composing || inImeComposition(el)) && el.value !== input.value) {
    input.value = el.value
  }
  composing = false
}

/**
 * 光标护栏（两个输入框共用）。
 *
 * 为什么需要这层：真机反馈「把光标移到中间再打字，字还是出现在末尾」。
 * 任何一次 `el.value = ...` 重新赋值都会把光标甩到末尾，而
 * Vue 的 `v-model` 在中文输入法组合态下会用自己的过期状态覆盖 DOM。
 *
 * 历史上已经为这条堵过三次（禁用按钮、watch 兜底、compositionend），
 * 每次换机型又冒出来。所以改成**不依赖成因的兜底**：
 * 动手前记住光标，等 Vue 重渲染完再还回去。
 */
function snapshotCaret(el: HTMLTextAreaElement | null): Caret | null {
  if (!el) return null
  // 没聚焦就没有"用户的光标"可言，别记
  return document.activeElement === el ? readCaret(el) : null
}

function restoreAfterRender(el: HTMLTextAreaElement | null, caret: Caret | null): void {
  if (!el || !caret) return
  void nextTick().then(() => restoreCaret(el, caret))
}

/**
 * 加号工具栏（微信式）：输入框左侧加号，点击展开图片/对比工具，
 * 加号变减号，再点收起。
 */
const toolSheet = ref(false)
const compareMode = ref(false)

function toggleToolSheet() {
  toolSheet.value = !toolSheet.value
  if (!toolSheet.value) compareMode.value = false // 关面板时顺带退出对比模式
}

function onPickImage() {
  toolSheet.value = false
  fileInput.value?.click()
}

function onPickCompare() {
  toolSheet.value = false
  compareMode.value = true
}

/**
 * 对比请教的消息展示：一条 parallel 消息里有军师/专业分析两套回答。
 *
 * 切换是**全局视角**：`compareView` 决定所有对比消息当前显示哪一侧，
 * 切换按钮只改这一个 ref（零遍历、零负担），上翻历史时每一轮对比
 * 都只看到同一种回答（全军师 或 全专业分析），不会一条一条混着来。
 * 消息数据里的 `m.parallel.active` 是生成时的默认值，渲染时不参与判断。
 */
const compareView = ref<'advisor' | 'analyst'>('advisor')

function activeSide(m: ChatMessage) {
  if (!m.parallel) return null
  return compareView.value === 'analyst' ? m.parallel.analyst : m.parallel.advisor
}

function flipCompareView() {
  compareView.value = compareView.value === 'advisor' ? 'analyst' : 'advisor'
}

/** 当前激活侧的、已展开详情的工具记录 */
function sideOpenTools(m: ChatMessage) {
  const side = activeSide(m)
  return (side?.toolCalls ?? []).filter((x) => x.detail && openDetails.value.has(x.id))
}

/** 会话最后一条是 parallel（含生成中）时显示右侧切换按钮 */
const showCmpSwitch = computed(() => {
  const last = session.value?.messages[session.value.messages.length - 1]
  return Boolean(last?.parallel)
})

/**
 * 对比消息分页：默认只渲染最近 5 条对比回复（防止超长会话里
 * 历史对比消息拖慢渲染/滚动），更早的折叠，点「加载更多」逐批展开。
 */
const PARALLEL_PAGE = 5
const parallelLimit = ref(PARALLEL_PAGE)

const parallelCtx = computed(() => {
  const msgs = session.value?.messages ?? []
  const pIdx: number[] = []
  msgs.forEach((m, i) => {
    if (m.parallel) pIdx.push(i)
  })
  const visible = pIdx.slice(-parallelLimit.value)
  return {
    msgs,
    visibleSet: new Set(visible),
    firstVisibleIdx: visible[0] ?? -1,
    hidden: pIdx.length - visible.length,
  }
})

function loadMoreParallel() {
  parallelLimit.value += PARALLEL_PAGE
}

/** 切换按钮的拖动状态（fixed 定位 + translate 偏移） */
const switchX = ref(0)
const switchY = ref(0)
let dragPointer = { x: 0, y: 0, startX: 0, startY: 0 }
let dragMoved = false

function dragStart(e: PointerEvent) {
  dragMoved = false
  dragPointer = {
    x: e.clientX,
    y: e.clientY,
    startX: switchX.value,
    startY: switchY.value,
  }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}

function dragMove(e: PointerEvent) {
  const dx = e.clientX - dragPointer.x
  const dy = e.clientY - dragPointer.y
  if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true
  // 限制在视口内，别把按钮拖没影
  const maxX = window.innerWidth - 48
  const maxY = window.innerHeight - 48
  switchX.value = Math.max(4, Math.min(maxX, dragPointer.startX + dx))
  switchY.value = Math.max(4, Math.min(maxY, dragPointer.startY + dy))
}

function dragEnd() {
  /* 保留 */
}

/**
 * 切换按钮待机半隐：
 *   · 5s 不点击、不移动 → 右移半边出屏 + 变淡（docked）
 *   · 用户主动把它拖到屏幕右半松手 → 立即 docked，不等 5s
 *   · 再次触碰（pointerdown）→ 恢复全显 + 取消暗淡，重新计时
 */
const docked = ref(false)
let dockTimer: number | null = null
/** 右移量：原 right:10px + 出屏 18px（42px 宽 → 露一半多一点便于再触碰） */
const DOCK_OFFSET = 28
/** 待机时长：5s 无交互进入半隐 */
const DOCK_MS = 5000

const cmpTransform = computed(() => {
  const dx = switchX.value + (docked.value ? DOCK_OFFSET : 0)
  return `translate(${dx}px, ${switchY.value}px)`
})

function clearDockTimer() {
  if (dockTimer != null) {
    clearTimeout(dockTimer)
    dockTimer = null
  }
}

function armDockTimer() {
  clearDockTimer()
  dockTimer = window.setTimeout(() => {
    docked.value = true
    dockTimer = null
  }, DOCK_MS)
}

/** 触碰（按下）立即恢复全显，取消暗淡 */
function onCmpPointerDown(e: PointerEvent) {
  docked.value = false
  clearDockTimer()
  dragStart(e)
}

/** 松开：右移判定 + 重新计时 */
function onCmpPointerUp() {
  dragEnd()
  // 按钮中心（switchX + right 10 + 半宽 21）落在屏幕右半 → 视为用户主动右移
  if (switchX.value + 31 > window.innerWidth / 2) {
    docked.value = true
    clearDockTimer()
  } else {
    armDockTimer()
  }
}

// 按钮出现/消失时管理待机定时器
watch(showCmpSwitch, (v) => {
  if (v) armDockTimer()
  else {
    clearDockTimer()
    docked.value = false
  }
})

const streaming = computed(() => sessions.streamingId.value === sessionId.value)
const noProvider = computed(() => providers.value.length === 0)
const openDetails = ref(new Set<string>())

function toggleDetail(id: string) {
  const s = openDetails.value
  if (s.has(id)) s.delete(id)
  else s.add(id)
  openDetails.value = new Set(s)
}

onMounted(async () => {
  await Promise.all([sessions.load(), loadProviders()])
  // 记住当前会话，底栏「会话」在别的模块点回来时能落回这里
  sessions.markOpened(sessionId.value)
  resizeComposer()
  await scrollToBottom()
})

// 同一路由内切换会话（如从列表连点两场）时也要更新
watch(sessionId, (id) => {
  if (id) sessions.markOpened(id)
})

watch(
  () => session.value?.messages.length,
  () => scrollToBottom(),
)

/**
 * 影子状态变化时重算展开按钮。
 *
 * 非受控模式下 textarea 本身与 Vue 渲染绝缘（没有 value 绑定），
 * 这里只负责「≥3 行显示展开按钮」—— 只读 scrollHeight、不改布局。
 * 高度调整统一由 onComposerInput（停顿后）和 onCompositionEnd（上屏后）调度；
 * 发送清空由 onSend 自己调 resizeComposer。
 */
watch(input, async () => {
  await nextTick()
  updateExpandBtn()
  requestAnimationFrame(updateExpandBtn)
})
watch(
  () => session.value?.messages[session.value.messages.length - 1]?.content,
  () => scrollToBottom(),
)

async function scrollToBottom() {
  await nextTick()
  const el = chatEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  // 补两次：消息里含图片/长文本时，append 之后 layout 可能还没撑开，
  // 第一帧设 scrollTop 会滚不到位。rAF + setTimeout 各补一次 ——
  // 这是安卓 WebView 上处理「刚插入还没 layout」的标准兜底。
  requestAnimationFrame(() => {
    const c = chatEl.value
    if (c) c.scrollTop = c.scrollHeight
  })
  setTimeout(() => {
    const c = chatEl.value
    if (c) c.scrollTop = c.scrollHeight
  }, 60)
}

/**
 * 输入时重算输入框高度。
 *
 * 为什么要「算两次」——这是真机才暴露的问题：
 *   中文输入法打字时文字处于**组合态**（拼音还没上屏），
 *   部分 Android WebView 会推迟对新增文字的重排，
 *   此刻读 scrollHeight 拿到的还是旧值，于是框子不变高。
 *   等一帧（rAF）再算一次就对了。
 *
 * 这个解释能对上用户反馈的全部现象：
 *   · 打字 → 组合态 → 重排推迟 → 不变高
 *   · 退格删字 → 不是组合态 → 重排立刻发生 → 正常变高
 *   · 再打字 → 又进组合态 → 又不行
 * 非受控模式下（无 v-model），这里同时负责把 DOM 值同步进影子状态。
 */
function onComposerInput() {
  const el = taEl.value
  if (!el) return
  // 1) 先记住光标 —— 此刻它还是用户在文本里的真实位置
  const caret = snapshotCaret(el)
  // 2) 组合态（拼音还没上屏）里**两件事都不能做**：
  //    · 不把 DOM 值同步进状态 —— 组合态下 el.value 可能含预编辑文本，
  //      同步会污染状态并触发 Vue 重渲染；上屏后的 input 事件会统一同步。
  //    · 不动光标（restore 交给 restoreCaret 自己的 isComposing 守卫兜底）。
  const isComposingNow = composing || inImeComposition(el)
  if (!isComposingNow) {
    // 非组合态：把 DOM 值同步进影子状态（粘贴/部分输入法事件被吞时兜底）
    if (el.value !== input.value) input.value = el.value
    scheduleResize(350)
    // 等 Vue 重渲染完，把光标还回原位
    restoreAfterRender(el, caret)
  }
  updateExpandBtn()
}

/** 输入法开始组合（拼音还没上屏）：立刻停掉所有布局调整 */
function onCompositionStart() {
  composing = true
  cancelPendingResize()
}

/**
 * 输入法上屏：这是调整高度最安全的时机 —— 组合已经结束，
 * 重排不会再打断输入法的光标定位。
 * 非受控模式下这里负责把**当前聚焦的那个框**的最新文本同步进影子状态。
 */
function onCompositionEnd() {
  composing = false
  const el = composerFs.value ? fsEl.value : taEl.value
  if (el && el.value !== input.value) input.value = el.value
  scheduleResize(0)
}

/** 输入框最大高度（约 5 行）。超过就内部滚动，不能无限长高把聊天区挤没了 */
const COMPOSER_MAX_H = 130

/**
 * WebView 123+（Chrome 123+）原生支持 `field-sizing: content`（styles.css 已声明），
 * 输入框高度由浏览器自己按内容撑开，**JS 不需要也不应该再碰 height**。
 *
 * 为什么必须让 JS 收手 —— 这是「输入的字强制在最后、不在光标处」的根因：
 *   真机 Android WebView 上，中文输入法组合态里每打一个键，聚焦定时器（150ms）
 *   和 @input 都会执行 `el.style.height='auto'` → 强制重排 → 正在编辑的
 *   textarea 被浏览器重新布局 → 输入法关联的光标定位被打断，新输入的字
 *   就落到文本末尾。
 *   原生 field-sizing 已经接管了「内容变 → 高度变」，JS 那套只留给不支持
 *   field-sizing 的旧内核做兜底，两者绝不重复跑。
 */
/**
 * WebView 123+（Chrome 123+）原生支持 `field-sizing: content`（styles.css 已声明），
 * 输入框高度由浏览器自己按内容撑开，**JS 不需要也不应该再碰 height**。
 * 判定逻辑见 `lib/composer.ts`（抽成纯函数便于单测防回归）。
 */
import { HAS_FIELD_SIZING, inImeComposition, readCaret, restoreCaret, type Caret } from '@/lib/composer'

/**
 * 输入框随内容变高，并保证光标行留在可视区内。
 *
 * 实测才知道的坑（用 Edge headless 量出来的，不是猜的）：
 *   1. 只设 `height: auto` 不读 scrollHeight 就不会变高，框子永远是 1 行。
 *   2. **`box-sizing: border-box` 下 scrollHeight 不含边框**，
 *      直接把 scrollHeight 赋给 height 会永远差 2px（1px 上下边框），
 *      非封顶状态下一直有一条 2px 的滚动量，光标行被切掉一条。
 *      所以要把 `offsetHeight - clientHeight`（正好是上下边框）补上。
 *
 * 注意**不要**在每次重算后 `scrollTop = scrollHeight` 强制滚到底：
 * 真机反馈「输入的文字只会出现在最后面，没法在指针处打字」——强制到底会把
 * 正在编辑的中间位置顶出视口。textArea 在输入时原生就会把光标保持在可视区，
 * 这里只负责高度，滚动交给浏览器。高度被压到 130px 封顶、内容溢出时，
 * 用户手动滚动即可，不主动干预。
 */
function resizeComposer() {
  const el = taEl.value
  if (!el) return
  // 原生 field-sizing 已接管高度：JS 收手，避免强制重排打断输入法光标定位
  if (HAS_FIELD_SIZING) return
  // 组合态里绝不碰布局 —— 见下面 scheduleResize 的说明。
  // 双保险：全局 composing 状态 + 元素自身 isComposing（部分输入法不发
  // compositionstart 事件，全局状态会漏判；el.isComposing 是浏览器自己维护的）。
  if (composing || inImeComposition(el)) return
  // 最小化重排：先量目标高度，和当前高度几乎一样就不写 style。
  // 读 scrollHeight 是同步布局，但「只读不改」不会打断输入法关联；
  // 真正打断光标的是「写了 height 触发重新布局」。没变化就不写。
  const border = Math.max(0, el.offsetHeight - el.clientHeight)
  const target = Math.min(el.scrollHeight + border, COMPOSER_MAX_H)
  if (Math.abs(target - el.offsetHeight) < 1) return
  el.style.height = `${target}px`
  // 输入区变高会挤压上面的聊天区，保持消息仍贴在底部
  void scrollToBottom()
}

/**
 * 是否处于输入法组合态（拼音还没上屏）。
 *
 * 为什么要单独跟踪：`input` 事件在组合态里也会触发，
 * 但此时去改 `height` 会引起重排。真机上「把光标移到中间、字却跑到末尾」
 * 就是这种重排打断输入法光标定位造成的 —— 所以组合态里一律不动布局。
 */
let composing = false

/**
 * 高度调整改成**延迟执行**，而不是每次按键都算。
 *
 * 为什么：原来每次 input 立刻 `height='auto'`（还有一层 150ms 轮询），
 * 在中文输入法组合态下会不停重排，输入法的光标定位被反复打断，
 * 表现为「移到中间打字，字还是出现在末尾」。
 * 现在只在两种安全时机算高度：
 *   1. 输入法上屏之后（compositionend）
 *   2. 停止打字 350ms 之后（普通输入 / 粘贴）
 * 代价是框子长高会略有延迟，换来的是光标不再乱跳。
 */
let resizeTimer: number | null = null

function scheduleResize(delay: number) {
  if (HAS_FIELD_SIZING) return
  if (resizeTimer != null) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null
    resizeComposer()
  }, delay)
}

function cancelPendingResize() {
  if (resizeTimer != null) {
    clearTimeout(resizeTimer)
    resizeTimer = null
  }
}

/** 输入框获得焦点：先按当前内容对一次高度（用户可能刚切回来） */
function startComposerWatch() {
  scheduleResize(0)
}

/** 失焦：取消待执行的调整，并按最终内容对一次 */
function stopComposerWatch() {
  cancelPendingResize()
  scheduleResize(0)
}

/**
 * 失焦时把 DOM 里的真实内容同步回影子状态 —— 非受控模式下这是
 * 唯一保证「点开关后内容不丢」的路径：
 * 真机上输入法组合态 / 输入事件被吞时，状态可能滞后于 DOM；
 * 失焦这一刻 DOM 是权威，先拉回状态，后续任何重渲染都不会动 textarea。
 */
function onComposerBlur() {
  const el = taEl.value
  // 若失焦时输入法还在组合（部分输入法直接收起键盘、不发 compositionend），
  // el.value 里可能带着未上屏的预编辑文本 —— 这种内容不能进状态。
  // 预编辑文本随键盘收起即丢弃；真正上屏过的文本会由 input 事件/下次 focus 兜底。
  if (el && !(composing || inImeComposition(el)) && el.value !== input.value) {
    input.value = el.value
  }
  // 万一 compositionend 没触发（部分输入法在失焦时直接收起键盘），
  // 这里把组合态清掉，否则高度调整会一直被挡住
  composing = false
  stopComposerWatch()
}

// 离开会话页时把待执行的调整取消掉，别在后台空转
onUnmounted(cancelPendingResize)
onUnmounted(clearDockTimer)

async function onAttach(e: Event) {
  const inp = e.target as HTMLInputElement
  const files = Array.from(inp.files ?? [])
  inp.value = ''
  for (const f of files) {
    const raw = await fileToDataUrl(f)
    attached.value.push(await compressImage(raw, 1600, 0.85))
  }
}

async function onSend() {
  const s = session.value
  if (!s || streaming.value) return
  // 兜底读一次 DOM（非受控模式下 DOM 才是权威）。
  // 踩过的坑：某些输入法/机型下状态没能同步（输入法还在组合态、
  // 或输入事件被吞），输入框里明明有字，但 input.value 还是空的，
  // 于是「发送」按钮一直是禁用态、点了没反应。
  // 与设置页的 API Key 是同一类问题：不信任单一状态源，DOM 里有什么就用什么。
  const domText = (taEl.value?.value ?? '').trim()
  const text = input.value.trim() || domText
  if (!text && !attached.value.length) {
    error.value = '还没输入内容'
    return
  }
  if (noProvider.value) {
    error.value = '还没有配置模型，请先到「设置」添加'
    return
  }
  error.value = ''
  const images = [...attached.value]
  input.value = ''
  attached.value = []
  // 状态被清空后同步清掉 DOM（非受控模式必须手动清），
  // 否则输入法里的残留文字会留在屏幕上
  if (taEl.value) taEl.value.value = ''
  if (fsEl.value) fsEl.value.value = ''
  // 高度要跟着缩回 1 行，否则发完还留着上次撑开的空档
  resizeComposer()
  // 对比请教：双轨生成，军师 vs 专业分析
  if (compareMode.value) {
    compareMode.value = false // 一次性的技能，用完退出，省 token
    toolSheet.value = false
    await sessions.sendCompare(s.id, text, images)
    return
  }
  await sessions.send(s.id, text, images)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    onSend()
  }
}

async function onToggleMemory() {
  const s = session.value
  if (!s) return
  s.useGlobalMemory = !s.useGlobalMemory
  await sessions.save(s)
}

/**
 * 允许联网查证。
 *
 * 关着的时候：模型需要在查行情/新闻前先问一句，得到同意才动手。
 * 打开之后：本会话不再逐次询问，直接查。
 * 目的是把「要不要让它自己去联网」的决定权留在用户手里。
 */
async function onToggleOnline() {
  const s = session.value
  if (!s) return
  s.allowOnline = !s.allowOnline
  await sessions.save(s)
}

function openKbPicker() {
  const s = session.value
  if (!s) return
  kbDraft.value = [...s.activeKbIds]
  showKbPicker.value = true
}

async function saveKbPicker() {
  const s = session.value
  if (!s) return
  s.activeKbIds = [...kbDraft.value]
  await sessions.save(s)
  showKbPicker.value = false
}

function toggleKbDraft(id: string) {
  const i = kbDraft.value.indexOf(id)
  if (i >= 0) kbDraft.value.splice(i, 1)
  else kbDraft.value.push(id)
}

async function renameSession() {
  const s = session.value
  if (!s) return
  const t = prompt('会话标题', s.title)
  if (t != null) {
    s.title = t.trim() || s.title
    await sessions.save(s)
  }
}

async function onClear() {
  const s = session.value
  if (!s) return
  if (!confirm('清空这个会话的所有消息？')) return
  await sessions.clearMessages(s)
}

const activeKbs = computed(() =>
  session.value ? knowledge.resolve(session.value.activeKbIds) : [],
)

const memoryHint = computed(() => {
  const s = session.value
  if (!s?.useGlobalMemory) return 'AI 看不到你的持仓与个人信息'
  if (!memory.hasMemory.value) return '已开启，但还没有录入持仓或偏好'
  const n = memory.confirmedHoldings.value.length
  const f = memory.activeFacts.value.length
  return `AI 知道你 ${n} 只持仓、${f} 条偏好`
})
</script>

<template>
  <div class="page-full">
    <div v-if="!session" class="empty">
      会话不存在或已删除<br />
      <button class="btn" style="margin-top: 12px" @click="router.replace('/')">返回列表</button>
    </div>

    <template v-else>
      <!-- 顶栏 -->
      <div class="hdr">
        <button
          class="btn sm ghost icon-btn"
          aria-label="打开会话列表"
          @click="drawerOpen = true"
        >
          <TabIcon name="menu" :size="18" />
        </button>
        <h1>
          <span @click="renameSession">{{ session.title }}</span>
          <div class="sub">{{ memoryHint }}</div>
        </h1>
        <button class="btn sm ghost" @click="onClear">清空</button>
      </div>

      <!-- 上下文开关 -->
      <div style="padding: 8px 14px; border-bottom: 1px solid var(--line)">
        <div class="chips">
          <span
            class="chip pick"
            :class="{ on: session.useGlobalMemory }"
            @click="onToggleMemory"
          >
            <TabIcon name="memory" :size="14" />
            {{ session.useGlobalMemory ? '共享记忆' : '隔离记忆' }}
          </span>
          <!-- 联网授权：关着=先问再查；打开=本会话直接查 -->
          <span
            class="chip pick"
            :class="{ on: session.allowOnline }"
            @click="onToggleOnline"
          >
            <TabIcon name="globe" :size="14" />
            {{ session.allowOnline ? '已允许联网' : '联网前先问我' }}
          </span>
          <span class="chip pick" @click="openKbPicker">
            <TabIcon name="kb" :size="14" />
            {{
              activeKbs.length
                ? activeKbs.map((k) => k.author?.name || k.manifest.title).join('、')
                : '未选军师'
            }}
          </span>
          <span v-if="session.focusSubject?.name" class="chip">
            聚焦 {{ session.focusSubject.name }}
          </span>
          <span v-if="!activeKbs.length" class="chip warn">无知识库时 AI 只能靠常识回答</span>
        </div>
      </div>

      <!-- 消息 -->
      <div ref="chatEl" class="chat">
        <div v-if="!session.messages.length" class="empty">
          <div class="big"><TabIcon name="sessions" :size="36" /></div>
          问点什么吧<br />
          <span class="small">
            例如：我现在持有半导体，这个军师怎么看？<br />
            或者：帮我看看新能源现在的机会。
          </span>
        </div>

        <!-- 对比消息按页折叠：最近 5 条直接渲染，更早在「加载更多」里 -->
        <template v-for="(m, i) in parallelCtx.msgs" :key="m.id">
          <div
            v-if="m.parallel && i === parallelCtx.firstVisibleIdx && parallelCtx.hidden > 0"
            class="load-more-wrap"
          >
            <button class="load-more" @click="loadMoreParallel">
              加载更多对比回答（还有 {{ parallelCtx.hidden }} 条）
            </button>
          </div>
          <div
            v-if="!m.parallel || parallelCtx.visibleSet.has(i)"
            class="msg"
            :class="m.role === 'user' ? 'user' : 'assistant'"
          >
          <div v-if="m.images?.length" class="msg-imgs">
            <img v-for="(src, i) in m.images" :key="i" :src="src" alt="附图" />
          </div>

          <!-- 工具调用轨迹：放在答案上方。这是判断可信度的依据 ——
               模型编造时这一栏会是空的 -->
          <div
            v-if="m.role === 'assistant' && !m.parallel && m.toolCalls?.length"
            class="tool-trail"
          >
            <div
              v-for="t in m.toolCalls"
              :key="t.id"
              class="tool-row"
              :class="{ err: !t.ok }"
              @click="t.detail && toggleDetail(t.id)"
            >
              <span class="tc-ico">{{ t.ok ? '✓' : '✕' }}</span>
              <span class="tc-text">{{ t.display }}</span>
              <span v-if="t.summary && t.ok" class="chip">{{ t.summary }}</span>
              <span v-if="t.ms" class="muted small">{{ t.ms }}ms</span>
            </div>
            <div
              v-for="t in m.toolCalls.filter((x) => x.detail && openDetails.has(x.id))"
              :key="`d-${t.id}`"
              class="tool-detail"
            >
              <div v-if="t.error" class="small" style="color: var(--danger)">
                {{ t.error }}
              </div>
              <pre>{{ t.detail }}</pre>
            </div>
          </div>

          <details v-if="m.role === 'assistant' && m.thinking" class="thinking">
            <summary>思考过程</summary>
            <div>{{ m.thinking }}</div>
          </details>

          <div
            class="bubble"
            :class="{ error: Boolean(m.parallel ? activeSide(m)?.error : m.error) }"
          >
            <!-- 对比请教：显示全局当前侧（军师/专业分析），
                 标题或右侧浮动按钮点击切换全部对比消息 -->
            <template v-if="m.parallel">
              <div class="cmp-side">
                <div class="cmp-tag" @click="flipCompareView">
                  <TabIcon
                    :name="compareView === 'advisor' ? 'person' : 'compare'"
                    :size="12"
                  />
                  {{ compareView === 'advisor' ? '军师观点' : '专业分析' }}
                  <span class="cmp-flip">⇄ 切换全部</span>
                </div>

                <div v-if="activeSide(m)?.toolCalls?.length" class="tool-trail">
                  <div
                    v-for="t in activeSide(m)!.toolCalls!"
                    :key="t.id"
                    class="tool-row"
                    :class="{ err: !t.ok }"
                    @click="t.detail && toggleDetail(t.id)"
                  >
                    <span class="tc-ico">{{ t.ok ? '✓' : '✕' }}</span>
                    <span class="tc-text">{{ t.display }}</span>
                    <span v-if="t.summary && t.ok" class="chip">{{ t.summary }}</span>
                    <span v-if="t.ms" class="muted small">{{ t.ms }}ms</span>
                  </div>
                  <div
                    v-for="t in sideOpenTools(m)"
                    :key="`d-${t.id}`"
                    class="tool-detail"
                  >
                    <div v-if="t.error" class="small" style="color: var(--danger)">
                      {{ t.error }}
                    </div>
                    <pre>{{ t.detail }}</pre>
                  </div>
                </div>

                <details v-if="activeSide(m)?.thinking" class="thinking">
                  <summary>思考过程</summary>
                  <div>{{ activeSide(m)!.thinking }}</div>
                </details>

                <div v-if="!activeSide(m)?.content && m.pending" class="muted">
                  <span class="spin" />
                  {{
                    activeSide(m)?.toolCalls?.length
                      ? '等待工具结果…'
                      : '正在生成…'
                  }}
                </div>
                <div v-else-if="activeSide(m)?.content" v-html="renderMarkdown(activeSide(m)!.content)" />
                <div v-if="activeSide(m)?.hitRoundLimit" class="alert warn" style="margin-top: 6px">
                  已达到工具调用轮数上限，这一侧是强制收尾的，可能不完整。
                </div>
                <div v-if="activeSide(m)?.error" style="margin-top: 6px; white-space: pre-wrap">
                  {{ activeSide(m)!.error }}
                </div>
              </div>
            </template>

            <template v-else-if="m.role === 'assistant'">
              <div v-if="!m.content && m.pending" class="muted">
                <span class="spin" />
                {{
                  m.toolCalls?.length
                    ? '等待工具结果…'
                    : '正在检索知识库并生成…'
                }}
              </div>
              <div v-else-if="m.content" v-html="renderMarkdown(m.content)" />
              <div v-if="m.hitRoundLimit" class="alert warn" style="margin-top: 6px">
                已达到工具调用轮数上限，这条回答是强制收尾的，可能不完整。
              </div>
              <div v-if="m.error" style="margin-top: 6px; white-space: pre-wrap">
                {{ m.error }}
              </div>
            </template>
            <template v-else>
              <div style="white-space: pre-wrap">{{ m.content }}</div>
            </template>
          </div>

          <!-- 提问时刻行情快照：发问那分钟的价格存档 -->
          <div v-if="m.role === 'user' && m.snapshot" class="snap-line">
            <TabIcon name="search" :size="11" />
            <span>
              快照 {{ fmtSnapTime(m.snapshot.time) }} ·
              {{ m.snapshot.name }} {{ m.snapshot.price.toFixed(2) }}（{{ snapDir(m.snapshot) }}{{ m.snapshot.changePct.toFixed(2) }}%）
            </span>
          </div>

          <div v-if="m.role === 'assistant'" class="msg-foot">
            <span v-if="m.pending" class="muted">生成中…</span>
            <template v-else>
              <span v-if="m.mode && m.mode !== 'research'" class="chip on">
                <TabIcon :name="modeIcon(m.mode)" :size="13" />
                {{ modeName(m.mode) }}
              </span>
              <span v-if="m.usedKb?.length">
                <TabIcon name="kb" :size="12" />
                {{ m.usedKb.map((k) => k.author || k.title).join('、') }}
              </span>
              <span>
                <TabIcon name="memory" :size="12" />
                {{ m.usedMemory ? '用了记忆' : '未用记忆' }}
              </span>
              <span v-if="m.model" class="muted">{{ m.model }}</span>
              <span v-if="m.parallel" class="muted">
                军师 {{ m.parallel.advisor.usage?.completion ?? 0 }} · 分析
                {{ m.parallel.analyst.usage?.completion ?? 0 }} tok
              </span>
              <span v-else-if="m.usage" class="muted">
                {{ m.usage.prompt }}+{{ m.usage.completion }} tok
              </span>
              <span v-if="m.error" class="btn sm ghost" @click="sessions.retryLast(session!.id)">
                重试
              </span>
            </template>
          </div>
          </div>
        </template>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <div v-if="error" class="alert err">{{ error }}</div>
        <div v-if="attached.length" class="msg-imgs" style="justify-content: flex-start">
          <div v-for="(src, i) in attached" :key="i" style="position: relative">
            <img :src="src" alt="待发送" />
            <button
              class="btn sm ghost"
              style="position: absolute; top: -6px; right: -6px; padding: 0 6px"
              @click="attached.splice(i, 1)"
            >
              ×
            </button>
          </div>
        </div>

        <!-- 对比请教模式提示 -->
        <div v-if="compareMode" class="compare-banner">
          <TabIcon name="compare" :size="14" />
          <span class="cmp-banner-t">对比请教：军师观点 vs 专业分析，发送后双轨生成</span>
          <button class="cmp-x" aria-label="退出对比模式" @click="compareMode = false">×</button>
        </div>

        <!-- 微信式工具栏：加号展开 -->
        <div v-show="toolSheet" class="tool-sheet">
          <button class="tool-cell" @click="onPickImage">
            <span class="tool-ico"><TabIcon name="image" :size="26" /></span>
            <span class="tool-name">图片</span>
          </button>
          <button class="tool-cell" @click="onPickCompare">
            <span class="tool-ico"><TabIcon name="compare" :size="26" /></span>
            <span class="tool-name">对比</span>
          </button>
        </div>

        <div class="composer-row">
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            style="display: none"
            @change="onAttach"
          />
          <!-- 加号按钮（展开工具栏，展开时变减号）+ 上方 ≥3 行展开全屏按钮 -->
          <div class="attach-col">
            <button
              v-if="showExpandBtn"
              class="expand-btn"
              aria-label="展开输入框"
              @click="openComposerFs"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M6 9l6 6 6-6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              class="attach"
              :class="{ on: toolSheet }"
              aria-label="工具栏"
              @click="toggleToolSheet"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  v-if="!toolSheet"
                  d="M12 5v14M5 12h14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <path
                  v-else
                  d="M5 12h14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class="ta-wrap">
            <!--
              非受控 textarea：**故意不用 v-model / :value**。
              这是「光标移到中间、字却落到末尾」的最终防线 ——
              Vue 一旦给 textarea 绑定 value，任何一次重渲染都可能把
              `el.value = state` 写回 DOM，而**写回 value 会把光标甩到末尾**
              （即使是同值，部分 WebView 也会重置光标）。
              现在 DOM value 完全由用户输入驱动，Vue 只通过 @input 同步
              一份「影子状态」供发送用；textarea 本身从此与重渲染绝缘。
              微信输入框能稳定在中间插入，靠的就是「原生 textarea + 无人写回」。
            -->
            <textarea
              ref="taEl"
              rows="1"
              @keydown="onKeydown"
              @input="onComposerInput"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
              @focus="startComposerWatch"
              @blur="onComposerBlur"
            />
          </div>
          <button v-if="streaming" class="btn danger" style="height: 38px" @click="sessions.abort()">
            停止
          </button>
          <!--
            故意**不**按输入内容禁用：输入法的组合态下 v-model 可能还没同步，
            禁用会让用户「打了字却点不动」。改成永远可点，
            空内容时在 onSend 里给出可见提示，而不是让按钮变成灰色。
          -->
          <button v-else class="btn primary" style="height: 38px" @click="onSend">发送</button>
        </div>
      </div>
    </template>

    <!-- 微信式全屏输入框：折叠态内容 ≥3 行时点左上角按钮进入 -->
    <Teleport to="body">
      <div v-if="composerFs" class="composer-fs">
        <div class="fs-head">
          <button class="fs-btn" aria-label="收起输入框" @click="closeComposerFs">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 9l6 6 6-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <span class="fs-title">{{ session?.title }}</span>
          <button v-if="streaming" class="btn danger sm" @click="sessions.abort()">停止</button>
          <button v-else class="btn primary sm" @click="onSend">发送</button>
        </div>
        <!-- 同样非受控（注释见折叠框）；全屏框必须绑 compositionstart：
             之前缺这个事件，全屏框组合态会漏判 composing，组合态里同步
             value/移光标导致字落末尾。 -->
        <textarea
          ref="fsEl"
          class="fs-ta"
          @keydown="onKeydown"
          @input="onFsInput"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @blur="onFsBlur"
        ></textarea>
      </div>
    </Teleport>

    <!-- 对比请教：右侧可拖动的切换按钮（拖动换位置，点击切换军师/专业分析） -->
    <div
      v-if="showCmpSwitch"
      class="cmp-switch"
      :class="{ docked }"
      :style="{ transform: cmpTransform }"
      aria-label="切换对比回答"
      @click="!dragMoved && flipCompareView()"
      @pointerdown="onCmpPointerDown"
      @pointermove="dragMove"
      @pointerup="onCmpPointerUp"
      @pointercancel="onCmpPointerUp"
    >
      <TabIcon name="compare" :size="18" />
    </div>
    <div v-if="showKbPicker" class="modal-mask" @click.self="showKbPicker = false">
      <div class="modal">
        <h2>选择军师</h2>
        <div v-if="!knowledge.kbs.value.length" class="hint">
          还没有知识库。先去「知识库」页载入。
        </div>
        <div v-else class="chips">
          <span
            v-for="k in knowledge.kbs.value"
            :key="k.id"
            class="chip pick"
            :class="{ on: kbDraft.includes(k.id), }"
            :style="{ opacity: k.enabled ? 1 : 0.5 }"
            @click="toggleKbDraft(k.id)"
          >
            <TabIcon name="kb" :size="14" />
            {{ k.author?.name || k.manifest.title }}
            <span class="muted">({{ k.opinions.length }} 条观点)</span>
          </span>
        </div>
        <div class="hint" style="margin-top: 10px">
          可以同时选多个军师，AI 会并列呈现不同来源的观点。
        </div>
        <div class="btn-row" style="margin-top: 14px">
          <button class="btn" @click="showKbPicker = false">取消</button>
          <div style="flex: 1" />
          <button class="btn primary" @click="saveKbPicker">确定</button>
        </div>
      </div>
    </div>

    <!-- 左侧会话栏 -->
    <SessionDrawer
      :open="drawerOpen"
      @close="drawerOpen = false"
      @new="drawerOpen = false; newSessionOpen = true"
    />

    <!-- 新建会话：在当前页展开，不跳列表页 -->
    <NewSessionModal
      :open="newSessionOpen"
      @close="newSessionOpen = false"
      @created="(s) => { newSessionOpen = false; router.push(`/s/${s.id}`) }"
    />
  </div>
</template>
