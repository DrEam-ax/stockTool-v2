<script setup lang="ts">
/**
 * 线条图标组件（简易线条 · 纯色 · 2px 线宽 · 圆角端点）。
 * 设计经用户确认：会话=气泡、记忆=灯泡、知识库=书本、设置=齿轮；
 * 后续补充：检验=放大镜、军师=人形、联网=地球、定投=循环、附件=回形针。
 * 全部为对称/规则造型，24px 网格，随 currentColor 着色，尺寸可配。
 */

export type IconName =
  | 'sessions'
  | 'memory'
  | 'kb'
  | 'settings'
  | 'search'
  | 'person'
  | 'globe'
  | 'repeat'
  | 'paperclip'
  | 'image'
  | 'compare'
  | 'menu'
  | 'chevron'

withDefaults(
  defineProps<{ name: IconName; size?: number }>(),
  { size: 20 },
)

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
  // 知识库：打开的书本（研究模式/选军师/消息脚注共用）
  kb: [
    'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
    'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  ],
  // 设置：齿轮
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  ],
  // 检验模式：放大镜
  search: [
    'M21 21l-4.35-4.35',
  ],
  // 军师模式：人形（扮演大V本人）
  person: [
    'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2',
  ],
  // 联网：地球
  globe: [
    'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    'M2 12h20',
  ],
  // 定投：循环箭头
  repeat: [
    'm17 2 4 4-4 4',
    'M3 11v-1a4 4 0 0 1 4-4h14',
    'm7 22-4-4 4-4',
    'M21 13v1a4 4 0 0 1-4 4H3',
  ],
  // 附件：回形针
  paperclip: [
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  ],
  // 图片：相框 + 山 + 太阳（工具栏「图片」）
  image: [
    'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M4 17l5-5 4 3 3-3 5 5',
  ],
  // 对比：左右对向箭头（工具栏「对比」/ 切换按钮）
  compare: [
    'M3 7h12',
    'm11 3 4 4-4 4',
    'M21 17H9',
    'm13 13-4 4 4 4',
  ],
  // 菜单：三横线（会话详情顶栏，打开左侧会话栏）
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  // 右箭头（会话栏里每条的删除入口）
  chevron: ['m9 6 6 6-6 6'],
}

/** 圆形子元素：各图标的中心圆 */
const circles: Record<IconName, Array<[number, number, number]>> = {
  settings: [[12, 12, 3]],
  search: [[11, 11, 8]],
  person: [[12, 7, 4]],
  globe: [[12, 12, 10]],
  sessions: [],
  memory: [],
  kb: [],
  repeat: [],
  paperclip: [],
  image: [[15.5, 8.5, 1.8]],
  compare: [],
  menu: [],
  chevron: [],
}
</script>

<template>
  <svg
    class="tab-ico"
    :width="size"
    :height="size"
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
  display: inline-block;
  vertical-align: -0.15em;
}
</style>
