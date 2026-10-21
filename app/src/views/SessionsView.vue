<script setup lang="ts">
/**
 * 会话列表。
 *
 * 新建会话时就让用户决定三件事，而不是等进到聊天里再设：
 *   1. **模式** —— 这是产品最核心的选择，决定 AI 的立场
 *   2. 请哪个军师
 *   3. 是否共享全局记忆
 * 事后改会让人困惑「刚才那条答案到底是按哪个口径给的」。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { AdvisorMode, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import { useProviders } from '@/stores/providers'
import { availablePersonas, personaSummary } from '@/services/persona'
import { relTime } from '@/lib/fmt'

const router = useRouter()
const sessions = useSessions()
const knowledge = useKnowledge()
const { providers, load: loadProviders } = useProviders()

/** 三种模式 —— 立场完全不同，这是产品的分水岭 */
const MODES: { id: AdvisorMode; icon: string; name: string; desc: string }[] = [
  {
    id: 'audit',
    icon: '🔍',
    name: '检验我的操作',
    desc: '贴出你买了/卖了什么，他坐在对面审你的单子，指出对在哪、错在哪',
  },
  {
    id: 'persona',
    icon: '🧠',
    name: '请教军师',
    desc: '拿一个他从没见过的新情况问他，他用框架推演（不荐股、不预测收益）',
  },
  {
    id: 'research',
    icon: '📚',
    name: '研究历史观点',
    desc: '查他过去怎么看某个标的，附事后的真实超额收益与命中与否',
  },
]

const showNew = ref(false)
const draft = ref({
  mode: 'audit' as AdvisorMode,
  useGlobalMemory: true,
  kbIds: [] as string[],
  personaUid: null as string | null,
  focus: '',
  auditContext: '',
})

onMounted(async () => {
  await Promise.all([sessions.load(), loadProviders()])
})

const noProvider = computed(() => providers.value.length === 0)

/** 可用的军师（带决策框架的那些） */
const personas = computed(() => availablePersonas(knowledge.enabledKbs.value))

/** 当前模式需要决策框架 */
const needsPersona = computed(() => draft.value.mode !== 'research')

/** 选中的军师：没指定就用第一个 */
const pickedPersona = computed(
  () =>
    personas.value.find((p) => p.author.author_uid === draft.value.personaUid) ??
    personas.value[0] ??
    null,
)

function openNew() {
  draft.value = {
    // 有军师时默认「检验」—— 这是最诚实、也最不容易被误用的用法
    mode: personas.value.length ? 'audit' : 'research',
    useGlobalMemory: true,
    // 默认全选已启用知识库：多数人只有一两个军师
    kbIds: knowledge.enabledKbs.value.map((k) => k.id),
    personaUid: personas.value[0]?.author.author_uid ?? null,
    focus: '',
    auditContext: '',
  }
  showNew.value = true
}

function pickMode(m: AdvisorMode) {
  draft.value.mode = m
  if (m === 'research') return
  // 切到需要框架的模式时，若还没选军师就自动选第一个
  if (!draft.value.personaUid && personas.value.length) {
    draft.value.personaUid = personas.value[0].author.author_uid
    // 确保对应知识库被选中，否则 prompt 找不到 persona
    const kbId = personas.value[0].kb.id
    if (!draft.value.kbIds.includes(kbId)) draft.value.kbIds.push(kbId)
  }
}

async function createSession() {
  const s = await sessions.create({
    mode: draft.value.mode,
    personaAuthorUid: needsPersona.value ? pickedPersona.value?.author.author_uid ?? null : null,
    useGlobalMemory: draft.value.useGlobalMemory,
    activeKbIds: [...draft.value.kbIds],
    auditContext: draft.value.mode === 'audit' ? draft.value.auditContext.trim() : undefined,
    focusSubject: draft.value.focus.trim() ? { name: draft.value.focus.trim() } : null,
  })
  showNew.value = false
  router.push(`/s/${s.id}`)
}

function toggleKb(id: string) {
  const a = draft.value.kbIds
  const i = a.indexOf(id)
  if (i >= 0) a.splice(i, 1)
  else a.push(id)
}

function modeOf(s: Session): AdvisorMode {
  return s.mode ?? 'research'
}

function modeMeta(id: AdvisorMode) {
  return MODES.find((m) => m.id === id) ?? MODES[2]
}

function modeText(id: AdvisorMode): string {
  return modeMeta(id).name
}

function preview(s: Session): string {
  const last = [...s.messages].reverse().find((m) => m.content)
  if (!last) return '还没有对话'
  return last.content.replace(/\s+/g, ' ').slice(0, 60)
}

async function onDelete(s: Session, e: Event) {
  e.stopPropagation()
  if (!confirm(`删除会话「${s.title}」？`)) return
  await sessions.remove(s.id)
}

function kbNames(s: Session): string[] {
  return knowledge
    .resolve(s.activeKbIds)
    .map((k) => k.author?.name || k.manifest.title)
}
</script>

