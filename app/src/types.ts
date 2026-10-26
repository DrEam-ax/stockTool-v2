/**
 * 领域模型。
 *
 * 三个概念必须分清，它们的数据生命周期完全不同：
 *   ModelProvider —— 用户自己的 LLM 连接（密钥只留在本机）
 *   KnowledgeBase —— 外部产物，可增删替换，「军师」的本体
 *   Memory        —— 只属于这个用户的事实与持仓，跨会话共享
 */

// ============================================================
// 1. 模型提供商
// ============================================================
export interface ModelProvider {
  id: string
  /** 用户自己起的名字，如「我的 DeepSeek」 */
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** 识图能力 —— 截图导入持仓依赖它，必须由用户确认而不是我们猜 */
  supportsVision: boolean
  /** 是否支持 response_format=json_object */
  supportsJson: boolean
  temperature: number
  maxTokens: number
  isDefault: boolean
  createdAt: string
  lastCheckedAt?: string
  lastCheckOk?: boolean
  lastCheckMessage?: string
}

export interface ProviderCheck {
  ok: boolean
  message: string
  models?: string[]
  latencyMs?: number
}

// ============================================================
// 2. 知识库（格式见 docs/kb-format.md）
// ============================================================
export interface KbManifest {
  kb_format: string
  format_version: string
  kb_id: string
  title: string
  description?: string | null
  content_policy: 'evidence_only' | 'full_text'
  created_at: string
  generator?: { name: string; version: string }
  publisher?: { name: string; contact?: string | null }
  sources?: KbSource[]
  extractor?: { mode: string; model?: string | null; note?: string }
  benchmark?: string
  horizons?: number[]
  counts?: Record<string, number>
  quote_policy?: { max_evidence_chars: number }
  integrity?: { algorithm: string; files: Record<string, string> }
  license?: { kb?: string; source_content?: string }
}

export interface KbSource {
  source: string
  author_uid: string
  author_name: string
  harvested_at?: string
  doc_count?: number
  period?: { first?: string | null; last?: string | null }
}

/**
 * 「数字化的他」—— 可迁移的决策框架。
 *
 * 和 summary/style_tags（风格画像）的区别就是产品的分水岭：
 *   风格画像回答"他是谁"（用于**描述**他）
 *   Persona 回答"遇到没见过的新情况他会怎么想"（用于**扮演**他）
 *
 * 有了 Persona，App 才能拿一个他从没提过的新标的问他，
 * 他也能按自己的框架给出自洽判断 —— 这才是"私人军师"。
 */
export interface DecisionRule {
  /** 触发条件，要具体到别的 AI 能拿去比对现实 */
  when: string
  /** 他会怎么做 */
  then: string
  /** 他为什么这么想 */
  because?: string
  /** 他的原话佐证 */
  voice_evidence?: string
}

export interface PersonaVoice {
  tone?: string
  catchphrases?: string[]
  argument_style?: string
}

/**
 * 有名字的方法论 —— **比 decision_rules 更重要**。
 *
 * decision_rules 是散的「条件→动作」，只能在特定场景用；
 * framework 是**被命名的、可反复调用的判断方法**。
 *
 * 关键区别（用户的原话）：
 *   「具体结论会过期，框架不会。他年初说'5000点'错了，但'破位二分法'依然能用。」
 *
 * 所以 `name` 很重要 —— 有名字的框架才会被反复调用。
 * 实测有效的名字：「破位二分法」「炒业绩vs炒概念」「上游甩鞭子」「击球区切换」。
 */
export interface Framework {
  /** 4~8 字的好记名字 */
  name: string
  /** 一句话说清这个方法是什么 */
  content: string
  /** 怎么用它判断一个具体操作（要能照着执行） */
  how_to_apply?: string
  /** 为什么这个框架不会过期 */
  durability?: string
  source_hint?: string
}

export interface Persona {
  identity?: string
  worldview?: string[]
  frameworks?: Framework[]
  decision_rules?: DecisionRule[]
  /** 否决条件 —— 什么情况下他绝不碰 */
  vetoes?: string[]
  preferences?: string[]
  aversions?: string[]
  valuation_framework?: string
  timing_framework?: string
  position_sizing?: string
  information_sources?: string[]
  voice?: PersonaVoice
  /** 面对新标的时会依次问自己的问题 */
  checklist?: string[]
}

export interface KbAuthor {
  author_uid: string
  name: string
  source: string
  summary?: string | null
  style_tags?: string[]
  focus_subjects?: string[]
  methodology?: string | null
  known_biases?: string[]
  horizon_bias?: string | null
  activity?: {
    first_post?: string | null
    last_post?: string | null
    doc_count?: number
    opinion_count?: number
  }
  /** 可迁移的决策框架；老知识库可能没有 */
  persona?: Persona | null
  generated_by?: string
  generated_at?: string
}

export interface KbInstrument {
  secid: string
  code: string
  name: string
  type: string
  exchange?: string | null
  aliases?: string[]
}

