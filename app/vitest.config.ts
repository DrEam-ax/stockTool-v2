import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

/**
 * 组件测试用的 Vite 配置。
 *
 * 单独一份而不是复用 vite.config.ts：那份是为**打包 App** 服务的
 * （base: './'、产物目录 dist），测试跑在 Node 里，需求完全不同。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 组件测试不需要并发，输出更好读
    reporters: ['verbose'],
  },
})
