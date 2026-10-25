<script setup lang="ts">
/**
 * 设置：模型提供商管理。
 *
 * 设计原则：用户自带 key、自带 baseUrl。App 不代理、不上传，
 * 密钥只留在本机 IndexedDB 里。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ModelProvider, ProviderCheck } from '@/types'
import { useProviders, emptyProvider, PRESETS } from '@/stores/providers'
import { useKnowledge } from '@/stores/knowledge'
import { useMemory } from '@/stores/memory'
import { useTools } from '@/stores/tools'
import { listModels } from '@/services/llm'
import { describeAvailability, type ToolContext } from '@/services/tools'
import { estimateUsage } from '@/lib/db'
import { fmtBytes } from '@/lib/fmt'
import { runtime } from '@/lib/http'
import { THEMES, applyTheme, currentThemeKey } from '@/lib/themes'
import { APP_VERSION, APP_VERSION_CODE, APP_BUILD_DATE } from '@/version'

/** 用户排查问题时最需要知道的两件事：装的是哪一版、跑在什么环境 */
const runtimeLabel = computed(() =>
  runtime() === 'capacitor' ? 'App（原生 HTTP）' : '浏览器（受 CORS 限制）',
)

const { providers, load, save, remove, check } = useProviders()
const knowledge = useKnowledge()
const memory = useMemory()
const {
  config: toolConfig,
  load: loadTools,
  save: saveTools,
  webSearchReady,
  enabledCount: toolCount,
} = useTools()

const editing = ref<ModelProvider | null>(null)
const isNew = ref(false)
const checking = ref(false)
const checkResult = ref<ProviderCheck | null>(null)
const modelList = ref<string[]>([])
const loadingModels = ref(false)
const saving = ref(false)
const storage = ref<{ usage: number; quota: number } | null>(null)
const showKey = ref(false)
const currentTheme = ref(currentThemeKey())

/**
 * 设置页分区折叠：默认全部收起（分区太多显得冗长），点标题展开。
 * 收起时标题行右侧显示摘要，展开后是正常内容。
 */
const openSections = ref<Record<string, boolean>>({})

function toggleSection(key: string) {
  openSections.value[key] = !openSections.value[key]
}

const currentThemeName = computed(
  () => THEMES.find((t) => t.key === currentTheme.value)?.label ?? '',
)

function setTheme(key: (typeof THEMES)[number]['key']) {
  currentTheme.value = key
  applyTheme(key)
}

/**
 * API Key 输入框**不走 v-model**，改为「DOM 持有显示值 + input 事件同步到 state」。
 *
 * 为什么：Android WebView 里出现过「填好 key 后点任意复选框，key 就没了」。
 * 复选框（如「支持识图」）会触发重渲染，而 v-model 在重渲染时会把
 * `editing.apiKey` 回写到 DOM —— **只要 state 里是空的，就会把用户刚敲的内容清掉**。
 * 不给输入框绑 value，Vue 就永远不会回写它，也就永远不会清空它。
 *
 * 打开弹层时用 syncKeyInput() 显式填一次；之后以 DOM 为准。
 */
const keyInput = ref<HTMLInputElement | null>(null)
/** 诊断用：实时显示 state 里到底有没有拿到值 */
const keyLen = ref(0)

function onKeyInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (editing.value) editing.value.apiKey = v
  keyLen.value = v.length
}

function syncKeyInput() {
  const v = editing.value?.apiKey ?? ''
  keyLen.value = v.length
  void nextTick(() => {
    if (keyInput.value) keyInput.value.value = v
  })
}

/** 搜索服务商的 Key：同样以 DOM 为准 */
const webKeyInput = ref<HTMLInputElement | null>(null)

function onWebKeyInput(e: Event) {
  toolConfig.value.webSearch.apiKey = (e.target as HTMLInputElement).value
}

/** provider 切换时把已存的 Key 填回输入框 */
watch(
  () => toolConfig.value.webSearch.provider,
  () => {
    const v = toolConfig.value.webSearch.apiKey || ''
    void nextTick(() => {
      if (webKeyInput.value) webKeyInput.value.value = v
    })
  },
)

