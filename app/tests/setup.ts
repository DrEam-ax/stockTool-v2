/**
 * vitest 全局环境。
 *
 * jsdom 没有 IndexedDB，而本 App 每个页面都会用到它 ——
 * 不装这个，任何 mounted 组件都会在 `indexedDB.open` 上直接炸。
 * fake-indexeddb 是这方面的事实标准。
 */
import 'fake-indexeddb/auto'

// jsdom 没有这些，而 App 里会用
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}

// 刻意**不**在 beforeEach 里删 IndexedDB：
// fake-indexeddb 的 deleteDatabase 在仍有连接时会挂住（App 里的
// openDb 把连接缓存住了，永远不会 close），表现为整个用例超时 10s。
// 各用例本来就该互相独立，不靠删库来隔离。
