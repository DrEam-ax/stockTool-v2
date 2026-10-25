/** 模型提供商：用户自己填 baseUrl / key / model，可配多个，选一个默认。 */

import { computed, ref } from 'vue'
import type { ModelProvider } from '@/types'
import * as db from '@/lib/db'
import { nowIso, uid } from '@/lib/fmt'
import { testProvider } from '@/services/llm'

const providers = ref<ModelProvider[]>([])
const loaded = ref(false)

export function emptyProvider(): ModelProvider {
  return {
    id: uid('pv_'),
    name: '',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    supportsVision: false,
    supportsJson: true,
    temperature: 0.3,
    maxTokens: 16384,
    isDefault: false,
    createdAt: nowIso(),
  }
}

/** 常见服务的预设，减少用户填错 baseUrl 的概率 */
export const PRESETS: {
  label: string
  baseUrl: string
  model: string
  vision: boolean
  hint?: string
}[] = [
  {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    vision: false,
    hint: '便宜、中文好；无识图能力',
  },
  {
    label: '阿里云百炼（通义）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    vision: false,
    hint: 'qwen-vl-max 支持识图',
  },
  {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    vision: false,
    hint: 'moonshot-v1-8k-vision-preview 支持识图',
  },
  {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    vision: false,
    hint: 'glm-4v 支持识图',
  },
  {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    vision: true,
    hint: 'gpt-4o 系列支持识图',
  },
  {
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    vision: false,
    hint: 'key 可随便填；需以 App 或同机运行',
  },
  {
    label: '本地 vLLM / LM Studio',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'your-model',
    vision: false,
    hint: 'OpenAI 兼容端点',
  },
]

export function useProviders() {
  async function load() {
    if (loaded.value) return
    providers.value = (await db.getAll<ModelProvider>(db.STORES.providers)).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt),
    )
    // 存量迁移：旧默认 maxTokens=2048/8192 会把长回答截断（用户反馈「回答触发截断」）。
    // 只升级「等于旧默认值」的配置（说明用户没自定义过），逐级升到 16384；
    // 用户自己填的其他值一律不动。
    for (const p of providers.value) {
      if (p.maxTokens === 2048 || p.maxTokens === 8192) {
        p.maxTokens = 16384
        await db.put(db.STORES.providers, p)
      }
    }
    loaded.value = true
  }

  async function save(p: ModelProvider) {
    if (p.isDefault) {
      for (const other of providers.value) {
        if (other.id !== p.id && other.isDefault) {
          other.isDefault = false
          await db.put(db.STORES.providers, other)
        }
      }
    }
    await db.put(db.STORES.providers, p)
    const i = providers.value.findIndex((x) => x.id === p.id)
    if (i >= 0) providers.value[i] = p
    else providers.value.push(p)
    if (!providers.value.some((x) => x.isDefault)) {
      p.isDefault = true
      await db.put(db.STORES.providers, p)
    }
  }

  async function remove(id: string) {
    await db.remove(db.STORES.providers, id)
    providers.value = providers.value.filter((p) => p.id !== id)
    if (!providers.value.some((p) => p.isDefault) && providers.value[0]) {
      providers.value[0].isDefault = true
      await db.put(db.STORES.providers, providers.value[0])
    }
  }

  async function check(p: ModelProvider) {
    const r = await testProvider(p)
    p.lastCheckedAt = nowIso()
    p.lastCheckOk = r.ok
    p.lastCheckMessage = r.message
    await db.put(db.STORES.providers, p)
    return r
  }

  const defaultProvider = computed(
    () => providers.value.find((p) => p.isDefault) || providers.value[0] || null,
  )
  const visionProviders = computed(() =>
    providers.value.filter((p) => p.supportsVision),
  )

  return {
    providers,
    loaded,
    load,
    save,
    remove,
    check,
    defaultProvider,
    visionProviders,
  }
}
