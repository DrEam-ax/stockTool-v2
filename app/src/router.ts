/**
 * 路由。
 *
 * 用 hash 模式：Capacitor 打包后页面来自 file:// 或 capacitor://，
 * history 模式会在深链接上 404。
 */

import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'sessions', component: () => import('@/views/SessionsView.vue') },
  {
    path: '/s/:id',
    name: 'session',
    component: () => import('@/views/SessionDetail.vue'),
    props: true,
  },
  { path: '/memory', name: 'memory', component: () => import('@/views/MemoryView.vue') },
  { path: '/kb', name: 'kb', component: () => import('@/views/KnowledgeView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
