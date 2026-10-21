<script setup lang="ts">
/**
 * 全局记忆：截图 → 持仓 → 个人画像。
 *
 * 两个刻意的摩擦设计（都是为了防止污染后续所有分析）：
 *   1. 截图识别出的持仓默认 confirmed=false，必须用户逐条核对勾选才计入
 *   2. 画像推断的每条结论都要能展开看到依据，且可单独删除
 * 宁可让用户多点两下，也不要让 AI 拿着错误的持仓给出"贴心"的建议。
 */
import { computed, onMounted, ref } from 'vue'
import type { Holding, ModelProvider } from '@/types'
import { useMemory } from '@/stores/memory'
import { useProviders } from '@/stores/providers'
import {
  extractHoldingsFromImages,
  inferProfile,
  commentOnPortfolio,
  type ParsedHolding,
} from '@/services/memory'
import { compressImage, fileToDataUrl } from '@/services/llm'
import { fmtMoney, fmtSignedPct } from '@/lib/fmt'
import HoldingEditor from '@/components/HoldingEditor.vue'

const memory = useMemory()
const { providers, load: loadProviders, defaultProvider, visionProviders } = useProviders()

const fileInput = ref<HTMLInputElement | null>(null)
const providerId = ref('')
const busy = ref(false)
const busyText = ref('')
const error = ref('')
const info = ref('')

/** 待确认的截图识别结果 */
const pending = ref<(ParsedHolding & { _checked: boolean; _id: string })[]>([])
const pendingSummary = ref('')
const pendingImages = ref<string[]>([])
const showConfirm = ref(false)

const editingHolding = ref<Holding | null>(null)
const showProfile = ref(false)
const expandedFact = ref<string | null>(null)

const activeProvider = computed<ModelProvider | null>(() => {
  if (providerId.value) {
    return providers.value.find((p) => p.id === providerId.value) ?? null
  }
  return visionProviders.value[0] ?? defaultProvider.value
})

onMounted(async () => {
  await Promise.all([memory.load(), loadProviders()])
  if (visionProviders.value[0]) providerId.value = visionProviders.value[0].id
})

// ---------------- 截图识别 ----------------
async function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return

  error.value = ''
  info.value = ''
  const p = activeProvider.value
  if (!p) {
    error.value = '还没有配置模型，请先到「设置 → 模型」添加一个'
    return
  }

  busy.value = true
  busyText.value = '压缩图片…'
  try {
    const images: string[] = []
    for (const f of files) {
      const raw = await fileToDataUrl(f)
      images.push(await compressImage(raw))
    }
    busyText.value = '识别中（这一步用的是你的识图模型）…'
    const res = await extractHoldingsFromImages(p, images)

    if (!res.holdings.length) {
      error.value =
        `没有识别到持仓条目。${res.summary ? `模型说：${res.summary}` : ''}\n` +
        '可能这张图不是持仓截图，或模型不支持识图。'
      return
    }

    pending.value = res.holdings.map((h, i) => ({
      ...h,
      _checked: h.confidence >= 0.6,
      _id: `p${i}`,
    }))
    pendingSummary.value = res.summary ?? ''
    pendingImages.value = images
    showConfirm.value = true
    if (res.warnings.length) info.value = res.warnings.join('\n')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    busyText.value = ''
  }
}

async function confirmPending() {
  const chosen = pending.value.filter((h) => h._checked)
  if (!chosen.length) {
    showConfirm.value = false
    return
  }
  await memory.addHoldings(
    chosen.map((h) => ({
      name: h.name,
      code: h.code,
      shares: h.shares,
      costPrice: h.costPrice,
      lastPrice: h.lastPrice,
      marketValue: h.marketValue,
      profitAmount: h.profitAmount,
      profitPct: h.profitPct,
      source: 'screenshot' as const,
      confirmed: true,
      note: h.note,
    })),
  )
  showConfirm.value = false
  pending.value = []
  info.value = `已录入 ${chosen.length} 只持仓`
  await memory.load()
}