<template>
  <div class="page">
    <div class="section-title">会话</div>

    <div v-if="noProvider" class="alert warn">
      还没有配置模型。先去
      <router-link to="/settings">设置</router-link>
      添加一个（填你自己的 API Key），否则无法对话。
    </div>

    <div v-if="!sessions.sessions.value.length" class="empty">
      <div class="big">💬</div>
      还没有会话<br />
      新建一个，问它某只票或某个板块
    </div>

    <div
      v-for="s in sessions.sessions.value"
      :key="s.id"
      class="card tap"
      @click="router.push(`/s/${s.id}`)"
    >
      <div class="spread">
        <div style="flex: 1; min-width: 0">
          <div class="card-title">{{ s.title }}</div>
          <div class="card-meta">{{ preview(s) }}</div>
          <div class="chips" style="margin-top: 6px">
            <span class="chip" :class="{ on: modeOf(s) !== 'research' }">
              {{ modeMeta(modeOf(s)).icon }} {{ modeMeta(modeOf(s)).name }}
            </span>
            <span v-if="s.focusSubject?.name" class="chip">
              聚焦 {{ s.focusSubject.name }}
            </span>
            <span class="chip" :class="{ on: s.useGlobalMemory }">
              {{ s.useGlobalMemory ? '共享记忆' : '隔离记忆' }}
            </span>
            <span v-for="n in kbNames(s)" :key="n" class="chip">📚 {{ n }}</span>
            <span v-if="!kbNames(s).length" class="chip">无军师</span>
          </div>
        </div>
        <div style="text-align: right; flex: none">
          <div class="muted small">{{ relTime(s.updatedAt) }}</div>
          <button class="btn sm ghost danger" style="margin-top: 6px" @click="onDelete(s, $event)">
            删除
          </button>
        </div>
      </div>
    </div>

    <button class="fab" @click="openNew">＋</button>

    <!-- 新建会话 -->
    <div v-if="showNew" class="modal-mask" @click.self="showNew = false">
      <div class="modal">
        <h2>新建会话</h2>

        <div class="field">
          <label>要它做什么（决定 AI 的立场）</label>
          <div class="mode-list">
            <div
              v-for="m in MODES"
              :key="m.id"
              class="mode-item"
              :class="{ on: draft.mode === m.id }"
              @click="pickMode(m.id)"
            >
              <div class="mode-head">
                <span class="mode-icon">{{ m.icon }}</span>
                <b>{{ m.name }}</b>
                <span v-if="m.id === 'audit'" class="chip on" style="margin-left: auto">推荐</span>
              </div>
              <div class="hint">{{ m.desc }}</div>
            </div>
          </div>
          <div v-if="needsPersona && !personas.length" class="alert warn" style="margin-top: 8px">
            「{{ modeText(draft.mode) }}」需要知识库里带**决策框架**。
            当前载入的知识库没有（或还没生成），会自动退回研究模式。<br />
            生成方法：<code>python run.py profile-author --author &lt;名字&gt;</code>
          </div>
        </div>

        <div v-if="needsPersona && personas.length" class="field">
          <label>让谁当这个军师</label>
          <div class="chips">
            <span
              v-for="p in personas"
              :key="p.author.author_uid"
              class="chip pick"
              :class="{ on: pickedPersona?.author.author_uid === p.author.author_uid }"
              @click="draft.personaUid = p.author.author_uid"
            >
              🎓 {{ p.author.name }}
              <span class="muted">({{ personaSummary(p.author.persona) }})</span>
            </span>
          </div>
        </div>

        <div v-if="draft.mode === 'audit'" class="field">
          <label>你的背景（可选，会一直带上）</label>
          <textarea
            v-model="draft.auditContext"
            rows="3"
            placeholder="如：持仓里有锂矿和稀有金属，还有一只主动基金 290008；成本价大概在…"
          />
          <div class="hint">
            写在这里的信息每轮都会带上。具体某次操作直接在对话里贴就行。
          </div>
        </div>

        <div class="field">
          <label class="check">
            <input v-model="draft.useGlobalMemory" type="checkbox" />
            <span>
              共享全局记忆
              <div class="hint">
                开启：AI 知道你的持仓与偏好，回答会针对你的仓位。<br />
                关闭：AI 看不到任何个人信息，只做纯粹的标的分析——<br />
                适合「我没持有，只想看看这个票怎么样」的场景。
              </div>
            </span>
          </label>
        </div>

        <div class="field">
          <label>请哪个军师</label>
          <div v-if="!knowledge.kbs.value.length" class="hint">
            还没有载入知识库。可以先去
            <router-link to="/kb">知识库</router-link> 页载入一个。
          </div>
          <div v-else class="chips">
            <span
              v-for="k in knowledge.kbs.value"
              :key="k.id"
              class="chip pick"
              :class="{ on: draft.kbIds.includes(k.id) }"
              @click="toggleKb(k.id)"
            >
              📚 {{ k.author?.name || k.manifest.title }}
              <span class="muted">({{ k.opinions.length }})</span>
            </span>
          </div>
        </div>

        <div class="field">
          <label>聚焦标的（可选）</label>
          <input v-model="draft.focus" type="text" placeholder="如：半导体 / 贵州茅台" />
          <div class="hint">填了会让 AI 优先检索这个标的相关的历史观点。</div>
        </div>

        <div class="btn-row">
          <button class="btn" @click="showNew = false">取消</button>
          <div style="flex: 1" />
          <button class="btn primary" @click="createSession">开始</button>
        </div>
      </div>
    </div>
  </div>
</template>
