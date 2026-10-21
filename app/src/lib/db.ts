/**
 * IndexedDB 封装。
 *
 * 刻意不引入 dexie/idb 之类的库：需求就是最朴素的 KV 读写，
 * 自己写一百行比多一个依赖更划算（这个 App 的体积是有意义的指标）。
 */

const DB_NAME = 'stocktool-app'
const DB_VERSION = 1

export const STORES = {
  providers: 'providers',
  kbs: 'kbs',
  profile: 'profile',
  holdings: 'holdings',
  facts: 'facts',
  sessions: 'sessions',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  return (await tx<T | undefined>(store, 'readonly', (s) => s.get(id))) as
    | T
    | undefined
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  return (await tx<T[]>(store, 'readonly', (s) => s.getAll())) as T[]
}

/**
 * 写库前把值变成**结构化的纯数据**。
 *
 * 为什么必须做：调用方常常直接传 Vue 的 reactive 对象（那是 Proxy），
 * 而 IndexedDB 用结构化克隆算法存值 —— 传 Proxy 在部分 WebView 上会直接
 * 抛 DataCloneError。更糟的是如果调用方没写 try/catch，
 * 表现就是「点了保存什么都没发生」，极难排查。
 *
 * 这些记录本来就是纯 JSON 数据（时间戳都是 ISO 字符串），
 * 走一遍 JSON 既安全又顺便去掉 undefined / 函数 / Proxy。
 */
// 导出供测试使用：证明「Vue reactive 对象不能直接结构化克隆」
// 以及「过一遍 toPlain 之后可以」。
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export async function put<T extends { id: string }>(
  store: StoreName,
  value: T,
): Promise<T> {
  await tx(store, 'readwrite', (s) => s.put(toPlain(value)))
  return value
}

export async function putMany<T extends { id: string }>(
  store: StoreName,
  values: T[],
): Promise<void> {
  if (!values.length) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const os = t.objectStore(store)
    for (const v of values) os.put(toPlain(v))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function remove(store: StoreName, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id))
}

export async function clear(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear())
}

/** 单例配置（profile）用固定 id 存 */
export const SINGLETON_ID = 'singleton'

export async function getSingleton<T>(store: StoreName): Promise<T | undefined> {
  return get<T>(store, SINGLETON_ID)
}

export async function putSingleton(store: StoreName, value: unknown): Promise<void> {
  await put(store, { ...(value as object), id: SINGLETON_ID } as { id: string })
}

/** 估算本机占用，设置页用来展示 */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
}
