import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置。
 *
 * 这里最关键的是 `CapacitorHttp.enabled`：
 * 打开后 fetch/XHR 会走**原生 HTTP**，从而绕开浏览器 CORS ——
 * 腾讯行情、东财基金持仓、多数搜索 API 都不返回 CORS 头，
 * 在浏览器里必被拦，装上 App 走原生就没这个限制。
 *
 * 代价：原生 HTTP **不提供可读流**，SSE 流式输出会退化成整段返回。
 * services/llm.ts 里已经做了兼容（检测不到可读流就按整段解析），
 * 所以功能不受影响，只是回答会一次性出现而不是逐字蹦。
 */
const config: CapacitorConfig = {
  appId: 'com.stocktool.app',
  appName: '选股助手',
  webDir: 'dist',
  // 用 https 作为 WebView 的内部 origin，避免被当成不安全上下文
  server: {
    androidScheme: 'https',
  },
  android: {
    // 我们不需要明文 HTTP（除了用户自己配的本地 Ollama，
    // 那种场景用户可以自己开；默认关掉更安全）
    allowMixedContent: false,
    captureInput: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
