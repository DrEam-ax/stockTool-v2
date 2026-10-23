<script setup lang="ts">
/**
 * 底部导航线条图标（简易线条 · 纯色 · 2px 线宽 · 圆角端点）。
 * 设计经用户确认：会话=气泡、记忆=灯泡、知识库=书本、设置=齿轮。
 * 全部为对称/规则造型，24px 网格，随 currentColor 着色。
 */

type IconName = 'sessions' | 'memory' | 'kb' | 'settings'

withDefaults(defineProps<{ name: IconName }>(), {})

const paths: Record<IconName, string[]> = {
  // 会话：对话气泡
  sessions: [
    'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
  ],
  // 记忆：灯泡（用户从 4 个对称候选中选定）
  memory: [
    'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5',
    'M9 18h6',
    'M10 22h4',
  ],
  // 知识库：打开的书本
  kb: [
    'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
    'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  ],
  // 设置：齿轮
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  ],
}

/** 圆形子元素：设置图标的中心圆 */
const circles: Record<IconName, Array<[number, number, number]>> = {
  settings: [[12, 12, 3]],
  sessions: [],
  memory: [],
  kb: [],
}
</script>

<template>
  <svg
    class="tab-ico"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths[name]" :key="'p' + i" :d="d" />
    <circle
      v-for="(c, i) in circles[name]"
      :key="'c' + i"
      :cx="c[0]"
      :cy="c[1]"
      :r="c[2]"
    />
  </svg>
</template>

<style scoped>
.tab-ico {
  width: 20px;
  height: 20px;
  display: block;
}
</style>
