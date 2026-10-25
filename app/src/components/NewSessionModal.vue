<script setup lang="ts">
/**
 * 新建会话弹窗（共用组件）。
 *
 * 从「会话列表页」和「会话详情页」都能打开：
 * 新建时就定三件事 —— 模式（产品最核心的选择，决定 AI 的立场）、
 * 请哪个军师、是否共享全局记忆。事后改会让人困惑
 * 「刚才那条答案到底是按哪个口径给的」。
 */
import { computed, ref, watch } from 'vue'
import type { AdvisorMode, Session } from '@/types'
import { useSessions } from '@/stores/sessions'
import { useKnowledge } from '@/stores/knowledge'
import TabIcon from '@/components/TabIcon.vue'
import type { IconName } from '@/components/TabIcon.vue'
import { availablePersonas, personaSummary } from '@/services/persona'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [s: Session] }>()

const sessions = useSessions()
const knowledge = useKnowledge()

/** 三种模式 —— 立场完全不同，这是产品的分水岭 */
const MODES: { id: AdvisorMode; icon: IconName; name: string; desc: string }[] = [
  {
    id: 'audit',
    icon: 'search',
    name: '检验我的操作',
    desc: '贴出你买了/卖了什么，他坐在对面审你的单子，指出对在哪、错在哪',
  },
  {
    id: 'persona',
    icon: 'person',
    name: '请教军师',
    desc: '拿一个他从没见过的新情况问他，他用框架推演（不荐股、不预测收益）',
  },
  {
    id: 'research',
    icon: 'kb',
    name: '研究历史观点',
    desc: '查他过去怎么看某个标的，附事后的真实超额收益与命中与否',
  },
]

const draft = ref({
  mode: 'audit' as AdvisorMode,
  useGlobalMemory: true,
  kbIds: [] as string[],
  personaUid: null as string | null,
  focus: '',
  auditContext: '',
})

/** 打开时重置草稿（每次打开都是干净的一份） */
watch(
  () => props.open,
  (v) => {
    if (!v) return
    const personas = availablePersonas(knowledge.enabledKbs.value)
    draft.value = {
      // 有军师时默认「检验」—— 这是最诚实、也最不容易被误用的用法
      mode: personas.length ? 'audit' : 'research',
      useGlobalMemory: true,
      // 默认全选已启用知识库：多数人只有一两个军师
      kbIds: knowledge.enabledKbs.value.map((k) => k.id),
      personaUid: personas[0]?.author.author_uid ?? null,
      focus: '',
      auditContext: '',
    }
  },
)

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

function modeText(id: AdvisorMode): (typeof MODES)[number] {
  return MODES.find((m) => m.id === id) ?? MODES[2]
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
  emit('close')
  emit('created', s)
}

function toggleKb(id: string) {
  const a = draft.value.kbIds
  const i = a.indexOf(id)
  if (i >= 0) a.splice(i, 1)
  else a.push(id)
}
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
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
              <span class="mode-icon"><TabIcon :name="m.icon" :size="15" /></span>
              <b>{{ m.name }}</b>
              <span v-if="m.id === 'audit'" class="chip on" style="margin-left: auto">推荐</span>
            </div>
            <div class="hint">{{ m.desc }}</div>
          </div>
        </div>
        <div v-if="needsPersona && !personas.length" class="alert warn" style="margin-top: 8px">
          「{{ modeText(draft.mode).name }}」需要知识库里带**决策框架**。
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
            <TabIcon name="person" :size="13" />
            {{ p.author.name }}
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
            <TabIcon name="kb" :size="13" />
            {{ k.author?.name || k.manifest.title }}
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
        <button class="btn" @click="emit('close')">取消</button>
        <div style="flex: 1" />
        <button class="btn primary" @click="createSession">开始</button>
      </div>
    </div>
  </div>
</template>
