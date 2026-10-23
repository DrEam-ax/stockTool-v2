<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useProviders } from '@/stores/providers'
import { useKnowledge } from '@/stores/knowledge'
import { useMemory } from '@/stores/memory'
import { installKeyboardWatcher } from '@/lib/keyboard'

const route = useRoute()
const { load: loadProviders, providers } = useProviders()
const knowledge = useKnowledge()
const memory = useMemory()
let uninstallKbd: (() => void) | null = null

// 会话详情也归属「会话」这个 Tab，否则底部导航会在进入聊天后失去高亮
const activeTab = computed(() => {
  const n = String(route.name || '')
  if (n === 'session' || n === 'sessions') return 'sessions'
  return n
})

const badge = computed(() => ({
  kb: knowledge.kbs.value.length,
  memory: memory.pendingHoldings.value.length,
}))

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
    <router-link to="/" :class="{ active: activeTab === 'sessions' }">
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