async function saveUnconfirmed() {
  if (!pending.value.length) return
  await memory.addHoldings(
    pending.value.map((h) => ({
      name: h.name,
      code: h.code,
      shares: h.shares,
      costPrice: h.costPrice,
      lastPrice: h.lastPrice,
      marketValue: h.marketValue,
      profitAmount: h.profitAmount,
      profitPct: h.profitPct,
      source: 'screenshot' as const,
      confirmed: false,
      note: h.note,
    })),
  )
  showConfirm.value = false
  pending.value = []
  info.value = '已保存为「待确认」，确认前不会参与分析'
  await memory.load()
}

// ---------------- 持仓操作 ----------------
async function confirmHolding(h: Holding) {
  h.confirmed = true
  await memory.updateHolding(h)
}

function editHolding(h: Holding) {
  editingHolding.value = { ...h }
}

async function saveHoldingEdit() {
  if (!editingHolding.value) return
  const h = editingHolding.value
  await memory.updateHolding(h)
  const i = memory.holdings.value.findIndex((x) => x.id === h.id)
  if (i >= 0) memory.holdings.value[i] = h
  editingHolding.value = null
}

function addManual() {
  editingHolding.value = {
    id: `hd_${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    source: 'manual',
    confirmed: true,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ---------------- 画像推断 ----------------
async function onInfer() {
  const p = defaultProvider.value
  if (!p) {
    error.value = '请先配置一个模型'
    return
  }
  if (!memory.confirmedHoldings.value.length) {
    error.value = '还没有已确认的持仓，无法推断'
    return
  }
  busy.value = true
  busyText.value = '正在归纳画像…'
  error.value = ''
  try {
    const res = await inferProfile(p, {
      holdings: memory.confirmedHoldings.value.map((h) => ({
        name: h.name,
        code: h.code,
        marketValue: h.marketValue,
        profitPct: h.profitPct,
      })),
      existingNotes: memory.profile.value?.notes,
    })
    await memory.mergeProfile(res.profile)
    await memory.addFacts(res.facts)
    info.value = `画像已更新：${res.facts.length} 条新记忆`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    busyText.value = ''
  }
}

async function onComment() {
  const p = defaultProvider.value
  if (!p) {
    error.value = '请先配置一个模型'
    return
  }
  busy.value = true
  busyText.value = '分析持仓结构…'
  error.value = ''
  try {
    const text = await commentOnPortfolio(
      p,
      memory.confirmedHoldings.value.map((h) => ({
        name: h.name,
        profitPct: h.profitPct,
        marketValue: h.marketValue,
      })),
    )
    info.value = text
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    busyText.value = ''
  }
}

// ---------------- 画像编辑 ----------------
const profileDraft = ref({ riskAppetite: '', horizons: [] as string[], tags: '', notes: '' })
function openProfile() {
  const p = memory.profile.value
  profileDraft.value = {
    riskAppetite: p?.riskAppetite ?? '',
    horizons: [...(p?.preferredHorizons ?? [])],
    tags: (p?.styleTags ?? []).join('、'),
    notes: p?.notes ?? '',
  }
  showProfile.value = true
}
async function saveProfileDraft() {
  await memory.mergeProfile({
    riskAppetite: (profileDraft.value.riskAppetite || undefined) as never,
    preferredHorizons: profileDraft.value.horizons as never,
    styleTags: profileDraft.value.tags
      .split(/[、,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    notes: profileDraft.value.notes,
  })
  showProfile.value = false
}
function toggleHorizon(h: string) {
  const a = profileDraft.value.horizons
  const i = a.indexOf(h)
  if (i >= 0) a.splice(i, 1)
  else a.push(h)
}

const riskLabel: Record<string, string> = {
  conservative: '保守',
  balanced: '平衡',
  aggressive: '激进',
}
const horizonLabel: Record<string, string> = { short: '短线', mid: '中线', long: '长线' }
const kindLabel: Record<string, string> = {
  preference: '偏好',
  constraint: '约束',
  observation: '观察',
  goal: '目标',
}
</script>

<template>
  <div class="page">
    <div v-if="error" class="alert err" style="white-space: pre-wrap">{{ error }}</div>
    <div v-if="info" class="alert ok" style="white-space: pre-wrap">{{ info }}</div>

    <!-- ---------- 截图导入 ---------- -->
    <div class="section-title">从截图导入持仓</div>
    <div class="card">
      <div class="card-body">
        上传券商持仓截图，AI 自动读出持仓与盈亏。支持多张一起传。
      </div>

      <div class="field" style="margin-top: 10px">
        <label>用于识图的模型</label>
        <select v-model="providerId">
          <option value="">（使用默认模型）</option>
          <option v-for="p in providers" :key="p.id" :value="p.id">
            {{ p.name }}{{ p.supportsVision ? ' · 支持识图' : ' · 未标记识图' }}
          </option>
        </select>
        <div
          v-if="activeProvider && !activeProvider.supportsVision"
          class="hint"
          style="color: var(--warn)"
        >
          「{{ activeProvider.name }}」未标记为支持识图，识别大概率会失败。
        </div>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="onPickImages"
      />
      <button class="btn primary" style="width: 100%" :disabled="busy" @click="fileInput?.click()">
        <span v-if="busy" class="spin" />
        {{ busy ? busyText : '选择截图并识别' }}
      </button>
    </div>

    <!-- ---------- 持仓 ---------- -->
    <div class="section-title">
      当前持仓（{{ memory.confirmedHoldings.value.length }} 只已确认）
    </div>

    <div class="grid3" v-if="memory.confirmedHoldings.value.length">
      <div class="stat">
        <div class="k">总市值</div>
        <div class="v">{{ fmtMoney(memory.totalMarketValue.value, 0) }}</div>
      </div>
      <div class="stat">
        <div class="k">总盈亏</div>
        <div
          class="v"
          :style="{ color: memory.totalProfit.value >= 0 ? 'var(--up)' : 'var(--down)' }"
        >
          {{ fmtMoney(memory.totalProfit.value, 0) }}
        </div>
      </div>
      <div class="stat">
        <div class="k">待确认</div>
        <div class="v">{{ memory.pendingHoldings.value.length }}</div>
      </div>
    </div>

    <div v-if="memory.distribution.value.length" class="card">
      <div class="card-title" style="font-size: 13px">板块分布（按市值）</div>
      <div
        v-for="d in memory.distribution.value"
        :key="d.name"
        style="margin-top: 7px"
      >
        <div class="spread small">
          <span>{{ d.name }}</span>
          <span class="muted">{{ Math.round(d.weight * 100) }}%</span>
        </div>
        <div class="bar"><i :style="{ width: `${Math.round(d.weight * 100)}%` }" /></div>
      </div>
    </div>

    <div v-for="h in memory.holdings.value" :key="h.id" class="card">
      <div class="spread">
        <div style="min-width: 0">
          <div class="card-title">
            {{ h.name || '（未命名）' }}
            <span v-if="!h.confirmed" class="badge warn">待确认</span>
            <span v-if="h.source === 'screenshot'" class="badge">截图</span>
          </div>
          <div class="card-meta">
            <span v-if="h.code" class="mono">{{ h.code }}</span>
            <span v-if="h.shares"> · {{ h.shares }} 股</span>
            <span v-if="h.costPrice"> · 成本 {{ h.costPrice }}</span>
            <span v-if="h.marketValue"> · 市值 {{ fmtMoney(h.marketValue, 0) }}</span>
          </div>
          <div v-if="h.profitPct != null || h.profitAmount != null" class="card-meta">
            盈亏
            <span
              :style="{ color: (h.profitPct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }"
            >
              {{ h.profitPct != null ? fmtSignedPct(h.profitPct) : fmtMoney(h.profitAmount) }}
            </span>
          </div>
        </div>
      </div>
      <div class="btn-row" style="margin-top: 8px">
        <button v-if="!h.confirmed" class="btn sm primary" @click="confirmHolding(h)">
          确认
        </button>
        <button class="btn sm" @click="editHolding(h)">编辑</button>
        <button class="btn sm danger" @click="memory.removeHolding(h.id)">删除</button>
      </div>
    </div>

    <div class="btn-row" style="margin-top: 8px">
      <button class="btn" @click="addManual">+ 手动添加</button>
      <button
        v-if="memory.holdings.value.length"
        class="btn danger sm"
        @click="memory.clearHoldings()"
      >
        清空持仓
      </button>
    </div>

    <!-- ---------- 个人档案 ---------- -->
    <div class="section-title">个人档案</div>
    <div class="card">
      <div v-if="memory.profile.value" class="card-body">
        <div>
          风险偏好：<b>{{ riskLabel[memory.profile.value.riskAppetite ?? ''] ?? '未设置' }}</b>
        </div>
        <div>
          偏好周期：<b>{{
            memory.profile.value.preferredHorizons.map((h) => horizonLabel[h] ?? h).join('/') ||
            '未设置'
          }}</b>
        </div>
        <div v-if="memory.profile.value.styleTags.length">
          风格标签：<b>{{ memory.profile.value.styleTags.join('、') }}</b>
        </div>
        <div v-if="memory.profile.value.notes">自述：{{ memory.profile.value.notes }}</div>
      </div>
      <div class="btn-row" style="margin-top: 8px">
        <button class="btn sm" @click="openProfile">编辑档案</button>
        <button class="btn sm" :disabled="busy" @click="onInfer">让 AI 推断</button>
        <button class="btn sm" :disabled="busy" @click="onComment">分析持仓结构</button>
      </div>
    </div>

    <!-- ---------- 记忆条目 ---------- -->
    <div class="section-title">记忆条目（{{ memory.activeFacts.value.length }} 条生效）</div>
    <div v-if="!memory.facts.value.length" class="card muted small">
      还没有记忆条目。点上面的「让 AI 推断」，它会根据你的持仓归纳出偏好与约束。
    </div>
    <div v-for="f in memory.facts.value" :key="f.id" class="card">
      <div class="spread">
        <div style="flex: 1; min-width: 0">
          <div class="card-title" style="font-size: 14px">
            <span class="badge">{{ kindLabel[f.kind] ?? f.kind }}</span>
            <span :style="{ opacity: f.active ? 1 : 0.45 }">{{ f.text }}</span>
          </div>
        </div>
        <div class="switch" :class="{ on: f.active }" @click="memory.toggleFact(f)"><i /></div>
      </div>
      <div v-if="f.evidence.length" style="margin-top: 6px">
        <button
          class="btn sm ghost"
          @click="expandedFact = expandedFact === f.id ? null : f.id"
        >
          {{ expandedFact === f.id ? '收起依据' : `依据 (${f.evidence.length})` }}
          <span class="muted">置信 {{ Math.round(f.confidence * 100) }}%</span>
        </button>
        <ul v-if="expandedFact === f.id" class="small muted" style="padding-left: 18px">
          <li v-for="(e, i) in f.evidence" :key="i">{{ e }}</li>
        </ul>
      </div>
      <div class="btn-row" style="margin-top: 6px">
        <button class="btn sm danger" @click="memory.removeFact(f.id)">删除</button>
      </div>
    </div>

    <!-- ---------- 确认弹层（关键环节） ---------- -->
    <div v-if="showConfirm" class="modal-mask" @click.self="showConfirm = false">
      <div class="modal">
        <h2>核对识别结果</h2>
        <div class="alert warn">
          识图模型可能读错数字。<b>请逐条核对后再确认</b>——错的持仓会污染之后所有的分析，
          而且很难事后发现。
          <div v-if="pendingSummary" style="margin-top: 6px">模型描述：{{ pendingSummary }}</div>
        </div>

        <div v-if="pendingImages.length" class="msg-imgs" style="justify-content: flex-start">
          <img v-for="(src, i) in pendingImages" :key="i" :src="src" alt="截图" />
        </div>

        <HoldingEditor v-for="h in pending" :key="h._id" :holding="h" />

        <div class="btn-row">
          <button class="btn" @click="showConfirm = false">取消</button>
          <button class="btn" @click="saveUnconfirmed">存为待确认</button>
          <div style="flex: 1" />
          <button class="btn primary" @click="confirmPending">
            确认录入 {{ pending.filter((h) => h._checked).length }} 只
          </button>
        </div>
      </div>
    </div>

    <!-- ---------- 持仓编辑 ---------- -->
    <div v-if="editingHolding" class="modal-mask" @click.self="editingHolding = null">
      <div class="modal">
        <h2>编辑持仓</h2>
        <div class="field">
          <label>名称</label>
          <input v-model="editingHolding.name" type="text" />
        </div>
        <div class="field">
          <label>代码</label>
          <input v-model="editingHolding.code" type="text" placeholder="600519" />
        </div>
        <div class="grid2">
          <div class="field">
            <label>股数</label>
            <input v-model.number="editingHolding.shares" type="number" />
          </div>
          <div class="field">
            <label>成本价</label>
            <input v-model.number="editingHolding.costPrice" type="number" step="0.001" />
          </div>
          <div class="field">
            <label>现价</label>
            <input v-model.number="editingHolding.lastPrice" type="number" step="0.001" />
          </div>
          <div class="field">
            <label>市值</label>
            <input v-model.number="editingHolding.marketValue" type="number" />
          </div>
          <div class="field">
            <label>盈亏金额</label>
            <input v-model.number="editingHolding.profitAmount" type="number" />
          </div>
          <div class="field">
            <label>盈亏比例（小数）</label>
            <input v-model.number="editingHolding.profitPct" type="number" step="0.0001" />
          </div>
        </div>
        <div class="field">
          <label>备注</label>
          <input v-model="editingHolding.note" type="text" />
        </div>
        <div class="field">
          <label class="check">
            <input v-model="editingHolding.confirmed" type="checkbox" />
            <span>已确认（参与 AI 分析）</span>
          </label>
        </div>
        <div class="btn-row">
          <button class="btn" @click="editingHolding = null">取消</button>
          <div style="flex: 1" />
          <button class="btn primary" @click="saveHoldingEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- ---------- 档案编辑 ---------- -->
    <div v-if="showProfile" class="modal-mask" @click.self="showProfile = false">
      <div class="modal">
        <h2>编辑个人档案</h2>
        <div class="field">
          <label>风险偏好</label>
          <select v-model="profileDraft.riskAppetite">
            <option value="">未设置</option>
            <option value="conservative">保守</option>
            <option value="balanced">平衡</option>
            <option value="aggressive">激进</option>
          </select>
        </div>
        <div class="field">
          <label>偏好周期</label>
          <div class="chips">
            <span
              v-for="h in ['short', 'mid', 'long']"
              :key="h"
              class="chip pick"
              :class="{ on: profileDraft.horizons.includes(h) }"
              @click="toggleHorizon(h)"
            >
              {{ horizonLabel[h] }}
            </span>
          </div>
        </div>
        <div class="field">
          <label>风格标签</label>
          <input v-model="profileDraft.tags" type="text" placeholder="用、分隔，如：偏好科技成长" />
        </div>
        <div class="field">
          <label>自述</label>
          <textarea
            v-model="profileDraft.notes"
            placeholder="你希望 AI 知道的任何事，比如「不接受亏损超过 20%」「只做沪深300成分股」"
          />
        </div>
        <div class="btn-row">
          <button class="btn" @click="showProfile = false">取消</button>
          <div style="flex: 1" />
          <button class="btn primary" @click="saveProfileDraft">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
