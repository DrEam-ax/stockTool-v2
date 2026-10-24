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
import type { AdvisorMode, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import TabIcon from '@/components/TabIcon.vue'
import type { IconName } from '@/components/TabIcon.vue'
import { useMemory } from '@/stores/memory'
import { useProviders } from '@/stores/providers'
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
 * 双保险：不依赖 `@input` 事件一定触发。
 *
 * 某些输入法/机型下输入事件可能被吞（发送按钮那次就是栽在这上面），
 * 所以只要 `input` 状态变了（无论来自键盘、粘贴还是程序清空）
 * 都等 DOM 更新后重算一次高度。
 */
watch(input, async () => {
  await nextTick()
  resizeComposer()
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
 * 而且 `v-model` 在组合态是故意不更新状态的，所以靠 watch 也兜不住。
 */
function onComposerInput() {
  // 组合态下 v-model 可能没同步，这里先把 DOM 的真实内容拉回状态。
  // 否则后面任何一次重渲染（点个开关、换个知识库）都可能用空状态覆盖掉 DOM，
  // 用户刚打的字就没了 —— 真机上「点联网开关文字消失」正是这个机制。
  const el = taEl.value
  if (el && el.value !== input.value) input.value = el.value
  resizeComposer()
  // 组合态下的补算：等浏览器重排完成。两层兜底 ——
  //   rAF：正常情况下重排后的第一帧
  //   setTimeout(0)：某些 WebView 的组合态结束后还会晚一拍才更新 scrollHeight
  requestAnimationFrame(resizeComposer)
  setTimeout(resizeComposer, 0)
}

/** 输入框最大高度（约 5 行）。超过就内部滚动，不能无限长高把聊天区挤没了 */
const COMPOSER_MAX_H = 130

/**
 * 输入框随内容变高，并保证最后一行始终可见。
 *
 * 三个都是实测才知道的坑（用 Edge headless 量出来的，不是猜的）：
 *   1. 只设 `height: auto` 不读 scrollHeight 就不会变高，框子永远是 1 行。
 *   2. **`box-sizing: border-box` 下 scrollHeight 不含边框**，
 *      直接把 scrollHeight 赋给 height 会永远差 2px（1px 上下边框），
 *      非封顶状态下一直有一条 2px 的滚动量，光标行被切掉一条。
 *      所以要把 `offsetHeight - clientHeight`（正好是上下边框）补上。
 *   3. 变高之后不把 scrollTop 顶到底的话，光标会停在旧位置被挤出可视区，
 *      用户得手动往下滑才能看见自己刚打的字。
 */
function resizeComposer() {
  const el = taEl.value
  if (!el) return
  el.style.height = 'auto'
  // border-box 下 height 不含边框，用差值补回来（比读 computedStyle 简单可靠）
  const border = Math.max(0, el.offsetHeight - el.clientHeight)
  const h = Math.min(el.scrollHeight + border, COMPOSER_MAX_H)
  el.style.height = `${h}px`
  // 让最新一行/光标留在可视区内
  el.scrollTop = el.scrollHeight
  // 输入区变高会挤压上面的聊天区，保持消息仍贴在底部
  void scrollToBottom()
}

/**
 * 聚焦期间每 150ms 校验一次高度 —— 这一层**完全不依赖事件**。
 *
 * 为什么还要它：真机上出现过「打字不变高、退格就正常」，
 * 说明中文输入法组合态下的 input / compositionend 时机在各家 WebView 上靠不住，
 * rAF / setTimeout 也救不回来（可能都跑在重排之前）。
 * 定时校验一到位，无论事件是否被吞、重排何时完成，
 * 最迟 150ms 内框子都会长到正确高度。失焦立即停，不占后台资源。
 */
let composerTimer: number | null = null
let lastComposerH = -1

function startComposerWatch() {
  if (composerTimer != null) return
  composerTimer = window.setInterval(() => {
    const el = taEl.value
    if (!el || document.activeElement !== el) return
    el.style.height = 'auto'
    const border = Math.max(0, el.offsetHeight - el.clientHeight)
    const h = Math.min(el.scrollHeight + border, COMPOSER_MAX_H)
    if (h === lastComposerH) return // 高度没变就不动，避免无谓重排
    lastComposerH = h
    el.style.height = `${h}px`
    el.scrollTop = el.scrollHeight
  }, 150)
}

function stopComposerWatch() {
  if (composerTimer != null) {
    clearInterval(composerTimer)
    composerTimer = null
    lastComposerH = -1
  }
}

/**
 * 失焦时把 DOM 里的真实内容同步回状态 —— 这条很重要。
 *
 * 真机必现的 bug：中文输入法组合态下 `v-model` 不会更新状态，
 * 此时点顶部的「已允许联网」等开关，输入框会先失焦、再触发重渲染；
 * Vue 的 `v-model` 指令发现「DOM 值 ≠ 状态值」，就用状态里的空串覆盖了 DOM，
 * **用户刚打的字凭空消失**。
 *
 * 在 blur 这一刻先把 DOM 拉回状态，重渲染时两者相等，就不会再被覆盖。
 */
function onComposerBlur() {
  const el = taEl.value
  if (el && el.value !== input.value) input.value = el.value
  stopComposerWatch()
}

// 离开会话页时把定时器收掉，别在后台空转
onUnmounted(stopComposerWatch)

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
  // 兜底读一次 DOM。
  // 踩过的坑：某些输入法/机型下 v-model 没能同步（输入法还在组合态、
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
  // 状态被清空后同步清掉 DOM，否则输入法里的残留文字会留在屏幕上
  if (taEl.value) taEl.value.value = ''
  // 高度要跟着缩回 1 行，否则发完还留着上次撑开的空档
  resizeComposer()
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
        <button class="btn sm ghost" @click="router.push('/')">‹</button>
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

        <div
          v-for="m in session.messages"
          :key="m.id"
          class="msg"
          :class="m.role === 'user' ? 'user' : 'assistant'"
        >
          <div v-if="m.images?.length" class="msg-imgs">
            <img v-for="(src, i) in m.images" :key="i" :src="src" alt="附图" />
          </div>

          <!-- 工具调用轨迹：放在答案上方。这是判断可信度的依据 ——
               模型编造时这一栏会是空的 -->
          <div v-if="m.role === 'assistant' && m.toolCalls?.length" class="tool-trail">
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

          <div class="bubble" :class="{ error: Boolean(m.error) }">
            <template v-if="m.role === 'assistant'">
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
              <span v-if="m.usage" class="muted">
                {{ m.usage.prompt }}+{{ m.usage.completion }} tok
              </span>
              <span v-if="m.error" class="btn sm ghost" @click="sessions.retryLast(session!.id)">
                重试
              </span>
            </template>
          </div>
        </div>
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
        <div class="composer-row">
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            style="display: none"
            @change="onAttach"
          />
          <div class="attach" @click="fileInput?.click()">
            <TabIcon name="paperclip" :size="20" />
          </div>
          <textarea
            ref="taEl"
            v-model="input"
            rows="1"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            @keydown="onKeydown"
            @input="onComposerInput"
            @compositionend="onComposerInput"
            @focus="startComposerWatch"
            @blur="onComposerBlur"
          />
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

    <!-- 军师选择 -->
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
  </div>
</template>