/** 从剪贴板读 —— 绕开输入法与键盘，也是最实用的兜底手段 */
async function pasteKey() {
  try {
    const t = (await navigator.clipboard.readText()).trim()
    if (!t) {
      checkResult.value = { ok: false, message: '剪贴板是空的' }
      return
    }
    if (editing.value) editing.value.apiKey = t
    keyLen.value = t.length
    if (keyInput.value) keyInput.value.value = t
    checkResult.value = { ok: true, message: `已粘贴 ${t.length} 个字符` }
  } catch {
    checkResult.value = {
      ok: false,
      message: '读不到剪贴板（系统限制了剪贴板权限）。长按输入框选「粘贴」即可。',
    }
  }
}

const enabledKb = computed(() => knowledge.kbs.value.filter((k) => k.enabled))

onMounted(async () => {
  await Promise.all([load(), knowledge.load(), memory.load(), loadTools()])
  storage.value = await estimateUsage()
})

// 工具配置直接双向绑定，改动即持久化（配置项很多，逐项写保存按钮太啰嗦）
let saveTimer: number | undefined
watch(
  toolConfig,
  () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void saveTools(), 300)
  },
  { deep: true },
)

const toolCtx = computed<ToolContext>(() => ({
  kbs: knowledge.enabledKbs.value,
  config: toolConfig.value,
}))

const availability = computed(() => describeAvailability(toolCtx.value))

const SEARCH_PROVIDERS: { value: string; label: string; hint: string }[] = [
  {
    value: 'builtin',
    label: '内置（免密钥，推荐）',
    hint:
      '直连东方财富财经新闻搜索与必应中国，**不需要任何 Key**。' +
      '中文财经、政策、公告类查询够用；查不到时会自动换下一个源。',
  },
  {
    value: 'none',
    label: '不使用搜索',
    hint: '关掉搜索后，读网页和查公告仍然可用（它们不需要搜索 API）。',
  },
  {
    value: 'tavily',
    label: 'Tavily（需 Key）',
    hint: '为 LLM 设计的搜索 API，免费额度可用。key 形如 tvly-xxx。比内置源更全。',
  },
  {
    value: 'brave',
    label: 'Brave Search（需 Key）',
    hint: '需在 Brave 开发者后台申请，key 形如 BSAxxx',
  },
  {
    value: 'serper',
    label: 'Serper / Google（需 Key）',
    hint: 'serper.dev 申请，按次计费。结果质量最好，适合重度使用。',
  },
  {
    value: 'custom',
    label: '自建代理',
    hint: '你自己的服务，收 {query,max_results}，返回 {results:[{title,url,snippet}]}',
  },
]

function openNew() {
  editing.value = emptyProvider()
  isNew.value = true
  checkResult.value = null
  modelList.value = []
  showKey.value = false
  syncKeyInput()
}

function openEdit(p: ModelProvider) {
  // 复制一份再编辑，取消时不影响原对象
  editing.value = { ...p }
  isNew.value = false
  checkResult.value = null
  modelList.value = []
  showKey.value = false
  syncKeyInput()
}

function applyPreset(label: string) {
  const p = PRESETS.find((x) => x.label === label)
  if (!p || !editing.value) return
  editing.value.baseUrl = p.baseUrl
  editing.value.model = p.model
  editing.value.supportsVision = p.vision
  if (!editing.value.name) editing.value.name = label
}

/**
 * 取当前 API Key，**以 DOM 为准**。
 *
 * 为什么不能只信 `editing.apiKey`：
 * Android WebView 上「粘贴」有时不派发 input 事件，state 就一直是空的，
 * 于是保存下去的是个空 Key，用户却以为填过了。
 * 这里在每次使用前把 DOM 的值同步回来，无论 input 有没有触发都不会错。
 */
function currentKey(): string {
  const dom = keyInput.value?.value
  if (typeof dom === 'string' && editing.value && dom !== editing.value.apiKey) {
    editing.value.apiKey = dom
    keyLen.value = dom.length
  }
  return editing.value?.apiKey ?? ''
}

async function onCheck() {
  if (!editing.value) return
  currentKey()
  if (!editing.value.apiKey.trim()) {
    checkResult.value = { ok: false, message: '先填 API Key，再测试连接。' }
    return
  }
  checking.value = true
  checkResult.value = null
  try {
    checkResult.value = await check(editing.value)
  } finally {
    checking.value = false
  }
}

