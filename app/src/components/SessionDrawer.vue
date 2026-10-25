<script setup lang="ts">
/**
 * 会话栏（左侧抽屉）。
 *
 * 会话详情页左上角三横线打开：列出**所有**会话（标题 + 模式），
 * 点某一项进入该会话；每一项右侧的叉号是删除入口。
 *
 * 删除带 5 秒撤销机制：
 *   · 确认卡片 → 点「删除」后**这一行原地变成撤销条**（从右侧删除按钮向左展开）
 *   · 先不调删除接口，5 秒后才真删；鼠标停在撤销条上 / 键盘焦点在里面时暂停计时
 *   · 点「撤销」→ 撤销条缩回，这一行原样恢复
 *   · 超时 → 撤销条收回、这一行高度收到 0、下面的行平滑补上
 *   · 焦点不丢：删除后焦点到「撤销」，撤销后回删除按钮，真删后到下一行；
 *     role="status" 读屏播报「已删除 / 已恢复」
 */
import { nextTick, onUnmounted, reactive, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import type { AdvisorMode, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import TabIcon from '@/components/TabIcon.vue'
import type { IconName } from '@/components/TabIcon.vue'
import { relTime } from '@/lib/fmt'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; new: [] }>()

const router = useRouter()
const route = useRoute()
const sessions = useSessions()
const knowledge = useKnowledge()

/** 模式名 —— 与新建会话页口径一致（产品的分水岭） */
const MODES: Record<AdvisorMode, { icon: IconName; name: string }> = {
  audit: { icon: 'search', name: '检验我的操作' },
  persona: { icon: 'person', name: '请教军师' },
  research: { icon: 'kb', name: '研究历史观点' },
}

/** 待删除的会话：非空时显示确认卡片 */
const delTarget = ref<Session | null>(null)

/** 撤销倒计时时长 */
const UNDO_MS = 5000

interface UndoState {
  s: Session
  remaining: number
  startedAt: number
  timer: number | null
  paused: boolean
}
/** 正在「已删除待撤销」的会话（可同时多行，各自独立倒计时） */
const undoMap = reactive(new Map<string, UndoState>())

/** 读屏播报（role=status）：删除/撤销状态 */
const announce = ref('')

function modeOf(s: Session): AdvisorMode {
  return s.mode ?? 'research'
}

function kbNames(s: Session): string[] {
  return knowledge
    .resolve(s.activeKbIds)
    .map((k) => k.author?.name || k.manifest.title)
}

function openSession(s: Session) {
  emit('close')
  router.push(`/s/${s.id}`)
}

/* ---------------- 删除与撤销 ---------------- */

function askDelete(s: Session, e: Event) {
  e.stopPropagation()
  delTarget.value = s
}

/** 确认卡片点「删除」：不真删，这一行原地变撤销条并开始 5s 倒计时 */
function doDelete() {
  const s = delTarget.value
  if (!s) return
  delTarget.value = null
  startUndo(s)
  say(`「${s.title}」已删除`)
  // 焦点给「撤销」按钮（真删前的唯一出口）。
  // 注意：focus() 会触发撤销条的 focusin → pauseUndo，那是**程序性焦点**，
  // 不算用户停留，要立即恢复计时；用户真正把焦点停在撤销条/鼠标停上时才暂停。
  nextTick(() => {
    undoBtnEls.get(s.id)?.focus()
    resumeUndo(s.id)
  })
}

function startUndo(s: Session) {
  stopUndo(s.id) // 防御：同会话不可能重复
  const st: UndoState = { s, remaining: UNDO_MS, startedAt: Date.now(), timer: null, paused: false }
  undoMap.set(s.id, st)
  st.timer = window.setTimeout(() => fireUndo(s.id), st.remaining)
}

function stopUndo(id: string) {
  const st = undoMap.get(id)
  if (!st) return
  if (st.timer != null) clearTimeout(st.timer)
  undoMap.delete(id)
}

/** 鼠标停上 / 键盘焦点进入 → 暂停倒计时 */
function pauseUndo(id: string) {
  const st = undoMap.get(id)
  if (!st || st.paused) return
  if (st.timer != null) clearTimeout(st.timer)
  st.remaining -= Date.now() - st.startedAt
  st.timer = null
  st.paused = true
}

/** 移开 / 焦点离开 → 从剩余时间继续 */
function resumeUndo(id: string) {
  const st = undoMap.get(id)
  if (!st || !st.paused) return
  st.startedAt = Date.now()
  st.timer = window.setTimeout(() => fireUndo(id), st.remaining)
  st.paused = false
}

/** 点「撤销」：撤销条缩回，这一行原样恢复，焦点回删除按钮 */
function cancelUndo(id: string) {
  const st = undoMap.get(id)
  if (!st) return
  stopUndo(id)
  say(`「${st.s.title}」已恢复`)
  nextTick(() => {
    const el = document.querySelector(
      `.drawer-del[data-del-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null
    el?.focus()
  })
}

/** 超时：真删。撤销条收回、行高度收 0、下面行平滑补上、计数更新 */
function fireUndo(id: string) {
  const st = undoMap.get(id)
  if (!st) return
  const { s } = st
  const wasCurrent = s.id === route.params.id
  const idx = sessions.sessions.value.findIndex((x) => x.id === s.id)
  stopUndo(id)
  // remove 内部先同步更新内存（行立即消失），落盘异步进行
  void sessions.remove(s.id)
  if (wasCurrent) router.replace('/')
  nextTick(() => {
    // 焦点给下一行（原 idx 处），没有了就给「新建会话」
    const dels = document.querySelectorAll<HTMLElement>('.drawer-del')
    const next = dels[idx]
    if (next) next.focus()
    else newSessionBtn.value?.focus()
  })
}

/** 读屏播报：先清空再写入，保证内容变化（读屏才播报） */
function say(msg: string) {
  announce.value = ''
  nextTick(() => {
    announce.value = msg
  })
}

/** 各行的撤销按钮 ref（真删前的焦点落点） */
const undoBtnEls = new Map<string, HTMLElement>()
function setUndoBtn(id: string, el: unknown) {
  if (el) undoBtnEls.set(id, el as HTMLElement)
  else undoBtnEls.delete(id)
}

const newSessionBtn = ref<HTMLElement | null>(null)

onUnmounted(() => {
  for (const id of [...undoMap.keys()]) stopUndo(id)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="drawer-mask" @click.self="emit('close')">
        <aside class="drawer" role="dialog" aria-label="会话列表">
          <div class="drawer-head">
            <b>会话列表</b>
            <button class="btn sm ghost" aria-label="关闭会话列表" @click="emit('close')">
              <TabIcon name="chevron" :size="16" style="transform: rotate(180deg)" />
            </button>
          </div>

          <div v-if="!sessions.sessions.value.length" class="drawer-empty">
            还没有会话<br />
            点下方「新建会话」开始
          </div>

          <TransitionGroup name="dlist" tag="div" class="drawer-list">
            <div
              v-for="s in sessions.sessions.value"
              :key="s.id"
              class="drawer-item"
              :class="{ current: s.id === String(route.params.id || '') }"
              @click="!undoMap.has(s.id) && openSession(s)"
            >
              <!-- 已删除待撤销：整行原地变撤销条（从删除按钮一侧向左展开） -->
              <div
                v-if="undoMap.has(s.id)"
                class="drawer-undo"
                role="status"
                aria-live="polite"
                @mouseenter="pauseUndo(s.id)"
                @mouseleave="resumeUndo(s.id)"
                @focusin="pauseUndo(s.id)"
                @focusout="resumeUndo(s.id)"
              >
                <span class="drawer-undo-text">「{{ undoMap.get(s.id)!.s.title }}」已删除</span>
                <button
                  class="drawer-undo-btn"
                  :ref="(el) => setUndoBtn(s.id, el)"
                  @click.stop="cancelUndo(s.id)"
                >
                  撤销
                </button>
              </div>

              <!-- 正常会话行 -->
              <template v-else>
                <div class="drawer-item-main">
                  <div class="drawer-item-title">{{ s.title }}</div>
                  <div class="drawer-item-meta">
                    <span class="chip" :class="{ on: modeOf(s) !== 'research' }">
                      <TabIcon :name="MODES[modeOf(s)].icon" :size="12" />
                      {{ MODES[modeOf(s)].name }}
                    </span>
                    <span v-if="kbNames(s).length" class="chip">
                      <TabIcon name="kb" :size="12" />
                      {{ kbNames(s)[0] }}
                    </span>
                  </div>
                  <div class="drawer-item-time">{{ relTime(s.updatedAt) }}</div>
                </div>
                <button
                  class="drawer-del"
                  :data-del-id="s.id"
                  :aria-label="`删除会话 ${s.title}`"
                  @click="askDelete(s, $event)"
                >
                  <TabIcon name="close" :size="15" />
                </button>
              </template>
            </div>
          </TransitionGroup>

          <div class="drawer-foot">
            <button ref="newSessionBtn" class="btn primary" style="width: 100%" @click="emit('new')">
              ＋ 新建会话
            </button>
          </div>
        </aside>
      </div>
    </Transition>

    <!-- 读屏播报（视觉隐藏） -->
    <div class="sr-only" role="status" aria-live="polite">{{ announce }}</div>

    <!-- 删除确认：跟随主题色的圆角卡片 -->
    <Transition name="fade">
      <div v-if="delTarget" class="confirm-mask" @click.self="delTarget = null">
        <div class="confirm-card" role="alertdialog" aria-label="删除会话">
          <div class="confirm-title">删除会话</div>
          <div class="confirm-text">
            删除「{{ delTarget.title }}」？<br />
            删除后对话记录无法恢复。
          </div>
          <div class="confirm-actions">
            <button class="btn" @click="delTarget = null">取消</button>
            <button class="btn danger" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
