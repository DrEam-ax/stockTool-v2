<script setup lang="ts">
/**
 * 会话栏（左侧抽屉）。
 *
 * 会话详情页左上角三横线打开：列出**所有**会话（标题 + 模式），
 * 点某一项进入该会话；每一项右侧的叉号是删除入口，
 * 点击弹出跟随主题色的圆角确认卡片，确认后删除
 * （删除当前正在看的会话会退回列表页）。
 */
import { ref } from 'vue'
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

function askDelete(s: Session, e: Event) {
  e.stopPropagation()
  delTarget.value = s
}

async function doDelete() {
  const s = delTarget.value
  if (!s) return
  delTarget.value = null
  await sessions.remove(s.id)
  // 删的正是当前正在看的会话 → 退回会话列表，避免落到不存在的页面
  if (s.id === route.params.id) router.replace('/')
}
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

          <div class="drawer-list">
            <div
              v-for="s in sessions.sessions.value"
              :key="s.id"
              class="drawer-item tap"
              :class="{ current: s.id === String(route.params.id || '') }"
              @click="openSession(s)"
            >
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
                :aria-label="`删除会话 ${s.title}`"
                @click="askDelete(s, $event)"
              >
                <TabIcon name="close" :size="15" />
              </button>
            </div>
          </div>

          <div class="drawer-foot">
            <button class="btn primary" style="width: 100%" @click="emit('new')">
              ＋ 新建会话
            </button>
          </div>
        </aside>
      </div>
    </Transition>

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