async function onLoadModels() {
  if (!editing.value) return
  if (!currentKey().trim()) {
    checkResult.value = { ok: false, message: '先填 API Key，再拉取模型列表。' }
    return
  }
  loadingModels.value = true
  checkResult.value = null
  try {
    modelList.value = await listModels(editing.value)
    if (modelList.value.length) {
      checkResult.value = { ok: true, message: `拉取到 ${modelList.value.length} 个模型，点一下即可选用` }
      // 当前模型名不在列表里就自动选第一个，省得用户手填错
      if (!modelList.value.includes(editing.value.model)) {
        editing.value.model = modelList.value[0]
      }
    } else {
      checkResult.value = { ok: false, message: '该服务没有返回模型列表，直接手填模型名即可' }
    }
  } catch (e) {
    checkResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    loadingModels.value = false
  }
}

async function onSave() {
  if (!editing.value) return
  const p = editing.value
  // 以 DOM 为准取 Key
  const key = currentKey().trim()

  // 每一条校验都必须给**看得见**的提示。
  // 之前 `if (!p.baseUrl.trim()) return` 是静默返回，
  // 用户点了保存什么都没发生，完全没法排查。
  if (!key) {
    checkResult.value = {
      ok: false,
      message: `API Key 是空的（读到的长度 ${key.length}）。请重新粘贴或输入。`,
    }
    return
  }
  if (!p.baseUrl.trim()) {
    checkResult.value = { ok: false, message: 'Base URL 不能为空，例如 https://api.deepseek.com/v1' }
    return
  }
  if (!p.model.trim()) {
    checkResult.value = { ok: false, message: '模型名不能为空，例如 deepseek-chat' }
    return
  }
  if (!p.name.trim()) p.name = p.model || '未命名模型'

  saving.value = true
  checkResult.value = null
  try {
    await save(p)
    checkResult.value = { ok: true, message: `已保存「${p.name}」` }
    // 稍等一下再关，让用户看到保存成功的反馈
    window.setTimeout(() => {
      editing.value = null
      saving.value = false
    }, 400)
  } catch (e) {
    saving.value = false
    // 写入失败必须显式说出来，不能静默
    checkResult.value = {
      ok: false,
      message: `保存失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function onDelete(p: ModelProvider) {
  if (!confirm(`删除模型「${p.name}」？`)) return
  await remove(p.id)
}
</script>

<template>
  <div class="page">
    <!-- 版本放在最显眼的位置：用户必须能一眼确认自己装的是哪一版，
         否则遇到"更新了但行为没变"时根本没法排查。 -->
    <div class="card ver-card">
      <div class="card-row">
        <div>
          <div class="card-title">选股助手 <span class="badge info">v{{ APP_VERSION }}</span></div>
          <div class="card-meta">
            构建于 {{ APP_BUILD_DATE }}　·　versionCode {{ APP_VERSION_CODE }}
          </div>
        </div>
        <div style="text-align: right">
          <div class="muted small">{{ runtimeLabel }}</div>
        </div>
      </div>
    </div>

    <div class="sec" :class="{ open: openSections.theme }">
      <button class="sec-head" @click="toggleSection('theme')">
        <span>外观</span>
        <span class="sec-sum">{{ currentThemeName }}</span>
        <span class="sec-arrow">▸</span>
      </button>
      <div class="sec-body">
        <div class="sec-inner">
          <div class="card">
            <div class="theme-grid">
              <button
                v-for="t in THEMES"
                :key="t.key"
                class="theme-cell"
                :class="{ on: currentTheme === t.key }"
                @click="setTheme(t.key)"
              >
                <span class="theme-swatch" :style="{ background: t.swatch }" />
                <span class="theme-name">{{ t.label }}</span>
              </button>
            </div>
            <div class="hint" style="margin-top: 10px">
              切换即时生效，并记住你的选择。颜色只影响外观，不影响数据。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sec" :class="{ open: openSections.model }">
      <button class="sec-head" @click="toggleSection('model')">
        <span>模型</span>
        <span class="sec-sum">{{ providers.length ? `${providers.length} 个模型` : '未配置' }}</span>
        <span class="sec-arrow">▸</span>
      </button>
      <div class="sec-body">
        <div class="sec-inner">
          <div v-if="!providers.length" class="alert info">
            还没有配置模型。这个 App <b>不内置模型</b>——你填自己的 API Key 和
            Base URL，请求直接从本机发往你选的服务，我们不中转、不保存。
          </div>

          <div v-for="p in providers" :key="p.id" class="card">
            <div class="card-row">
              <div style="flex: 1; min-width: 0">
                <div class="card-title">
                  {{ p.name }}
                  <span v-if="p.isDefault" class="badge info">默认</span>
                  <span v-if="p.supportsVision" class="badge">识图</span>
                </div>
                <div class="card-meta mono" style="overflow: hidden; text-overflow: ellipsis">
                  {{ p.model }} · {{ p.baseUrl }}
                </div>
                <div v-if="p.lastCheckedAt" class="card-meta">
                  <span :style="{ color: p.lastCheckOk ? 'var(--down)' : 'var(--danger)' }">
                    {{ p.lastCheckOk ? '✓ 连接正常' : '✕ 连接失败' }}
                  </span>
                  <span class="muted"> · {{ p.lastCheckMessage?.slice(0, 60) }}</span>
                </div>
              </div>
            </div>
            <div class="btn-row" style="margin-top: 8px">
              <button class="btn sm" @click="openEdit(p)">编辑</button>
              <button class="btn sm danger" @click="onDelete(p)">删除</button>
            </div>
          </div>

          <button class="btn primary" style="width: 100%; margin-top: 6px" @click="openNew">
            + 添加模型
          </button>
        </div>
      </div>
    </div>

    <div class="sec" :class="{ open: openSections.tools }">
      <button class="sec-head" @click="toggleSection('tools')">
        <span>工具（AI 可自行调用）</span>
        <span class="sec-sum">已启用 {{ toolCount }} 类</span>
        <span class="sec-arrow">▸</span>
      </button>
      <div class="sec-body">
        <div class="sec-inner">
          <div class="alert info">
            开启后，AI 会在需要时<b>自己决定</b>调用哪些工具，而不是凭训练数据回答。
            每次调用了什么、查到了几条，都会显示在对话里——这是你判断答案可信度的依据。<br />
            模型编造时的典型特征就是：一个工具都没调。
          </div>

          <div class="card">
            <label class="check">
              <input v-model="toolConfig.kb.enabled" type="checkbox" />
              <span>
                <b>知识库检索</b>
                <div class="hint">
                  检索已载入知识库里的历史观点，并带上每条观点事后的真实收益。
                  完全本地，总是可用。
                </div>
              </span>
            </label>
          </div>

          <div class="card">
            <label class="check">
              <input v-model="toolConfig.market.enabled" type="checkbox" />
              <span>
                <b>行情与基金持仓</b>
                <div class="hint">
                  查实时股价、涨跌幅、成交额；查基金前十大重仓股。
                  数据源为腾讯财经与天天基金，无需 key。
                </div>
              </span>
            </label>
            <div v-if="toolConfig.market.enabled" class="field" style="margin: 10px 0 0">
              <label>数据源</label>
              <select v-model="toolConfig.market.source">
                <option value="tencent">腾讯财经</option>
                <option value="eastmoney">东方财富</option>
              </select>
            </div>
          </div>

          <div class="card">
            <label class="check">
              <input v-model="toolConfig.webSearch.enabled" type="checkbox" />
              <span>
                <b>联网搜索与读取网页</b>
                <div class="hint">
                  查最新新闻、政策、公告。需要你自己的搜索 API key——
                  App 不内置搜索服务，也不代管 key。
                </div>
              </span>
            </label>

            <template v-if="toolConfig.webSearch.enabled">
              <div class="field" style="margin-top: 10px">
                <label>搜索服务商</label>
                <select v-model="toolConfig.webSearch.provider">
                  <option v-for="p in SEARCH_PROVIDERS" :key="p.value" :value="p.value">
                    {{ p.label }}
                  </option>
                </select>
                <div class="hint">
                  {{ SEARCH_PROVIDERS.find((x) => x.value === toolConfig.webSearch.provider)?.hint }}
                </div>
              </div>

              <div v-if="toolConfig.webSearch.provider === 'custom'" class="field">
                <label>自建代理地址</label>
                <input v-model="toolConfig.webSearch.baseUrl" type="url" placeholder="https://your-proxy/search" />
              </div>

              <!-- 只有付费 provider 才需要 Key；builtin 免密。
                   与模型 Key 同理：不绑 value，避免重渲染时被回写成空。 -->
              <div
                v-if="['tavily', 'brave', 'serper', 'custom'].includes(toolConfig.webSearch.provider)"
                class="field"
              >
                <label>API Key</label>
                <input
                  ref="webKeyInput"
                  type="text"
                  class="key-masked"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck="false"
                  @input="onWebKeyInput"
                />
              </div>

              <div class="field">
                <label>默认返回条数</label>
                <input v-model.number="toolConfig.webSearch.maxResults" type="number" min="1" max="20" />
              </div>

              <div v-if="toolConfig.webSearch.provider === 'builtin'" class="alert info">
                内置源**不需要配置**，现在就能用。它依次尝试：
                东方财富财经新闻搜索 → 必应中国。<br />
                两者都失败时会如实报错，不会编造结果。<br />
                若你重度使用、想要更全的结果，可在上面换成 Tavily / Serper。
              </div>

              <div v-if="!webSearchReady" class="alert warn">
                搜索未就绪：{{ toolConfig.webSearch.provider === 'none' ? '已选择不使用搜索' : '还没填 Key' }}
                <div class="hint" style="margin-top: 4px">
                  注意：读网页（fetch_page）和查公告（stock_announcements）**不依赖搜索服务商**，
                  它们仍然可用。
                </div>
              </div>
            </template>
          </div>

          <div class="card">
            <div class="field" style="margin: 0">
              <label>单次回答最多调用几轮工具</label>
              <input v-model.number="toolConfig.maxRounds" type="number" min="1" max="12" />
              <div class="hint">
                防止模型反复调用工具烧 token。默认 6 轮；达到上限会被强制收尾并提示。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sec" :class="{ open: openSections.toolStatus }">
      <button class="sec-head" @click="toggleSection('toolStatus')">
        <span>工具当前状态</span>
        <span class="sec-sum">{{ availability.every((t) => t.ok) ? '全部可用' : '有异常' }}</span>
        <span class="sec-arrow">▸</span>
      </button>
      <div class="sec-body">
        <div class="sec-inner">
          <div class="card">
            <div v-for="t in availability" :key="t.name" class="spread" style="padding: 3px 0">
              <span class="small">
                <span :style="{ color: t.ok ? 'var(--down)' : 'var(--fg-mute)' }">
                  {{ t.ok ? '●' : '○' }}
                </span>
                {{ t.title }}
              </span>
              <span class="small muted" style="text-align: right; max-width: 60%">
                {{ t.ok ? '可用' : t.reason }}
              </span>
            </div>
            <div class="card-meta" style="margin-top: 8px">
              已启用 {{ toolCount }} 类工具
              <template v-if="knowledge.enabledKbs.value.length === 0">
                · 知识库为空，AI 只能靠常识回答
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sec" :class="{ open: openSections.data }">
      <button class="sec-head" @click="toggleSection('data')">
        <span>本机数据</span>
        <span class="sec-sum">占用 {{ fmtBytes(storage?.usage) }}</span>
        <span class="sec-arrow">▸</span>
      </button>
      <div class="sec-body">
        <div class="sec-inner">
          <div class="card">
            <div class="grid3">
              <div class="stat">
                <div class="k">知识库</div>
                <div class="v">{{ knowledge.kbs.value.length }}</div>
              </div>
              <div class="stat">
                <div class="k">观点</div>
                <div class="v">{{ knowledge.totalOpinions.value }}</div>
              </div>
              <div class="stat">
                <div class="k">占用</div>
                <div class="v">{{ fmtBytes(storage?.usage) }}</div>
              </div>
            </div>
            <div class="card-meta" style="margin-top: 8px">
              已启用 {{ enabledKb.length }} 个知识库；持仓
              {{ memory.confirmedHoldings.value.length }} 只
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="alert warn" style="margin-top: 10px">
      <b>密钥安全</b>：API Key 保存在本机 IndexedDB 中，未加密。
      这是纯前端应用的固有限制——请勿在公用设备上使用，
      也建议为这个用途单独申请一个限额 Key。
    </div>

    <!-- 编辑弹层 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal">
        <h2>{{ isNew ? '添加模型' : '编辑模型' }}</h2>

        <div class="field">
          <label>快速预设</label>
          <div class="chips">
            <span
              v-for="ps in PRESETS"
              :key="ps.label"
              class="chip pick"
              @click="applyPreset(ps.label)"
            >
              {{ ps.label }}
            </span>
          </div>
          <div class="hint">
            预设只填 Base URL 与模型名，Key 需要你自己填。
          </div>
        </div>

        <div class="field">
          <label>显示名称</label>
          <input v-model="editing.name" type="text" placeholder="如：我的 DeepSeek" />
        </div>

        <div class="field">
          <label>Base URL</label>
          <input v-model="editing.baseUrl" type="url" placeholder="https://api.deepseek.com/v1" />
          <div class="hint">
            填到 <code>/v1</code> 为止即可，不用带 <code>/chat/completions</code>。
          </div>
        </div>

        <div class="field">
          <label>API Key</label>
          <!--
            刻意**不绑 value / 不用 v-model**（见 script 里 syncKeyInput 的注释）：
            Android WebView 上，绑了 value 就会在「点复选框触发重渲染」时被回写成空。
            这里以 DOM 为准，input 事件同步到 state。
          -->
          <input
            ref="keyInput"
            type="text"
            :class="{ 'key-masked': !showKey }"
            placeholder="sk-..."
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            @input="onKeyInput"
          />
          <div class="btn-row" style="margin-top: 6px; align-items: center">
            <label class="check" style="flex: 1">
              <input v-model="showKey" type="checkbox" />
              <span>显示密钥</span>
            </label>
            <button class="btn sm" type="button" @click="pasteKey">从剪贴板粘贴</button>
          </div>
          <!-- 诊断：让你一眼看出 state 里到底有没有拿到值 -->
          <div class="hint" :style="{ color: keyLen ? 'var(--accent)' : 'var(--fg-mute)' }">
            {{ keyLen ? `已记录 ${keyLen} 个字符` : '尚未输入（或未成功读取）' }}
            <span v-if="keyLen && keyLen < 20"> —— 这个长度看着不像正常的 Key</span>
          </div>
        </div>

        <div class="field">
          <label>模型名</label>
          <input v-model="editing.model" type="text" placeholder="deepseek-chat" />
          <div class="btn-row" style="margin-top: 6px">
            <button class="btn sm" :disabled="loadingModels" @click="onLoadModels">
              <span v-if="loadingModels" class="spin" />
              拉取模型列表
            </button>
          </div>
          <div v-if="modelList.length" class="chips" style="margin-top: 8px">
            <span
              v-for="m in modelList.slice(0, 40)"
              :key="m"
              class="chip pick"
              :class="{ on: editing.model === m }"
              @click="editing.model = m"
            >
              {{ m }}
            </span>
          </div>
        </div>

        <div class="field">
          <label class="check">
            <input v-model="editing.supportsVision" type="checkbox" />
            <span>
              支持识图
              <div class="hint">
                截图导入持仓需要它。不确定就别勾——勾错了会在导入时报错，
                不会静默失败。
              </div>
            </span>
          </label>
        </div>

        <div class="field">
          <label class="check">
            <input v-model="editing.supportsJson" type="checkbox" />
            <span>
              支持 JSON 输出
              <div class="hint">结构化抽取需要。绝大多数 OpenAI 兼容服务都支持。</div>
            </span>
          </label>
        </div>

        <div class="grid2">
          <div class="field">
            <label>温度</label>
            <input v-model.number="editing.temperature" type="number" step="0.1" min="0" max="2" />
          </div>
          <div class="field">
            <label>最大输出 tokens</label>
            <input v-model.number="editing.maxTokens" type="number" min="0" step="256" />
            <div class="hint">填 0 = 不设限（由模型服务端决定）；默认 16384，工具多了、回答长了也不容易被提前截断。若你的模型输出上限低于此值（如 DeepSeek 上限 8192），在设置页调小或填 0。</div>
          </div>
        </div>

        <div class="field">
          <label class="check">
            <input v-model="editing.isDefault" type="checkbox" />
            <span>设为默认模型</span>
          </label>
        </div>

        <div v-if="checkResult" class="alert" :class="checkResult.ok ? 'ok' : 'err'">
          {{ checkResult.ok ? '✓ ' : '✕ ' }}{{ checkResult.message }}
          <span v-if="checkResult.latencyMs" class="muted"> （{{ checkResult.latencyMs }}ms）</span>
        </div>

        <div class="btn-row">
          <button class="btn" :disabled="checking" @click="onCheck">
            <span v-if="checking" class="spin" />
            测试连接
          </button>
          <div style="flex: 1" />
          <button class="btn" @click="editing = null">取消</button>
          <button class="btn primary" :disabled="saving" @click="onSave">
            <span v-if="saving" class="spin" />
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
