<script setup lang="ts">
/**
 * 知识库：载入个性化「军师」。
 *
 * 这个页面刻意把「抽取方式」和「命中率的置信区间」摆在显眼位置。
 * 用户有权利知道：这个知识库是规则抽的还是 LLM 抽的，
 * 它的命中率到底是不是统计显著——否则就会过度信任一个不靠谱的军师。
 */
import { computed, onMounted, ref } from 'vue'
import type { KnowledgeBase } from '@/types'
import { useKnowledge } from '@/stores/knowledge'
import TabIcon from '@/components/TabIcon.vue'
import { kbPerformance } from '@/services/prompt'
import { verdict } from '@/lib/stats'
import { describeKb } from '@/services/kb'
import { fmtBytes, fmtPct, fmtSignedPct } from '@/lib/fmt'

const { kbs, load, importFile, toggle, remove } = useKnowledge()

const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const detail = ref<KnowledgeBase | null>(null)
const horizon = ref(20)

onMounted(load)

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  busy.value = true
  message.value = null
  try {
    for (const f of files) {
      const { kb, warnings } = await importFile(f)
      const extra = warnings.length ? `\n${warnings.join('\n')}` : ''
      message.value = {
        kind: 'ok',
        text: `已载入「${kb.manifest.title}」：${kb.opinions.length} 条观点、${kb.instruments.length} 个标的${extra}`,
      }
    }
  } catch (err) {
    message.value = { kind: 'err', text: err instanceof Error ? err.message : String(err) }
  } finally {
    busy.value = false
  }
}

function perf(kb: KnowledgeBase) {
  return kbPerformance(kb, horizon.value)
}

/** 决策框架（可能没有 —— 老知识库或还没跑 profile-author） */
const fw = computed(() => detail.value?.author?.persona ?? null)

/** 用知识库自己声明的周期；没有就退回一套合理的默认（含长周期） */
function kbHorizons(kb: KnowledgeBase): number[] {
  const declared = (kb.manifest.horizons ?? []).filter((h) => h > 0)
  return declared.length ? [...declared].sort((a, b) => a - b) : [5, 20, 60, 250]
}

function perfLabel(kb: KnowledgeBase) {
  const s = perf(kb)
  if (!s.n) return '无回测数据'
  return `${fmtPct(s.hitRate)} · ${verdict(s)}`
}

async function onDelete(kb: KnowledgeBase) {
  if (!confirm(`删除知识库「${kb.manifest.title}」？\n本机数据会一并清除。`)) return
  await remove(kb.id)
  if (detail.value?.id === kb.id) detail.value = null
}

const enabledCount = computed(() => kbs.value.filter((k) => k.enabled).length)
</script>

