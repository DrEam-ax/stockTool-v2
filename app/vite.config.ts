import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    watch: {
      // 编辑器/工具做原子写入时，会先在源码目录里建一个 *.tmpdir 临时目录，
      // 写完再改名。chokidar 去 watch 那个临时文件时会 EBUSY，
      // 而 Vite 把它当未捕获异常 —— 直接让 dev server 整个退出。
      // 实测改一次 .vue 就崩一次，必须忽略掉。
      ignored: [
        '**/*.tmpdir/**',
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
  },
  // 知识库是外部产物，App 只做解析与渲染；这里不做任何打包内联，
  // 保证 apk 体积只跟代码有关，不跟知识库数量有关。
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
