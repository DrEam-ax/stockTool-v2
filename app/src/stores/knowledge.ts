/** 知识库：导入 .stkb、启用/停用、删除。 */

import { computed, ref } from 'vue'
import type { KnowledgeBase } from '@/types'
import * as db from '@/lib/db'
import { parseKbBytes, KbParseError } from '@/services/kb'

const kbs = ref<KnowledgeBase[]>([])
const loaded = ref(false)

export function useKnowledge() {
  async function load() {
    if (loaded.value) return
    kbs.value = (await db.getAll<KnowledgeBase>(db.STORES.kbs)).sort((a, b) =>
      a.importedAt.localeCompare(b.importedAt),
    )
    loaded.value = true
  }

  async function importFile(file: File): Promise<{ kb: KnowledgeBase; warnings: string[] }> {
    const buf = new Uint8Array(await file.arrayBuffer())
    const { kb, warnings } = parseKbBytes(buf, file.size)
    // 同一个 kb_id 重复导入视为更新（换版本时替换而不是并存）
    const exist = kbs.value.find((k) => k.manifest.kb_id === kb.manifest.kb_id)
    if (exist) {
      kb.id = exist.id
      kb.enabled = exist.enabled
      await db.put(db.STORES.kbs, kb)
      const i = kbs.value.findIndex((k) => k.id === exist.id)
      kbs.value[i] = kb
      warnings.unshift('已存在同一 kb_id 的知识库，本次为覆盖更新')
    } else {
      await db.put(db.STORES.kbs, kb)
      kbs.value.push(kb)
    }
    return { kb, warnings }
  }

  async function toggle(kb: KnowledgeBase, enabled: boolean) {
    kb.enabled = enabled
    await db.put(db.STORES.kbs, kb)
  }

  async function remove(id: string) {
    await db.remove(db.STORES.kbs, id)
    kbs.value = kbs.value.filter((k) => k.id !== id)
  }

  async function rename(kb: KnowledgeBase, title: string) {
    kb.manifest.title = title
    await db.put(db.STORES.kbs, kb)
  }

  /** 会话里引用的知识库可能已被删除，这里过滤掉失效 id */
  function resolve(ids: string[]): KnowledgeBase[] {
    return ids
      .map((id) => kbs.value.find((k) => k.id === id))
      .filter((k): k is KnowledgeBase => Boolean(k) && k!.enabled)
  }

  const enabledKbs = computed(() => kbs.value.filter((k) => k.enabled))
  const totalOpinions = computed(() =>
    kbs.value.reduce((n, k) => n + k.opinions.length, 0),
  )
  const totalSize = computed(() => kbs.value.reduce((n, k) => n + k.sizeBytes, 0))

  return {
    kbs,
    loaded,
    load,
    importFile,
    toggle,
    remove,
    rename,
    resolve,
    enabledKbs,
    totalOpinions,
    totalSize,
    KbParseError,
  }
}