<template>
  <div class="page">
    <div class="section-title">知识库</div>

    <div class="alert info">
      App 只提供<b>引擎</b>，不内置任何内容。知识库是外部文件（<code>.stkb</code>），
      可以随时更换、分享、自己产出。<br />
      这就是为什么这个 App 只有几百 KB——它装的是逻辑，不是内容。
    </div>

    <div v-if="message" class="alert" :class="message.kind === 'ok' ? 'ok' : 'err'">
      {{ message.text }}
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".stkb,.zip"
      multiple
      style="display: none"
      @change="onPick"
    />

    <button class="btn primary" style="width: 100%" :disabled="busy" @click="fileInput?.click()">
      <span v-if="busy" class="spin" />
      {{ busy ? '解析中…' : '+ 载入知识库 (.stkb)' }}
    </button>

    <div v-if="!kbs.length" class="empty">
      <div class="big"><TabIcon name="kb" :size="36" /></div>
      还没有知识库<br />
      载入一个后，AI 就会基于其中的历史观点来回答问题
    </div>

    <template v-else>
      <div class="section-title">
        已载入 {{ kbs.length }} 个 · 启用 {{ enabledCount }} 个
      </div>

      <div v-for="kb in kbs" :key="kb.id" class="card">
        <div class="card-row">
          <div style="flex: 1; min-width: 0">
            <div class="card-title">
              {{ kb.manifest.title }}
              <span v-if="kb.manifest.extractor?.mode === 'rule'" class="badge warn">规则抽取</span>
              <span v-else-if="kb.manifest.extractor?.mode === 'llm'" class="badge info">LLM 抽取</span>
            </div>
            <div class="card-meta">
              {{ kb.author?.name }} · {{ describeKb(kb).period || '时间未知' }} ·
              {{ kb.opinions.length }} 条观点 ·
              {{ fmtBytes(kb.sizeBytes) }}
            </div>
            <div class="card-meta">
              T+{{ horizon }} 表现：<b>{{ perfLabel(kb) }}</b>
            </div>
          </div>
          <div class="switch" :class="{ on: kb.enabled }" @click="toggle(kb, !kb.enabled)">
            <i />
          </div>
        </div>

        <div class="btn-row" style="margin-top: 8px">
          <button class="btn sm" @click="detail = kb">详情</button>
          <div style="flex: 1" />
          <button class="btn sm danger" @click="onDelete(kb)">删除</button>
        </div>
      </div>
    </template>

    <!-- 详情 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal">
        <h2>{{ detail.manifest.title }}</h2>

        <div class="grid2" style="margin-bottom: 12px">
          <div class="stat">
            <div class="k">观点数</div>
            <div class="v">{{ detail.opinions.length }}</div>
          </div>
          <div class="stat">
            <div class="k">标的数</div>
            <div class="v">{{ detail.instruments.length }}</div>
          </div>
          <div class="stat">
            <div class="k">文件体积</div>
            <div class="v">{{ fmtBytes(detail.sizeBytes) }}</div>
          </div>
          <div class="stat">
            <div class="k">格式版本</div>
            <div class="v">{{ detail.manifest.format_version }}</div>
          </div>
        </div>

        <div class="section-title">回测表现（各周期）</div>
        <div class="alert info" style="margin-bottom: 8px">
          <b>必须看长周期。</b>实测有的大V短周期与随机无异、
          一年期却显著强于随机（左侧+长期持有型）。只看短周期会误判。
        </div>
        <div v-for="h in kbHorizons(detail)" :key="h" class="card">
          <div class="spread">
            <b>T+{{ h }}</b>
            <span class="badge" :class="{
              up: verdict(kbPerformance(detail, h)) === '显著优于随机',
              warn: verdict(kbPerformance(detail, h)) === '与随机无异',
            }">{{ verdict(kbPerformance(detail, h)) }}</span>
          </div>
          <div class="card-meta">
            样本 {{ kbPerformance(detail, h).n }} ·
            命中率 {{ fmtPct(kbPerformance(detail, h).hitRate) }} ·
            Wilson 下界 {{ fmtPct(kbPerformance(detail, h).wilsonLow) }} ·
            p={{ (kbPerformance(detail, h).pValue ?? 1).toFixed(3) }} ·
            平均超额 {{ fmtSignedPct(kbPerformance(detail, h).avgExcess) }}
          </div>
        </div>

        <div class="section-title">作者画像</div>
        <div class="card">
          <div v-if="detail.author?.summary">
            <b>画像</b>
            <div class="card-body">{{ detail.author.summary }}</div>
          </div>
          <div v-else class="alert warn" style="margin: 6px 0">
            该知识库没有生成作者画像（summary / methodology），
            AI 只能看到原始观点，无法解释「他为什么这么说」。
          </div>
          <div v-if="detail.author?.methodology">
            <b>方法论</b>
            <div class="card-body" style="white-space: pre-wrap">{{ detail.author.methodology }}</div>
          </div>
          <div v-if="detail.author?.known_biases?.length" style="margin-top: 8px">
            <b>已知偏好与偏见</b>
            <ul class="card-body" style="padding-left: 18px; margin: 4px 0">
              <li v-for="(b, i) in detail.author.known_biases" :key="i">{{ b }}</li>
            </ul>
          </div>
          <div v-if="detail.author?.style_tags?.length" class="chips" style="margin-top: 8px">
            <span v-for="t in detail.author.style_tags" :key="t" class="chip">{{ t }}</span>
          </div>
        </div>

        <!-- 决策框架：这才是「军师」和「史料库」的分水岭 -->
        <div class="section-title">决策框架（数字化的他）</div>
        <div v-if="!fw" class="card">
          <div class="alert warn" style="margin: 0">
            这个知识库**没有决策框架（persona）**，只能做历史观点检索，
            无法用他的逻辑推演新情况。<br /><br />
            生成方法：
            <div class="mono small" style="margin-top: 4px">
              python run.py profile-author --author {{ detail.author?.name || '&lt;名字&gt;' }}
            </div>
          </div>
        </div>
        <template v-else>
          <div v-if="fw.identity" class="card">
            <div class="card-body">{{ fw.identity }}</div>
          </div>

          <div v-if="fw.frameworks?.length" class="card">
            <b>核心方法论</b>
            <div class="hint" style="margin-bottom: 8px">
              有名字的方法才会被反复调用。具体结论会过期，框架不会。
            </div>
            <div v-for="(f, i) in fw.frameworks" :key="i" class="fw-item">
              <div class="fw-name">◆ {{ f.name }}</div>
              <div class="card-body">{{ f.content }}</div>
              <div v-if="f.how_to_apply" class="hint" style="margin-top: 3px">
                怎么用：{{ f.how_to_apply }}
              </div>
              <div v-if="f.durability" class="hint" style="margin-top: 2px; opacity: 0.75">
                为什么不过期：{{ f.durability }}
              </div>
            </div>
          </div>

          <div v-if="fw.vetoes?.length" class="card">
            <b>否决条件</b>
            <div class="hint" style="margin-bottom: 4px">这些情况他会直接说不</div>
            <ul class="card-body" style="padding-left: 18px; margin: 4px 0">
              <li v-for="(v, i) in fw.vetoes" :key="i">{{ v }}</li>
            </ul>
          </div>

          <div v-if="fw.checklist?.length" class="card">
            <b>面对一个新标的，他会依次问自己</b>
            <ol class="card-body" style="padding-left: 20px; margin: 4px 0">
              <li v-for="(c, i) in fw.checklist" :key="i">{{ c }}</li>
            </ol>
          </div>

          <div v-if="fw.decision_rules?.length" class="card">
            <b>决策规则（{{ fw.decision_rules.length }} 条）</b>
            <div v-for="(r, i) in fw.decision_rules" :key="i" class="fw-rule">
              <div>当「{{ r.when }}」</div>
              <div style="color: var(--accent)">→ {{ r.then }}</div>
              <div v-if="r.because" class="hint">因为：{{ r.because }}</div>
            </div>
          </div>

          <div v-if="fw.voice?.catchphrases?.length" class="card">
            <b>他的口头禅</b>
            <div class="chips" style="margin-top: 6px">
              <span v-for="c in fw.voice.catchphrases" :key="c" class="chip">{{ c }}</span>
            </div>
            <div v-if="fw.voice.tone" class="hint" style="margin-top: 6px">
              语气：{{ fw.voice.tone }}
            </div>
          </div>

          <div class="alert info">
            载入这个知识库后，新建会话时可选「检验我的操作」或「请教军师」，
            让它用上面这套框架推演，而不是复述历史观点。
          </div>
        </template>

        <div class="section-title">技术信息</div>
        <div class="card">
          <div class="card-meta mono">
            kb_id: {{ detail.manifest.kb_id }}<br />
            策略: {{ detail.manifest.content_policy }}<br />
            抽取: {{ detail.manifest.extractor?.mode }} / {{ detail.manifest.extractor?.model || '—' }}<br />
            基准: {{ detail.manifest.benchmark }}<br />
            生成: {{ detail.manifest.generator?.name }} {{ detail.manifest.generator?.version }}
          </div>
          <div v-if="detail.manifest.extractor?.mode === 'rule'" class="alert warn" style="margin-top: 8px">
            该库由<b>词表规则</b>抽取。规则在口语化、正话反说的内容上会判出相反的方向，
            方向可信度较低。建议用 LLM 重新抽取，或在提问时要求 AI 说明这一点。
          </div>
        </div>

        <button class="btn" style="width: 100%" @click="detail = null">关闭</button>
      </div>
    </div>
  </div>
</template>
