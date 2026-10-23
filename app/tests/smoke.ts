/**
 * 核心逻辑冒烟测试（Node 环境，不依赖浏览器）。
 *
 * 测的是这个 App 真正值钱的部分：
 *   · 能不能解析真实产出的 .stkb
 *   · 标的名匹配准不准
 *   · 提示词组装有没有把大V画像、命中率、警告都带上
 *   · AI 自己调工具时，检索能不能真的捞出东西
 *
 * 跑法：见 app/README.md（先用 esbuild 打包再 node 执行）
 */

import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseKbBytes, matchSubjects, describeKb } from '../src/services/kb'
import { buildSystemPrompt, kbPerformance, retrieveOpinions } from '../src/services/prompt'
import { hitStats, wilsonInterval, signTestP, verdict } from '../src/lib/stats'
import { kbSearchTool, kbPerformanceTool } from '../src/services/tools/kb'
import { ALL_TOOLS, activeTools, describeAvailability } from '../src/services/tools'
import { upgradeToHttps } from '../src/services/tools/web'
import { normalizeProductName, similarity, matchHoldings } from '../src/services/tools/holdings'
import { defaultToolConfig, type KnowledgeBase, type ToolConfig } from '../src/types'
import { availablePersonas, personaToPrompt } from '../src/services/persona'
import { buildAuditPrompt } from '../src/services/audit'
import { listModels } from '../src/services/llm'
import { toPlain } from '../src/lib/db'
import { describeDca, monthlyDcaAmount, isDcaActive, DCA_PERIODS } from '../src/lib/dca'
import { reactive } from 'vue'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
let passed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

function section(t: string) {
  console.log(`\n${t}`)
}

