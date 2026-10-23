<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useProviders } from '@/stores/providers'
import { useKnowledge } from '@/stores/knowledge'
import { useMemory } from '@/stores/memory'
import { useSessions } from '@/stores/sessions'
import { installKeyboardWatcher } from '@/lib/keyboard'

const route = useRoute()
const { load: loadProviders, providers } = useProviders()
const knowledge = useKnowledge()
const memory = useMemory()
const sessions = useSessions()
let uninstallKbd: (() => void) | null = null

// 会话详情也归属「会话」这个 Tab，否则底部导航会在进入聊天后失去高亮。
// 按**路径**判断而不是 route.name：名字一改（或测试里的轻量 router 没起名）
// 高亮和跳转逻辑就会静默失效。
const activeTab = computed(() => {
  const p = route.path || '/'
  if (p === '/' || p.startsWith('/s/')) return 'sessions'
  if (p.startsWith('/memory')) return 'memory'
  if (p.startsWith('/kb')) return 'kb'
  if (p.startsWith('/settings')) return 'settings'
  return ''
})

const badge = computed(() => ({
  kb: knowledge.kbs.value.length,
  memory: memory.pendingHoldings.value.length,
}))

/**
 * 「会话」这个 tab 该跳哪里。
 *
 * 在会话模块内部（列表或详情）→ 跳列表，方便切换会话。
 * 从别的模块点回来 → 落回上次打开的会话，而不是把人踢回列表。
 * 若那个会话已被删除，退回列表，避免落到一个不存在的页面。
 */
const sessionsTo = computed(() => {
  if (activeTab.value === 'sessions') return '/'
  const id = sessions.lastSessionId.value
  if (id && sessions.find(id)) return `/s/${id}`
  return '/'
})

const setupHint = computed(() => {
  if (providers.value.length === 0) return '先到「设置」添加一个模型'
  return ''
})

onMounted(async () => {
  // 键盘弹出时收起底栏，把空间让给输入区
  uninstallKbd = installKeyboardWatcher()
  await Promise.all([loadProviders(), knowledge.load(), memory.load()])
})

onUnmounted(() => uninstallKbd?.())
</script>

<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" />
  </router-view>

  <nav class="tabbar">
    <router-link :to="sessionsTo" :class="{ active: activeTab === 'sessions' }">
      <span class="ico">💬</span>
      <span>会话</span>
    </router-link>
    <router-link to="/memory" :class="{ active: activeTab === 'memory' }">
      <span class="ico">🧠</span>
      <span>记忆</span>
      <i v-if="badge.memory" class="dot" />
    </router-link>
    <router-link to="/kb" :class="{ active: activeTab === 'kb' }">
      <span class="ico">📚</span>
      <span>知识库</span>
    </router-link>
    <router-link to="/settings" :class="{ active: activeTab === 'settings' }">
      <span class="ico">⚙️</span>
      <span>设置</span>
      <i v-if="setupHint" class="dot" />
    </router-link>
  </nav>
</template>
