<script setup lang="ts">
/**
 * 会话列表。
 *
 * 列表页保留三个职责：空态引导、会话总览、新建会话入口；
 * 新建会话弹窗已抽成共用组件 NewSessionModal（会话详情页也能打开）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { AdvisorMode, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import { useProviders } from '@/stores/providers'
import TabIcon from '@/components/TabIcon.vue'
import type { IconName } from '@/components/TabIcon.vue'
import NewSessionModal from '@/components/NewSessionModal.vue'
import { relTime } from '@/lib/fmt'

const router = useRouter()
const sessions = useSessions()
const knowledge = useKnowledge()
const { providers, load: loadProviders } = useProviders()

const showNew = ref(false)

onMounted(async () => {
  await Promise.all([sessions.load(), loadProviders()])
})

const noProvider = computed(() => providers.value.length === 0)

/** 列表 chips 用的模式名映射（新建弹窗内部有完整 MODES 描述） */
const MODE_NAMES: Record<AdvisorMode, { icon: IconName; name: string }> = {
  audit: { icon: 'search', name: '检验我的操作' },
  persona: { icon: 'person', name: '请教军师' },
  research: { icon: 'kb', name: '研究历史观点' },
}

function modeOf(s: Session): AdvisorMode {
  return s.mode ?? 'research'
}

function modeMeta(id: AdvisorMode) {
  return MODE_NAMES[id] ?? MODE_NAMES.research
}

function preview(s: Session): string {
  const last = [...s.messages].reverse().find((m) => m.content)
  if (!last) return '还没有对话'
  return last.content.replace(/\s+/g, ' ').slice(0, 60)
}

async function onDelete(s: Session, e: Event) {
  e.stopPropagation()
  if (!confirm(`删除会话「${s.title}」？`)) return
  await sessions.remove(s.id)
}

function kbNames(s: Session): string[] {
  return knowledge
    .resolve(s.activeKbIds)
    .map((k) => k.author?.name || k.manifest.title)
}
</script>

<template>
  <div class="page">
    <div class="section-title">会话</div>

    <div v-if="noProvider" class="alert warn">
      还没有配置模型。先去
      <router-link to="/settings">设置</router-link>
      添加一个（填你自己的 API Key），否则无法对话。
    </div>

    <div v-if="!sessions.sessions.value.length" class="empty">
      <div class="big"><TabIcon name="sessions" :size="36" /></div>
      还没有会话<br />
      新建一个，问它某只票或某个板块
    </div>

    <div
      v-for="s in sessions.sessions.value"
      :key="s.id"
      class="card tap"
      @click="router.push(`/s/${s.id}`)"
    >
      <div class="spread">
        <div style="flex: 1; min-width: 0">
          <div class="card-title">{{ s.title }}</div>
          <div class="card-meta">{{ preview(s) }}</div>
          <div class="chips" style="margin-top: 6px">
            <span class="chip" :class="{ on: modeOf(s) !== 'research' }">
              <TabIcon :name="modeMeta(modeOf(s)).icon" :size="13" />
              {{ modeMeta(modeOf(s)).name }}
            </span>
            <span v-if="s.focusSubject?.name" class="chip">
              聚焦 {{ s.focusSubject.name }}
            </span>
            <span class="chip" :class="{ on: s.useGlobalMemory }">
              {{ s.useGlobalMemory ? '共享记忆' : '隔离记忆' }}
            </span>
            <span v-for="n in kbNames(s)" :key="n" class="chip">
              <TabIcon name="kb" :size="13" />
              {{ n }}
            </span>
            <span v-if="!kbNames(s).length" class="chip">无军师</span>
          </div>
        </div>
        <div style="text-align: right; flex: none">
          <div class="muted small">{{ relTime(s.updatedAt) }}</div>
          <button class="btn sm ghost danger" style="margin-top: 6px" @click="onDelete(s, $event)">
            删除
          </button>
        </div>
      </div>
    </div>

    <button class="fab" @click="showNew = true">＋</button>

    <!-- 新建会话（共用弹窗） -->
    <NewSessionModal
      :open="showNew"
      @close="showNew = false"
      @created="(s) => { showNew = false; router.push(`/s/${s.id}`) }"
    />
  </div>
</template>