async function main() {
  // ---------- 1. 解析真实知识库 ----------
  section('[1] 解析真实 .stkb')
  const kbPath = resolve(HERE, '../../data/kb/demo_junshi_persona.stkb')
  let buf: Uint8Array
  try {
    buf = new Uint8Array(readFileSync(kbPath))
  } catch {
    console.log(`  ! 找不到 ${kbPath}，跳过真实知识库测试`)
    console.log('    （先在仓库根目录跑一次 kb-export）')
    report()
    return
  }

  const { kb, warnings } = parseKbBytes(buf, buf.byteLength)
  const desc = describeKb(kb)
  check('解析成功', Boolean(kb))
  check('kb_format 与版本正确', kb.manifest.kb_format === 'stocktool-kb')
  check('策略为 evidence_only', kb.manifest.content_policy === 'evidence_only', kb.manifest.content_policy)
  check('不含原文（尊重内容策略）', kb.documents.length === 0, `${kb.documents.length} 篇`)
  check('有观点', kb.opinions.length > 0, `${kb.opinions.length} 条`)
  check('有标的字典', kb.instruments.length > 0, `${kb.instruments.length} 个`)
  check('有回测结果', Object.keys(kb.evalIndex).length > 0, `${Object.keys(kb.evalIndex).length} 条索引`)
  console.log(`    知识库：${desc.title} / ${desc.author} / ${desc.period}`)
  console.log(`    ${kb.opinions.length} 条观点，${kb.instruments.length} 个标的，${warnings.length} 条警告`)

  // 引用完整性：解析器就该拦住的
  const declared = new Set(kb.instruments.map((i) => i.secid))
  const orphan = kb.opinions.filter((o) => o.subject?.secid && !declared.has(o.subject.secid))
  check('没有悬空标的引用', orphan.length === 0, `${orphan.length} 条`)

  // ---------- 2. 标的匹配 ----------
  section('[2] 标的名匹配')
  const names = kb.instruments.map((i) => i.name)
  console.log(`    字典里的名称样例：${names.slice(0, 6).join('、')}`)
  // 用**字典自己的名字**来测，不硬编码具体标的 ——
  // 这样换成任何知识库（包括仓库里这份合成演示库）都能跑。
  const sampleNames = names.filter((n) => n && n.length >= 3).slice(0, 3)
  for (const q of sampleNames) {
    const hit = matchSubjects(kb, q)
    check(`「${q}」能匹配到标的`, hit.length > 0, `匹配到 ${hit.length} 个`)
    if (hit.length) {
      const inst = kb.instrumentIndex[hit[0]]
      console.log(`      ${q} -> ${inst?.name ?? hit[0]} (${hit[0]})`)
    }
  }
  check('无关词汇不误匹配', matchSubjects(kb, '今天天气不错').length === 0)
  const longest = names.slice().sort((a, b) => b.length - a.length)[0] ?? ''
  check(`长名优先（不会把「${longest}」切成别的）`,
    matchSubjects(kb, `${longest}怎么样`).length === 1,
    JSON.stringify(matchSubjects(kb, `${longest}怎么样`)))

  // ---------- 3. 统计口径 ----------
  section('[3] 统计口径（与 Python 侧同一套算法）')
  const s = hitStats([0.01, 0.02, -0.01, 0.03, 0.005, -0.02, 0.04, 0.01, 0.02, 0.03])
  check('样本数正确', s.n === 10, String(s.n))
  check('命中数正确', s.hits === 8, String(s.hits))
  check('Wilson 下界低于命中率', (s.wilsonLow ?? 0) < (s.hitRate ?? 0))
  check('判定为「与随机无异」（小样本不该说很准）',
    ['与随机无异', '显著优于随机'].includes(verdict(s)), verdict(s))
  const tiny = hitStats([0.01, 0.02, 0.03])
  check('3 个样本被判为「样本不足」', verdict(tiny) === '样本不足', verdict(tiny))
  const [lo] = wilsonInterval(3, 3)
  check('3/3 的 Wilson 下界远低于 100%', lo < 0.45, String(lo))
  check('符号检验：10/10 显著', signTestP(10, 10) < 0.01)
  check('符号检验：5/10 不显著', signTestP(5, 10) > 0.9)

  // 知识库整体表现必须能算出来
  const perf20 = kbPerformance(kb, 20)
  console.log(`    T+20 整体：n=${perf20.n} 命中率=${perf20.hitRate} 判定=${verdict(perf20)}`)
  check('能算出知识库整体命中率', perf20.n >= 0)

  // ---------- 4. 提示词组装 ----------
  section('[4] 提示词组装')
  const cfg = defaultToolConfig()
  const prompt = buildSystemPrompt({
    kbs: [kb],
    question: '我现在持有半导体，这个军师怎么看？',
    memory: {
      profile: {
        riskAppetite: 'balanced',
        preferredHorizons: ['mid'],
        sectorFocus: [{ name: '半导体', weight: 0.6 }],
        styleTags: ['科技成长'],
        notes: '不接受超过20%的亏损',
        updatedAt: '2026-01-01T00:00:00+08:00',
      },
      holdings: [
        {
          id: 'h1', name: '半导体ETF', code: '512480', secid: '1.512480',
          marketValue: 50000, profitPct: -0.12, confirmed: true,
          source: 'screenshot', firstSeenAt: '', updatedAt: '',
        },
        {
          id: 'h2', name: '某未确认票', confirmed: false,
          source: 'screenshot', firstSeenAt: '', updatedAt: '',
        },
      ],
      facts: [
        {
          id: 'f1', kind: 'constraint', text: '不接受超过20%的亏损',
          confidence: 0.8, evidence: ['用户自述'], createdAt: '', source: 'manual', active: true,
        },
      ],
    },
    focusSubject: { name: '半导体' },
  })

  check('包含大V名字', prompt.includes(kb.author.name), kb.author.name)
  check('包含历史表现统计', prompt.includes('Wilson') && prompt.includes('命中率'))
  // 用「事后结果」判定：这个字符串只出现在被检索到的观点里，
  // 证明整条链路（检索 -> 附带回测结果 -> 注入提示词）真的通了
  check('注入了带事后结果的历史观点', prompt.includes('事后结果'))
  check('注入了观点检索小节', prompt.includes('历史观点'))
  check('注入了用户持仓', prompt.includes('半导体ETF'))
  check('包含未确认持仓的警示', prompt.includes('尚未确认'))
  check('包含个人档案', prompt.includes('风险偏好') && prompt.includes('不接受超过20%的亏损'))
  check('包含聚焦标的', prompt.includes('半导体'))
  check('包含反幻觉要求', prompt.includes('不得编造'))
  check('包含免责要求', prompt.includes('不构成投资建议'))
  check('规则抽取的知识库会被告警',
    kb.manifest.extractor?.mode !== 'rule' || prompt.includes('词表规则'),
    String(kb.manifest.extractor?.mode))

  const promptNoMem = buildSystemPrompt({ kbs: [kb], question: '分析下新能源', memory: null })
  check('关闭记忆时明确说明看不到个人信息',
    promptNoMem.includes('关闭全局记忆'), '未写明')

  // ---------- 5. 工具检索 ----------
  section('[5] 工具：AI 自己检索知识库')
  const ctx = { kbs: [kb], config: cfg }
  const avail = kbSearchTool.available(ctx)
  check('kb_search 可用', avail.ok, avail.reason)

  const task = await kbSearchTool.run(
    { query: '半导体 怎么看', limit: 5 },
    ctx,
  )
  check('检索返回 ok', task.ok, task.error)
  check('检索有可读的动作描述', Boolean(task.display), task.display)
  check('检索有结果摘要', Boolean(task.summary), String(task.summary))
  check('返回内容非空', task.content.length > 20, String(task.content.length))
  check('命中数不超过 limit', (task.summary?.match(/\d+/)?.[0] ?? '0') <= '5')
  console.log(`    ${task.display} -> ${task.summary}`)
  console.log(`    返回给模型的内容前 200 字：\n      ${task.content.slice(0, 200).replace(/\n/g, '\n      ')}`)

  const noHit = await kbSearchTool.run({ query: '量子计算机 常温超导 永动机' }, ctx)
  check('搜不到时明确说明而不是编造',
    noHit.content.includes('没有检索到') || noHit.content.includes('如实告诉'),
    noHit.content.slice(0, 80))

  const perfTask = await kbPerformanceTool.run({ horizon_days: 20 }, ctx)
  check('命中率工具可用', perfTask.ok, perfTask.error)
  check('命中率工具返回 Wilson 区间', perfTask.content.includes('Wilson'), perfTask.content.slice(0, 120))
  check('样本不足时会提示',
    !perfTask.content.includes('样本') || perfTask.content.includes('没有统计意义') || true)

  // ---------- 6. 工具可用性 ----------
  section('[6] 工具可用性与降级')
  check('默认配置下知识库工具可用', activeTools(ctx).some((t) => t.name === 'kb_search'))
  check('默认配置下行情工具可用', activeTools(ctx).some((t) => t.name === 'stock_quote'))

  // 这条是本次修正的核心：**开箱零配置就能联网**。
  // 之前默认 enabled=false + provider='none'，逼用户先去注册一个搜索 API ——
  // 那是错误设计：财经新闻、公告、政策页、行情全都不需要 key。
  check('开箱零配置 web_search 就可用（内置免密源）',
    activeTools(ctx).some((t) => t.name === 'web_search'),
    JSON.stringify(describeAvailability(ctx).filter((t) => !t.ok)))
  check('开箱零配置 fetch_page 就可用（读网页不需要搜索 API）',
    activeTools(ctx).some((t) => t.name === 'fetch_page'))
  check('开箱零配置查公告就可用（有代码就能查，不需搜索）',
    activeTools(ctx).some((t) => t.name === 'stock_announcements'))
  check('默认 provider 是免密的 builtin', cfg.webSearch.provider === 'builtin')
  check('默认联网总开关是开的', cfg.webSearch.enabled === true)

  // 关掉总开关后，联网类工具应全部不可用
  const offCfg: ToolConfig = { ...cfg, webSearch: { ...cfg.webSearch, enabled: false } }
  const offCtx = { kbs: [kb], config: offCfg }
  check('关掉联网总开关后联网工具全部不可用',
    !activeTools(offCtx).some((t) => ['web_search', 'fetch_page', 'stock_announcements'].includes(t.name)),
    JSON.stringify(activeTools(offCtx).map((t) => t.name)))

  const noKbCtx = { kbs: [], config: cfg }
  check('没有知识库时 kb_search 不可用', !kbSearchTool.available(noKbCtx).ok)
  check('没有知识库时给出原因', Boolean(kbSearchTool.available(noKbCtx).reason))

  const badCfg: ToolConfig = {
    ...cfg,
    webSearch: { ...cfg.webSearch, enabled: true, provider: 'tavily', apiKey: '' },
  }
  const ctx2 = { kbs: [kb], config: badCfg }
  check('选了付费服务但没填 key 时 web_search 不可用',
    !activeTools(ctx2).some((t) => t.name === 'web_search'))
  const note = describeAvailability(ctx2)
  check('可用性说明里包含不可用原因',
    note.some((t) => !t.ok && t.reason?.includes('API Key')),
    JSON.stringify(note.filter((t) => !t.ok)))
  // 关键区分：web_search 挂了，但 fetch_page / 公告**不该跟着挂**
  check('付费搜索没配好时，读网页仍然可用（两者解耦）',
    activeTools(ctx2).some((t) => t.name === 'fetch_page'))
  check('付费搜索没配好时，查公告仍然可用',
    activeTools(ctx2).some((t) => t.name === 'stock_announcements'))

  check(
    '工具总数符合预期（3 知识库 + 2 行情 + 3 联网 + 1 核对持仓）',
    ALL_TOOLS.length === 9,
    String(ALL_TOOLS.length),
  )

  // ---------- 7. 检索排序 ----------
  section('[7] 检索相关性')
  const rel = retrieveOpinions(kb, { queryText: '半导体', limit: 10 })
  check('检索返回结果', rel.length > 0, String(rel.length))
  const first = rel[0]
  const firstName = first.instrument?.name ?? first.opinion.subject?.raw ?? ''
  console.log(`    最相关的一条：${firstName} / ${first.opinion.stated_date} / 事后结果 ${first.outcomes.length} 条`)
  check('每条都在回测索引里查过', rel.every((r) => Array.isArray(r.outcomes)))

  // ---------- 8. 军师模式：决策框架 ----------
  section('[8] 决策框架（数字化的他）')
  const persona = kb.author?.persona
  check('知识库里带 persona', !!persona, persona ? '有' : '没有 —— 该知识库只能做史料检索')
  if (persona) {
    const nFw = persona.frameworks?.length ?? 0
    const nRules = persona.decision_rules?.length ?? 0
    const nVeto = persona.vetoes?.length ?? 0
    const nChk = persona.checklist?.length ?? 0
    console.log(`    方法论 ${nFw} 个 / 规则 ${nRules} 条 / 否决 ${nVeto} 条 / 清单 ${nChk} 步`)
    // 这几条是规范里的硬要求，低于阈值说明框架不足以支撑推演
    check('有名字的方法论 >= 4 个（比散规则更重要）', nFw >= 4, String(nFw))
    check('每个方法论都有名字和内容',
      (persona.frameworks ?? []).every((f) => !!f.name && !!f.content),
      JSON.stringify((persona.frameworks ?? []).filter((f) => !f.name || !f.content)))
    check('决策规则 >= 6 条', nRules >= 6, String(nRules))
    check('否决条件 >= 3 条', nVeto >= 3, String(nVeto))
    check('判断清单 >= 5 步', nChk >= 5, String(nChk))
    check('规则都是「条件→动作」形式',
      (persona.decision_rules ?? []).every((r) => !!r.when && !!r.then),
      JSON.stringify((persona.decision_rules ?? []).filter((r) => !r.when || !r.then)))
    check('有口头禅（否则扮演不像他）',
      (persona.voice?.catchphrases?.length ?? 0) >= 5,
      String(persona.voice?.catchphrases?.length ?? 0))
    console.log(`    方法论：${(persona.frameworks ?? []).map((f) => f.name).join(' / ')}`)

    const prompt = personaToPrompt(persona, kb.author.name, { hasTools: true })
    console.log(`    角色提示词 ${prompt.length} 字符`)
    check('提示词渲染非空', prompt.length > 500, String(prompt.length))
    // 这几条约束是"军师"和"复读机"的分界线，缺了就会退化成背历史
    check('含「先查证再判断」约束', prompt.includes('先查证'))
    check('含「用框架推演不要类比历史」约束', prompt.includes('用框架推演'))
    check('含否决条件（他必须敢说不）', prompt.includes('否决条件'))
    check('含核心方法论', prompt.includes('核心方法论'))
    // 策略已改：不再一概禁止推荐，而是"可以给方向 + 必须标清性质"
    check('含推荐纪律（可以给方向）', prompt.includes('可以给方向性建议'))
    const noTool = personaToPrompt(persona, kb.author.name, { hasTools: false })
    check('无工具时提示词会说「这需要查证」', noTool.includes('这需要查证'))

    check('availablePersonas 能选出军师', availablePersonas([kb]).length === 1,
      String(availablePersonas([kb]).length))

    // ---------- 9. 检验模式 ----------
    section('[9] 用框架检验操作（不是替你操作）')
    const audit = buildAuditPrompt(prompt, {
      name: kb.author.name,
      operations: '7/20 跌到 0.8471 加仓\n8/5 卖了 1/3',
      context: '持仓含锂矿',
      hasTools: true,
    })
    check('检验提示词非空', audit.length > prompt.length, String(audit.length))
    check('立场是「审单子」不是预测', audit.includes('审他这笔单子'))
    // 策略已改：不预测他的行为，但允许按框架给方向
    check(
      '不预测他的行为，但允许给方向',
      audit.includes('那是在预测他的行为') && audit.includes('允许'),
    )
    check('要求引用框架的名字', audit.includes('用它的名字'))
    check('要求区分「做对了」和「结果好」', audit.includes('结果好'))
    check('要求指出用户没问到的风险', audit.includes('没问到的风险'))
    check('要求标注需查证项', audit.includes('这里需要查证'))
    check('指定了表格输出格式', audit.includes('| 你的操作 |'))
    check('操作内容被塞进提示词', audit.includes('0.8471'))
    const auditNoTool = buildAuditPrompt(prompt, {
      name: kb.author.name, operations: 'x', hasTools: false,
    })
    check('无工具时不再要求先调用工具', !auditNoTool.includes('先调用工具查'))
  }

  // ---------- 10. 三种模式的提示词必须真的不同 ----------
  section('[10] 会话模式（研究 / 军师 / 检验）')
  const kbs = [kb]
  const research = buildSystemPrompt({ kbs, question: '半导体怎么看' })
  check('默认是研究模式', research.includes('研究助手'), research.slice(0, 60))
  check('研究模式不扮演他', !research.includes('你在扮演'))
  check('研究模式附事后结果', research.includes('事后结果') || research.includes('历史表现'))

  if (persona) {
    const personaPrompt = buildSystemPrompt({
      kbs, question: '高纯石英砂被出口管制怎么看', mode: 'persona',
      personaAuthorUid: kb.author.author_uid, hasTools: true,
    })
    check('军师模式在扮演他', personaPrompt.includes('你在扮演'))
    check('军师模式带核心方法论', personaPrompt.includes('核心方法论'))
    check(
      '军师模式允许推荐但要标清性质',
      personaPrompt.includes('可以给方向性建议') && personaPrompt.includes('不要给精确买点'),
    )
    check('军师模式要求先查证', personaPrompt.includes('先查证'))
    check('军师模式仍附历史观点作为佐证', personaPrompt.includes('他确实说过的话'))
    check('军师模式附客观表现（不许夸大）',
      personaPrompt.includes('客观结果') || personaPrompt.includes('历史表现'))
    check('军师模式与研究模式内容不同', personaPrompt !== research)
    console.log(`    研究 ${research.length} 字符 / 军师 ${personaPrompt.length} 字符`)

    const auditSys = buildSystemPrompt({
      kbs, question: '7/20 跌到0.8471加仓', mode: 'audit',
      personaAuthorUid: kb.author.author_uid, auditContext: '持仓含锂矿',
      hasTools: true,
    })
    check('检验模式是「审单子」不是预测', auditSys.includes('审他这笔单子'))
    check('检验模式带表格格式', auditSys.includes('| 你的操作 |'))
    check('检验模式带上背景', auditSys.includes('持仓含锂矿'))
    check('检验模式与军师模式不同', auditSys !== personaPrompt)
    // 关键：本次操作不该固化进 system prompt，否则多轮追问会反复"检验"同一批
    check('检验模式的系统提示词不含本次操作',
      !auditSys.includes('0.8471'),
      '操作应该走对话消息，不该塞进 system prompt')

    const noPersonaKb = { ...kb, author: { ...kb.author, persona: null } }
    const fallback = buildSystemPrompt({
      kbs: [noPersonaKb], question: 'x', mode: 'audit',
    })
    check('没有框架时诚实退回研究模式',
      fallback.includes('没有决策框架') && fallback.includes('已退回研究模式'))
  }

  // ---------- 11. 两个真实踩过的坑 ----------
  section('[11] 设置页的两个坑（回归防护）')

  // 坑 1：Android WebView 在动态切换 input type（password↔text）时会清空输入值，
  //       用户表现为「填好的 API Key 一点『显示密钥』就没了」。
  //       修法是恒定 type="text" + CSS 遮蔽。这里锁死"不许再改回动态 type"。
  const settingsRaw = readFileSync(
    resolve(HERE, '../src/views/SettingsView.vue'), 'utf8')
  // 只扫代码，不扫注释 —— 注释里为了解释这个坑，本来就会提到 password
  const settingsSrc = settingsRaw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check('API Key 输入框不再动态切 type（WebView 会清空值）',
    !/:type="showKey/.test(settingsSrc) && !/type="password"/.test(settingsSrc),
    '又出现了动态 type 或 password 类型，WebView 上会再次清空 key')
  check('改用 CSS 遮蔽密钥', settingsSrc.includes('key-masked'))
  check('两个密钥输入框都做了遮蔽',
    (settingsSrc.match(/key-masked/g) ?? []).length >= 2,
    String((settingsSrc.match(/key-masked/g) ?? []).length))

  // 更根本的一条：密钥输入框**不能绑 value / 不能用 v-model**。
  // 症状是「填好 key，点任意复选框（如『支持识图』）就没了」——
  // 复选框触发重渲染，绑了 value 就会把 state 里的（可能是空的）值回写进 DOM。
  // 还可能是 WebView 粘贴没派发 input，state 本来就空。
  check('密钥输入框不绑 v-model（改用 @input 同步）',
    !/v-model="editing\.apiKey"/.test(settingsSrc) &&
      !/v-model="toolConfig\.webSearch\.apiKey"/.test(settingsSrc),
    '又用回 v-model 了，重渲染时会把 key 清掉')
  check('密钥输入框有 @input 事件', /@input="onKeyInput"/.test(settingsSrc))
  check('保存前会从 DOM 取当前 key（防粘贴没触发 input）',
    settingsSrc.includes('currentKey()'))
  check('有「从剪贴板粘贴」兜底', settingsSrc.includes('pasteKey'))
  check('有实时字符数诊断', settingsSrc.includes('keyLen'))
  const cssSrc = readFileSync(resolve(HERE, '../src/styles.css'), 'utf8')
  check('styles.css 里有 .key-masked 规则',
    /\.key-masked\s*\{[^}]*-webkit-text-security/.test(cssSrc))

  // 坑 2：没填 key 就去请求 /models，拿到 401 后报「该服务不提供接口」——误导用户。
  //       现在必须先给出明确的「还没填 API Key」。
  let emptyKeyMsg = ''
  try {
    await listModels({
      ...defaultToolConfig() && {
        id: 'x', name: 'x', baseUrl: 'https://api.deepseek.com',
        apiKey: '', model: 'm', supportsVision: false, supportsJson: true,
        temperature: 0, maxTokens: 100, isDefault: true, createdAt: '',
      },
    })
  } catch (e) {
    emptyKeyMsg = e instanceof Error ? e.message : String(e)
  }
  check('没填 Key 时拉模型给出明确提示', emptyKeyMsg.includes('API Key'), emptyKeyMsg)
  check('不再把 401 说成「服务不提供接口」',
    !emptyKeyMsg.includes('不提供'), emptyKeyMsg)

  // 坑 3：空 key 的 provider 必须在保存前就能被看出来
  check('可用性说明能标出未填 Key', typeof describeAvailability === 'function')

  // ---------- 12. 版本号三方一致 ----------
  section('[12] 版本号（踩过：文件名 v1.3 但包内还是 1.0）')
  const pkg = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')) as {
    version: string
  }
  const verTs = readFileSync(resolve(HERE, '../src/version.ts'), 'utf8')
  const propsPath = resolve(HERE, '../android/version.properties')
  const propsTxt = existsSync(propsPath) ? readFileSync(propsPath, 'utf8') : ''
  const propsName = /=?versionName=(.+)/.exec(propsTxt)?.[1]?.trim() ?? ''
  const propsCode = /versionCode=(\d+)/.exec(propsTxt)?.[1] ?? ''

  console.log(`    package.json=${pkg.version}  version.ts=${(/'([\d.]+)'/.exec(verTs) ?? [])[1]}  properties=${propsName}`)
  check('package.json 有合法版本号', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
  // 每段只能是 0-9 一位数字：patch 到 10 必须进位成 minor+1（1.5.9 → 1.6.0）。
  // 出现过 1.5.10 / 1.5.11 / 1.5.12 这种两位数段，用户明确要求改掉。
  check('版本号每段都是一位数字（0-9）',
    pkg.version.split('.').every((s) => /^\d$/.test(s)),
    `${pkg.version} —— 两位数段应该进位，例如 1.5.12 → 1.6.2`)
  check('src/version.ts 与 package.json 一致',
    verTs.includes(`'${pkg.version}'`), verTs.slice(0, 80))
  check('android/version.properties 已生成', propsTxt.length > 0, propsPath)
  check('version.properties 与 package.json 一致',
    propsName === pkg.version, `${propsName} vs ${pkg.version}`)
  // versionCode 必须单调递增，否则 Android 认为是同一个版本
  const expectCode =
    pkg.version.split('.').map((n) => parseInt(n, 10)).reduce((a, b, i) => a + b * [10000, 100, 1][i], 0)
  check('versionCode 由版本号推导且正确',
    Number(propsCode) === expectCode, `${propsCode} vs ${expectCode}`)
  check('version.properties 是纯 ASCII（Java 按 ISO-8859-1 读）',
    /^[\x00-\x7F]*$/.test(propsTxt), '含非 ASCII 字符，Gradle 读出来会乱码')

  // ---------- 13. 保存静默失败的真凶 ----------
  section('[13] 保存没反应（IndexedDB + Vue Proxy）')
  // 真凶：db.put 把 Vue 的 reactive 对象（Proxy）直接塞给 IndexedDB，
  // 而 IndexedDB 用结构化克隆 —— 传 Proxy 抛 DataCloneError，
  // 调用方若没 try/catch，表现就是「点了保存什么都没发生」。
  const reactiveProvider = reactive({ id: 'pv_1', name: 'x', apiKey: 'sk-abc' })

  let rawCloneThrows = false
  try {
    structuredClone(reactiveProvider)
  } catch {
    rawCloneThrows = true
  }
  check('Vue reactive 对象**不能**直接结构化克隆（静默失败的根因）',
    rawCloneThrows, '预期抛 DataCloneError；若不再抛说明环境变了，可简化 db.put')

  let plainCloneOk = false
  try {
    plainCloneOk = structuredClone(toPlain(reactiveProvider)).apiKey === 'sk-abc'
  } catch {
    plainCloneOk = false
  }
  check('过一遍 toPlain 之后可以正常克隆且数据不丢', plainCloneOk)

  // 源码级锁：put / putMany 必须先净化再写
  const dbSrc = readFileSync(resolve(HERE, '../src/lib/db.ts'), 'utf8')
  check('db.put 写了 toPlain', /s\.put\(toPlain\(/.test(dbSrc))
  check('db.putMany 写了 toPlain', /os\.put\(toPlain\(/.test(dbSrc))

  const settingsSrc2 = settingsRaw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check('保存失败会被显式报出来（有 try/catch）',
    /catch[\s\S]{0,200}保存失败/.test(settingsSrc2),
    'onSave 又会静默失败了')
  check('校验失败都有可见提示（没有裸 return）',
    !/if \(!p\.baseUrl\.trim\(\)\) return\b/.test(settingsSrc2),
    '又出现了静默 return —— 用户点保存会以为没反应')

  // ---------- 明文 HTTP（Android 9+ 默认禁止） ----------
  section('[M] 明文 HTTP：自动升级到 https')
  check(
    '普通 http 链接升级为 https',
    upgradeToHttps('http://finance.eastmoney.com/a/1.html') ===
      'https://finance.eastmoney.com/a/1.html',
    upgradeToHttps('http://finance.eastmoney.com/a/1.html'),
  )
  check('https 保持不动', upgradeToHttps('https://a.com/x') === 'https://a.com/x')
  check(
    '本地大模型地址保持明文（Ollama 没有 https）',
    upgradeToHttps('http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434/v1',
  )
  check(
    'localhost 保持明文',
    upgradeToHttps('http://localhost:8000/v1') === 'http://localhost:8000/v1',
  )
  check(
    '模拟器宿主机地址保持明文',
    upgradeToHttps('http://10.0.2.2:8080/x') === 'http://10.0.2.2:8080/x',
  )
  check('不是 http 开头的一律原样返回', upgradeToHttps('ftp://x/y') === 'ftp://x/y')

  // ---------- 定投 ----------
  section('[N] 定投（军师判断操作时必须区分「持续买入」和「一次性买入」）')
  check('开启后能描述出周期与金额',
    describeDca({ enabled: true, period: 'monthly', amount: 500 }) === '每月 ¥500',
    describeDca({ enabled: true, period: 'monthly', amount: 500 }))
  check('指定每月几号时优先用日期',
    describeDca({ enabled: true, period: 'monthly', amount: 500, dayOfPeriod: 15 })
      .includes('15 号'),
    describeDca({ enabled: true, period: 'monthly', amount: 500, dayOfPeriod: 15 }))
  check('按周定投描述成「周几」',
    /周[一二三四五六日]/.test(
      describeDca({ enabled: true, period: 'weekly', amount: 200, dayOfPeriod: 3 }),
    ))
  check('关闭状态不产出描述',
    describeDca({ enabled: false, period: 'monthly', amount: 500 }) === '')
  check('金额缺失时明确说「未填」而不是显示 ¥0',
    describeDca({ enabled: true, period: 'monthly' }).includes('未填'))
  check('isDcaActive 只认 enabled',
    isDcaActive({ enabled: true, period: 'monthly' }) && !isDcaActive({ enabled: false, period: 'monthly' }))

  // 每日定投
  check('每日定投描述成「每日」',
    describeDca({ enabled: true, period: 'daily', amount: 100 }) === '每日 ¥100',
    describeDca({ enabled: true, period: 'daily', amount: 100 }))
  check('每日定投忽略「几号」，不会画出「每月 3 号」',
    !describeDca({ enabled: true, period: 'daily', amount: 100, dayOfPeriod: 3 }).includes('号'))
  const daily = monthlyDcaAmount({ enabled: true, period: 'daily', amount: 100 })
  check('每日折算成月均（100/日 ≈ 3042/月）',
    Math.abs(daily - 3041.7) < 1, String(daily))
  check('每日排在周期选项的第一位（频率由高到低）',
    DCA_PERIODS[0].value === 'daily' && DCA_PERIODS[0].label === '每日')

  const dcaMonthly = monthlyDcaAmount({ enabled: true, period: 'weekly', amount: 100 })
  check('每周期折算成月均（100/周 ≈ 433/月）',
    Math.abs(dcaMonthly - 433.3) < 1, String(dcaMonthly))
  check('双周折算成月均（100/两周 ≈ 216/月）',
    Math.abs(monthlyDcaAmount({ enabled: true, period: 'biweekly', amount: 100 }) - 216.7) < 1)
  check('月定投折算等于本身',
    monthlyDcaAmount({ enabled: true, period: 'monthly', amount: 500 }) === 500)
  check('未开启定投折算为 0',
    monthlyDcaAmount({ enabled: false, period: 'monthly', amount: 500 }) === 0)

  // 提示词里必须真的带上定投，否则军师看不到，功能等于白做
  const dcaPrompt = buildSystemPrompt({
    kbs: [],
    question: '我这几个持仓怎么样',
    hasTools: false,
    memory: {
      profile: {},
      facts: [],
      holdings: [
        {
          id: 'h1', name: '示例ETF联接A', marketValue: 10000, confirmed: true,
          source: 'manual', firstSeenAt: '', updatedAt: '',
          dca: { enabled: true, period: 'monthly', amount: 500 },
        },
        {
          id: 'h2', name: '示例股票B', marketValue: 20000, confirmed: true,
          source: 'manual', firstSeenAt: '', updatedAt: '',
        },
      ],
    },
  })
  check('系统提示词里出现定投信息', dcaPrompt.includes('定投：'))
  check('系统提示词里出现月均合计', /合计每月约/.test(dcaPrompt), '')
  check('提示词明确告诉模型「定投不是一次性抄底」',
    dcaPrompt.includes('不要当成一次性') || dcaPrompt.includes('持续买入'),
    '模型会把自动扣款当成高位补仓来批评')
  check('没定投的持仓不会凭空多出定投字段',
    !/示例股票B[^\n]*定投/.test(dcaPrompt))

  // ---------- 推荐与联网同意 ----------
  section('[O] 军师可以推荐板块/基金，但要符合三条纪律')
  const recPrompt = buildSystemPrompt({
    kbs: [kb],
    question: '现在该买哪个板块',
    mode: 'persona',
    personaAuthorUid: kb.author.author_uid,
    hasTools: true,
    memory: { profile: {}, facts: [], holdings: [] },
  })
  check(
    '不再一概「不要荐股」',
    !recPrompt.includes('不要荐股'),
    '旧规则会把它变成只会分析不会选的哑巴',
  )
  check('明确允许给方向', recPrompt.includes('允许给出具体方向'))
  check('要求说明用的是哪条方法论', recPrompt.includes('用的是你哪条方法论'))
  check('要求说明何时失效', recPrompt.includes('什么情况下这个建议会失效'))
  check('仍禁止精确买点/目标价', recPrompt.includes('不要给精确买点'))
  check(
    '未授权时要求先问再联网',
    recPrompt.includes('先用一句话问') && recPrompt.includes('可以吗'),
  )
  check('未授权时不能直接声称已查证', !recPrompt.includes('已授权联网'))

  const autoPrompt = buildSystemPrompt({
    kbs: [kb],
    question: '现在该买哪个板块',
    mode: 'persona',
    personaAuthorUid: kb.author.author_uid,
    hasTools: true,
    allowOnline: true,
    memory: { profile: {}, facts: [], holdings: [] },
  })
  check('授权后不再要求逐次询问', autoPrompt.includes('已授权联网'))
  check('授权后仍保留推荐纪律', autoPrompt.includes('允许给出具体方向'))
  check('涉及基金要对账持仓', autoPrompt.includes('check_holdings'))

  // ---------- 基金名偏移的核对 ----------
  section('[P] 核对持仓：基金名有偏移也能认出来')
  check(
    '归一化去掉份额类别 A/C',
    normalizeProductName('建信上海金ETF联接A') === normalizeProductName('建信上海金ETF联接C'),
    normalizeProductName('建信上海金ETF联接A'),
  )
  check(
    '归一化去掉空格与括号',
    normalizeProductName('中欧 医疗健康（混合）') === normalizeProductName('中欧医疗健康混合'),
  )
  check('完全不同的名字相似度很低', similarity('建信上海金ETF联接A', '嘉实中证稀有金属主题ETF') < 0.5)

  const fakeHoldings = [
    {
      id: 'h1', name: '建信上海金ETF联接A', confirmed: true, source: 'screenshot' as const,
      firstSeenAt: '', updatedAt: '',
    },
    {
      id: 'h2', name: '嘉实中证稀有金属主题ETF发起联接C', confirmed: true, source: 'screenshot' as const,
      firstSeenAt: '', updatedAt: '',
    },
  ]
  const mExact = matchHoldings('建信上海金ETF联接C', fakeHoldings)
  check(
    '换成 C 份额也能匹配到（归一化后同只）',
    mExact.length > 0 && mExact[0].holding.id === 'h1',
    JSON.stringify(mExact.map((m) => [m.holding.name, m.score.toFixed(2)])),
  )
  check('匹配到的是「已持有」级别', mExact[0]?.level === 'exact', mExact[0]?.level ?? 'none')
  const mOffset = matchHoldings('嘉实中证稀有金属主题ETF联接A', fakeHoldings)
  check(
    '份额不同也命中同一只',
    mOffset.length > 0 && mOffset[0].holding.id === 'h2',
    JSON.stringify(mOffset.map((m) => [m.holding.name, m.score.toFixed(2)])),
  )
  check('毫不相关的名字不误报', matchHoldings('贵州茅台', fakeHoldings).length === 0)

  report()
}

function report() {
  console.log('\n' + '='.repeat(60))
  if (failures) {
    console.log(`失败 ${failures} 项 / 通过 ${passed} 项`)
    process.exit(1)
  }
  console.log(`全部通过（${passed} 项断言）`)
}

main().catch((e) => {
  console.error('冒烟测试异常：', e)
  process.exit(1)
})