export interface KbOpinion {
  opinion_id: string
  author_uid: string
  doc_ref: string
  doc_hash?: string
  stated_at: string
  stated_date: string
  subject: { secid?: string | null; raw?: string | null; match_conf?: number | null }
  subject_type: string
  polarity: 1 | -1
  strength: number
  horizon: string
  thesis?: string | null
  triggers?: string[]
  evidence?: string | null
  extractor: string
  confidence?: number | null
}

export interface KbEvaluation {
  opinion_id: string
  horizon_days: number
  benchmark_secid: string
  entry_date?: string | null
  exit_date?: string | null
  bench_return?: number | null
  excess_return?: number | null
  signed_excess?: number | null
  hit?: number | null
  max_adverse?: number | null
  status: 'ok' | 'pending' | 'no_data'
}

export interface KbDocument {
  doc_ref: string
  author_uid: string
  published_at: string
  kind: string
  title?: string | null
  text: string
  content_hash?: string
  permalink?: string | null
}

/** 载入后的知识库。派生索引在导入时一次性建好，避免每次提问都全表扫。 */
export interface KnowledgeBase {
  id: string
  manifest: KbManifest
  author: KbAuthor
  instruments: KbInstrument[]
  opinions: KbOpinion[]
  documents: KbDocument[]
  /** secid -> 标的 */
  instrumentIndex: Record<string, KbInstrument>
  /** 检索用：把标的名与别名映射到 secid，支持长短匹配 */
  nameIndex: Record<string, string>
  /** opinion_id -> 回测结果 */
  evalIndex: Record<string, KbEvaluation[]>
  importedAt: string
  enabled: boolean
  sizeBytes: number
}

// ============================================================
// 3. 全局记忆
// ============================================================
export interface Holding {
  id: string
  name: string
  code?: string
  secid?: string
  shares?: number
  costPrice?: number
  lastPrice?: number
  marketValue?: number
  profitAmount?: number
  profitPct?: number
  firstSeenAt: string
  updatedAt: string
  source: 'screenshot' | 'manual'
  /** 截图识别出来的必须经用户确认才计入统计，否则错一位数就会污染所有分析 */
  confirmed: boolean
  note?: string
  /**
   * 定投计划。
   *
   * 必须让 AI 看到：定投和一次性买入是两种操作，
   * 「越跌越买」对定投是纪律，对一次性买入可能是失控。
   */
  dca?: import('./lib/dca').DcaPlan
}

export type FactKind = 'preference' | 'constraint' | 'observation' | 'goal'

export interface MemoryFact {
  id: string
  kind: FactKind
  text: string
  confidence: number
  /** 推理依据，用户可追溯、可删除 */
  evidence: string[]
  createdAt: string
  source: 'screenshot' | 'chat' | 'manual' | 'inferred'
  active: boolean
}

export interface UserProfile {
  displayName?: string
  riskAppetite?: 'conservative' | 'balanced' | 'aggressive'
  preferredHorizons: ('short' | 'mid' | 'long')[]
  sectorFocus: { name: string; weight: number }[]
  styleTags: string[]
  notes: string
  updatedAt: string
}

// ============================================================
// 4. 会话
// ============================================================
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** dataURL，仅用户消息可能有 */
  images?: string[]
  createdAt: string
  providerName?: string
  model?: string
  /** 生成这条回答时用到的知识库快照，便于事后追溯 */
  usedKb?: { id: string; title: string; author: string }[]
  usedMemory?: boolean
  /** 生成这条回答时用的模式，让用户知道当时是什么立场 */
  mode?: AdvisorMode
  /** 这条回答的方式：advisor=军师回答（走知识库）；plain=大模型直接回答。对比消息两侧各记自己的 */
  answerStyle?: 'advisor' | 'plain'
  /** AI 在这次回答里实际调用了哪些工具 —— 必须可见，否则用户无法判断可信度 */
  toolCalls?: ToolCallRecord[]
  /** 调用工具前的"思考"文本。它不是答案，混进正文会让人误以为那就是回答 */
  thinking?: string
  /** 轮数用尽被迫收尾（回答可能不完整） */
  hitRoundLimit?: boolean
  /** 用户点了「停止」，生成被主动中止（不是出错；渲染为「已停止」而非错误条） */
  aborted?: boolean
  error?: string
  usage?: { prompt: number; completion: number }
  pending?: boolean
  /** 对比请教：同一问题的两套独立回答（军师 vs 专业分析） */
  parallel?: ParallelAnswer
  /** 提问时刻的行情快照（用户消息）：发问那一分钟的价格存档，事后可回看 */
  snapshot?: QuoteSnapshot
}

/** 提问时刻行情快照。字段来自腾讯报价接口，time 精确到秒 */
export interface QuoteSnapshot {
  /** 展示名，如 贵州茅台 */
  name: string
  /** 6 位代码 */
  code: string
  price: number
  prevClose: number
  change: number
  changePct: number
  /** 行情快照时间，如 20261026161458 */
  time: string
}

