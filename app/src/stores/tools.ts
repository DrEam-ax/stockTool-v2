/**
 * 工具配置。
 *
 * 复用 profile 这个 KV store，但用独立的 key（'tool-config'），
 * 免得和用户画像互相覆盖。
 */

import { computed, ref } from 'vue'
import { defaultToolConfig, type ToolConfig } from '@/types'
import * as db from '@/lib/db'

const RECORD_ID = 'tool-config'
const config = ref<ToolConfig>(defaultToolConfig())
const loaded = ref(false)

export function useTools() {
  async function load() {
    if (loaded.value) return
    const raw = await db.get<{ id: string; value: ToolConfig }>(
      db.STORES.profile,
      RECORD_ID,
    )
    if (raw?.value) {
      const d = defaultToolConfig()
      config.value = {
        ...d,
        ...raw.value,
        kb: { ...d.kb, ...(raw.value.kb ?? {}) },
        webSearch: { ...d.webSearch, ...(raw.value.webSearch ?? {}) },
        market: { ...d.market, ...(raw.value.market ?? {}) },
      }
    }
    loaded.value = true
  }

  async function save() {
    await db.put(db.STORES.profile, { id: RECORD_ID, value: config.value })
  }

  function patch(p: Partial<ToolConfig>) {
    config.value = {
      ...config.value,
      ...p,
      kb: { ...config.value.kb, ...(p.kb ?? {}) },
      webSearch: { ...config.value.webSearch, ...(p.webSearch ?? {}) },
      market: { ...config.value.market, ...(p.market ?? {}) },
    }
  }

  async function update(p: Partial<ToolConfig>) {
    patch(p)
    await save()
  }

  const webSearchReady = computed(
    () =>
      config.value.webSearch.enabled &&
      config.value.webSearch.provider !== 'none' &&
      (config.value.webSearch.provider === 'custom'
        ? Boolean(config.value.webSearch.baseUrl)
        : Boolean(config.value.webSearch.apiKey)),
  )

  const enabledCount = computed(
    () =>
      (config.value.kb.enabled ? 1 : 0) +
      (config.value.market.enabled ? 1 : 0) +
      (webSearchReady.value ? 1 : 0),
  )

  return { config, loaded, load, save, update, patch, webSearchReady, enabledCount }
}
