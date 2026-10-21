/** 全局记忆：持仓、个人档案、记忆条目。跨会话共享。 */

import { computed, ref } from 'vue'
import type { Holding, MemoryFact, UserProfile } from '@/types'
import * as db from '@/lib/db'
import { nowIso, uid } from '@/lib/fmt'
import { sectorDistribution } from '@/services/memory'

const profile = ref<UserProfile | null>(null)
const holdings = ref<Holding[]>([])
const facts = ref<MemoryFact[]>([])
const loaded = ref(false)

export function emptyProfile(): UserProfile {
  return {
    preferredHorizons: [],
    sectorFocus: [],
    styleTags: [],
    notes: '',
    updatedAt: nowIso(),
  }
}

export function useMemory() {
  async function load() {
    if (loaded.value) return
    profile.value =
      (await db.getSingleton<UserProfile>(db.STORES.profile)) ?? emptyProfile()
    holdings.value = (await db.getAll<Holding>(db.STORES.holdings)).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
    facts.value = (await db.getAll<MemoryFact>(db.STORES.facts)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )
    loaded.value = true
  }

  // ---------- 持仓 ----------
  async function addHoldings(items: Omit<Holding, 'id' | 'firstSeenAt' | 'updatedAt'>[]) {
    const now = nowIso()
    for (const item of items) {
      // 同名已存在则更新，避免截图反复导入产生重复行
      const exist = holdings.value.find(
        (h) => h.name === item.name && h.code === item.code,
      )
      if (exist) {
        Object.assign(exist, item, { updatedAt: now })
        await db.put(db.STORES.holdings, exist)
      } else {
        const h: Holding = {
          ...item,
          id: uid('hd_'),
          firstSeenAt: now,
          updatedAt: now,
        }
        holdings.value.unshift(h)
        await db.put(db.STORES.holdings, h)
      }
    }
  }

  async function updateHolding(h: Holding) {
    h.updatedAt = nowIso()
    await db.put(db.STORES.holdings, h)
  }

  async function removeHolding(id: string) {
    await db.remove(db.STORES.holdings, id)
    holdings.value = holdings.value.filter((h) => h.id !== id)
  }

  async function clearHoldings() {
    await db.clear(db.STORES.holdings)
    holdings.value = []
  }

  // ---------- 档案 ----------
  async function saveProfile(p: UserProfile) {
    p.updatedAt = nowIso()
    profile.value = p
    await db.putSingleton(db.STORES.profile, p)
  }

  async function mergeProfile(patch: Partial<UserProfile>) {
    const base = profile.value ?? emptyProfile()
    const merged: UserProfile = {
      ...base,
      ...patch,
      preferredHorizons: patch.preferredHorizons ?? base.preferredHorizons,
      sectorFocus: patch.sectorFocus ?? base.sectorFocus,
      styleTags: patch.styleTags ?? base.styleTags,
      updatedAt: nowIso(),
    }
    await saveProfile(merged)
  }

  // ---------- 记忆条目 ----------
  async function addFacts(items: Omit<MemoryFact, 'id' | 'createdAt'>[]) {
    for (const item of items) {
      const dup = facts.value.find((f) => f.text === item.text)
      if (dup) continue
      const f: MemoryFact = { ...item, id: uid('fact_'), createdAt: nowIso() }
      facts.value.unshift(f)
      await db.put(db.STORES.facts, f)
    }
  }

  async function toggleFact(f: MemoryFact) {
    f.active = !f.active
    await db.put(db.STORES.facts, f)
  }

  async function removeFact(id: string) {
    await db.remove(db.STORES.facts, id)
    facts.value = facts.value.filter((f) => f.id !== id)
  }

  async function clearAll() {
    await db.clear(db.STORES.holdings)
    await db.clear(db.STORES.facts)
    await db.clear(db.STORES.profile)
    holdings.value = []
    facts.value = []
    profile.value = emptyProfile()
  }

  const confirmedHoldings = computed(() => holdings.value.filter((h) => h.confirmed))
  const pendingHoldings = computed(() => holdings.value.filter((h) => !h.confirmed))
  const activeFacts = computed(() => facts.value.filter((f) => f.active))
  const distribution = computed(() => sectorDistribution(confirmedHoldings.value))
  const totalMarketValue = computed(() =>
    confirmedHoldings.value.reduce((n, h) => n + (h.marketValue ?? 0), 0),
  )
  const totalProfit = computed(() =>
    confirmedHoldings.value.reduce((n, h) => n + (h.profitAmount ?? 0), 0),
  )
  const hasMemory = computed(
    () =>
      confirmedHoldings.value.length > 0 ||
      activeFacts.value.length > 0 ||
      Boolean(profile.value?.notes) ||
      Boolean(profile.value?.riskAppetite),
  )

  return {
    profile,
    holdings,
    facts,
    loaded,
    load,
    addHoldings,
    updateHolding,
    removeHolding,
    clearHoldings,
    saveProfile,
    mergeProfile,
    addFacts,
    toggleFact,
    removeFact,
    clearAll,
    confirmedHoldings,
    pendingHoldings,
    activeFacts,
    distribution,
    totalMarketValue,
    totalProfit,
    hasMemory,
  }
}