/** 一次工具调用的记录（给用户看的，也是事后追溯的依据） */
export interface ToolCallRecord {
  id: string
  name: string
  /** 中文动作描述，如「检索知识库：半导体」 */
  display: string
  args: Record<string, unknown>
  ok: boolean
  /** 结果摘要，如「找到 12 条相关观点」 */
  summary?: string
  error?: string
  ms: number
  /** 原始返回，展开时可看 */
  detail?: string
}

/** 对比请教中某一侧的回答（军师 / 专业分析），两侧互不影响 */
export interface ParallelSide {
  content: string
  /** 调用工具前的"思考"文本，不是答案 */
  thinking?: string
  toolCalls?: ToolCallRecord[]
  /** 轮数用尽被迫收尾 */
  hitRoundLimit?: boolean
  /** 用户主动停止 */
  aborted?: boolean
  error?: string
  usage?: { prompt: number; completion: number }
}

/** 对比请教：同一问题的两套独立回答 */
export interface ParallelAnswer {
  /** 军师侧（知识库 persona / 研究模式） */
  advisor: ParallelSide
  /** 专业金融分析者侧（自带一套提示词，不依赖知识库） */
  analyst: ParallelSide
  /** 当前显示哪一侧 */
  active: 'advisor' | 'analyst'
}

// ============================================================
// 5. 工具配置
// ============================================================
/**
 * 搜索服务商。
 *
 * `builtin` = **免密钥**的内置兜底：直连财经新闻搜索与通用搜索页面。
 * 默认就用它 —— 我们不希望用户为了"让 AI 能查一下最新消息"先去注册一个 API。
 *
 * 为什么要内置兜底而不是只支持付费 provider：
 *   DSH 这类宿主能直接联网，是因为**宿主有服务端**代管搜索。
 *   本 App 是纯客户端、没有后端，所以只能自己在客户端解决。
 *   但客户端能解决的部分比想象的多：行情、公告、财经新闻、政策页面
 *   **全都不需要 key**，而这些恰好是"查证"需求的大头。
 */
export type WebSearchProvider =
  | 'builtin'
  | 'none'
  | 'tavily'
  | 'brave'
  | 'serper'
  | 'custom'

export interface ToolConfig {
  /** 一次回答里最多几轮工具调用，防止无限循环烧钱 */
  maxRounds: number
  kb: {
    enabled: boolean
    maxResults: number
  }
  webSearch: {
    /** 总开关。关掉后连 fetch_page 也不能用 */
    enabled: boolean
    provider: WebSearchProvider
    apiKey: string
    /** custom 时用；其它 provider 忽略 */
    baseUrl?: string
    maxResults: number
  }
  market: {
    enabled: boolean
    source: 'tencent' | 'eastmoney'
  }
}

export function defaultToolConfig(): ToolConfig {
  return {
    maxRounds: 9,
    kb: { enabled: true, maxResults: 12 },
    // 开箱即用：默认走免密兜底，用户什么都不用配
    webSearch: { enabled: true, provider: 'builtin', apiKey: '', maxResults: 6 },
    market: { enabled: true, source: 'tencent' },
  }
}

/**
 * 会话模式 —— 决定 AI 的立场，这是产品形态的分水岭。
 *
 *   research 研究  ：把大V的历史观点和事后结果如实呈现（有据可查，但只谈过去）
 *   persona  军师  ：扮演他，用他的框架推演**新情况**（可迁移，但不预测收益）
 *   audit    检验  ：他坐在对面审**你的操作**（最诚实：不荐股、不承诺收益）
 *
 * 用户的原话：「我从不问'这位大V会买XX'，我做的是用他的框架检验我的操作。」
 */
export type AdvisorMode = 'research' | 'persona' | 'audit'

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** 关键开关：关掉就是「单纯分析某只票」，不受持仓影响 */
  useGlobalMemory: boolean
  /** 这个会话请哪些「军师」，可多选 */
  activeKbIds: string[]
  /** 会话模式，默认 research（向后兼容） */
  mode?: AdvisorMode
  /** 回答方式：advisor=军师回答（知识库，默认）；plain=大模型直接回答（普通模式） */
  answerStyle?: 'advisor' | 'plain'
  /** persona / audit 模式下扮演谁（知识库里的 author_uid） */
  personaAuthorUid?: string | null
  /** audit 模式的背景补充（持仓、成本等） */
  auditContext?: string
  /**
   * 是否已预先授权「联网查证」。
   *
   * false/未设置时：模型在查行情、新闻、政策前**先用一句话问用户能不能查**，
   * 得到同意后才调用工具 —— 避免一上来就自己去联网。
   * true：本会话不再逐次询问，可以直接查。
   */
  allowOnline?: boolean
  /** 可选：本会话聚焦的标的 */
  focusSubject?: { secid?: string; name: string } | null
  messages: ChatMessage[]
}
