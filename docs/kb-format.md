# StockTool 知识库格式规范 v1.0

> 一句话：**App 是引擎，知识库是内容。** 二者通过本规范解耦。

---

## 1. 为什么要有这个规范

让任何人不依赖我们的 App，也能为**自己的**信息源产出一份知识库，
载入同一个 App 使用。因此本规范必须：

- **自包含**：一个文件搞定，不依赖 App 内置数据
- **可校验**：第三方能独立验证完整性
- **可分层**：个人自用与对外分享用同一套格式，靠策略字段区分
- **可演进**：格式版本显式声明，App 遇到不认识的版本要能明确拒绝而不是猜

---

## 2. 容器与文件结构

知识库是一个 **ZIP 容器**（推荐扩展名 `.stkb`），
也允许以**同名目录**形式存在（便于开发与 diff）。

```
<kb>/
  manifest.json         必需   元信息、版本、校验和
  author.json           必需   作者画像（"skill"本体）
  instruments.jsonl     必需   本库引用到的标的字典（自包含）
  opinions.jsonl        必需   结构化观点
  evaluations.jsonl     可选   预计算回测结果（离线出绩效榜）
  documents.jsonl       可选   原始文档，仅 content_policy=full_text 时存在
```

- 除 `manifest.json` / `author.json` 外均为 **JSONL**（每行一个 JSON 对象）。
  JSONL 便于流式处理、追加、以及用 git 看 diff。
- 文件一律 **UTF-8 无 BOM**，行尾 `\n`。

### 2.1 为什么要 JSONL 而不是一个 SQLite 文件

SQLite 更紧凑、可查询，但它是二进制：无法 diff、无法人工审阅、
合并两个库时需要写代码。知识库的分发与协作场景里，
**可读、可 diff、可手工修补**比省那几十 KB 重要得多。

---

## 3. content_policy：两层内容策略

这是本规范最关键的字段，直接决定知识库能否合法分享。

| 取值 | 含义 | 适用 |
|---|---|---|
| `full_text` | 含 `documents.jsonl`（完整原文） | **个人自用**。便于日后用更好的模型重新抽取 |
| `evidence_only` | 不含原文，观点仅带 `evidence` 短引用 | **对外分享**（默认） |

**理由**：归纳转述一个人的判断与统计，和复制传播他的文章，是两件不同的事。
`evidence_only` 把每条观点的引用限制在 `quote_policy.max_evidence_chars` 以内，
定位为"引用+归纳"而非"转载"。

> 分发 `full_text` 知识库前请自行确认授权。
> 采集者一般只对自己的个人使用有把握。

`manifest.quote_policy` 声明引用上限，校验器会检查是否越界。

---

## 4. 字段定义

### 4.1 `manifest.json`

```json
{
  "kb_format": "stocktool-kb",
  "format_version": "1.0",
  "kb_id": "xueqiu-0000000000-20261008",
  "title": "示例大V · 雪球观点库",
  "description": "对某雪球用户的发言做结构化抽取后的观点集",
  "content_policy": "evidence_only",
  "created_at": "2026-10-08T23:40:00+08:00",
  "generator": {"name": "stocktool", "version": "0.1.0"},
  "publisher": {"name": "self", "contact": null},
  "sources": [
    {
      "source": "xueqiu",
      "author_uid": "0000000000",
      "author_name": "示例大V",
      "harvested_at": "2026-10-08T22:18:50+08:00",
      "doc_count": 9,
      "period": {"first": "2024-03-05", "last": "2025-05-06"},
      "endpoint": "/v4/statuses/user_timeline.json"
    }
  ],
  "extractor": {
    "mode": "llm",
    "model": "deepseek-chat",
    "prompt_version": "1",
    "note": "口语化内容必须用 LLM；词表规则会判反方向"
  },
  "benchmark": "1.000300",
  "horizons": [5, 20, 60],
  "counts": {"authors": 1, "documents": 9, "opinions": 12, "instruments": 7},
  "quote_policy": {"max_evidence_chars": 200},
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "author.json": "…",
      "instruments.jsonl": "…",
      "opinions.jsonl": "…"
    }
  },
  "license": {
    "kb": "private",
    "source_content": "all-rights-reserved-by-original-author"
  }
}
```

必填：`kb_format`、`format_version`、`kb_id`、`created_at`、`content_policy`、`counts`。
其余可选但强烈建议填全 —— 校验器会就把缺失项给出警告而非报错。

### 4.2 `author.json` —— "skill" 本体

这是"吸收大V能力"的落点：**不是把语料喂给模型，而是提炼出可读、可解释的画像。**

> **契约：一个 `.stkb` = 一位军师。** `author.json` 只装一个作者对象。
> 想组建"军师团"就导出多个知识库、在 App 里一起载入。
> 多作者导出会被 `kb-export` 直接拒绝——因为除第一位以外的作者
> 会变成"没有画像的孤儿观点"，格式上也无法表达。

```json
{
  "author_uid": "xueqiu:0000000000",
  "name": "示例大V",
  "source": "xueqiu",
  "summary": "……150 字以内的整体风格与能力概括……",
  "style_tags": ["低估值", "现金流优先", "长期持有"],
  "focus_subjects": ["示例标的A", "示例标的B"],
  "methodology": "……分点的判断框架……",
  "known_biases": ["【示例】会系统性错过高景气成长股", "【示例】牛市后期容易过早减仓"],
  "horizon_bias": "long",
  "activity": {
    "first_post": "2024-03-05",
    "last_post": "2025-05-06",
    "doc_count": 9,
    "opinion_count": 12
  },
  "persona": { "…见 4.2.1…" },
  "generated_by": "llm:deepseek-chat",
  "generated_at": "2026-10-08T23:40:00+08:00"
}
```

`summary` / `methodology` / `known_biases` 回答**「他是谁」**，用于**描述**他；
App 可以直接把它们作为 LLM 上下文，解释"他为什么这么说"。

#### 4.2.1 `persona` —— 「数字化的他」（可迁移的决策框架）

**这是"私人军师"和"史料检索"的分水岭。**

| | 只有 summary / opinions | 带 persona |
|---|---|---|
| 回答的问题 | "他以前怎么看 X" | **"遇到没见过的新情况，他会怎么想"** |
| 新标的 | 一问三不知 | 按框架给出自洽判断 |
| 本质 | 历史结论检索 | 思维模型推演 |

`persona` 的全部字段：

```json
{
  "identity": "一句话说清他是谁、靠什么赚钱",
  "worldview": ["3~6 条投资世界观，是他所有判断的地基"],
  "decision_rules": [
    {
      "when": "触发条件，要具体到别的 AI 能拿去比对现实",
      "then": "他会怎么做",
      "because": "他为什么这么想",
      "voice_evidence": "他的原话片段（可选）"
    }
  ],
  "vetoes": ["否决条件 —— 什么情况下他绝不碰，至少 3 条"],
  "preferences": ["他反复偏好的东西"],
  "aversions": ["他反复厌恶/嘲讽的东西"],
  "valuation_framework": "他怎么判断贵贱",
  "timing_framework": "他怎么择时",
  "position_sizing": "他的仓位逻辑",
  "information_sources": ["他真正依赖的信息"],
  "voice": {
    "tone": "语气特征",
    "catchphrases": ["口头禅 8~15 个"],
    "argument_style": "他讲道理的套路"
  },
  "checklist": ["面对新标的会依次问自己的问题 5~8 条"]
}
```

**规范要求：**

- `decision_rules` **至少 3 条**（推荐 6 条以上），且必须是「条件 → 动作」形式。
  条件要具体到可判断真假——「当市场情绪好时」这种写法没有价值，
  因为它无法被拿来比对现实。
- `vetoes` **至少 3 条**。这决定了他什么时候会说"不"。
- `checklist` 必须能**直接用于评估一个全新标的**，不是描述他的历史。
- `voice.catchphrases` 应当来自语料里的真实高频用语，不要编。
- 生成时必须**明确要求不得美化**，且必须包含对他不利的客观发现。

**消费方式**：把 `persona` 渲染成角色提示词（本仓库的
`src/stocktool/extract/persona.py: persona_to_prompt` 与
`app/src/services/persona.ts: personaToPrompt` 是同构的两份实现），
配合工具调用，就得到"先查实时数据、再按他的框架推演"的军师。

提示词中**必须**包含这两条约束，否则会退化成复读机：

1. **先查证再判断** —— 涉及当前数据时必须调用工具，查不到就说查不到，不许编。
2. **用框架推演，不要类比历史** —— 说"按我的逻辑，这个情况意味着…"，
   而不是"我以前怎么看 X"。

### 4.3 `instruments.jsonl` —— 自包含标的字典

```json
{"secid":"1.600519","code":"600519","name":"贵州茅台","type":"stock","exchange":"SH","aliases":["茅台"]}
{"secid":"1.512480","code":"512480","name":"半导体ETF","type":"fund","exchange":"SH","aliases":["半导体","芯片"]}
```

`type` ∈ `stock` / `fund` / `index` / `industry` / `concept`
`secid` 为全局唯一键（`市场.代码`，市场 1=沪 0=深/北 90=板块）。
**必须包含本库 `opinions` 里出现过的全部 secid**，否则校验失败。

### 4.4 `opinions.jsonl`

```json
{
  "opinion_id": "9f3c1a…",
  "author_uid": "xueqiu:0000000000",
  "doc_ref": "xueqiu:512345678",
  "doc_hash": "ab12…",
  "stated_at": "2026-07-28T21:03:11+08:00",
  "stated_date": "2026-07-28",
  "subject": {"secid":"1.000300","raw":"大盘","match_conf":0.5},
  "subject_type": "index",
  "polarity": 1,
  "strength": 3,
  "horizon": "short",
  "thesis": "短期已跌到情绪极值，反弹概率大",
  "triggers": ["如果跌破前低"],
  "evidence": "现在持仓有些股票已经拒绝下跌，甚至有些还在上涨",
  "extractor": "llm:deepseek-chat",
  "confidence": 0.78
}
```

- `opinion_id`：库内唯一即可。**公式里必须包含 `subject.secid` 或 `subject.raw`**
  —— 只用 secid 会冲突：同一条帖子里同一位置的两条未归属观点
  （例如「氧化铝2505」和「氧化铝2509」），secid 都是空，会算出同一个 ID，
  进而让 `evaluations` 对不上观点。推荐
  `sha1(author_uid|doc_ref|char_start|subject_secid or subject_raw)[:24]`
- `doc_ref`：`<source>:<external_id>`，用于回指原文
- `doc_hash`：原文内容哈希，`full_text` 库可用它校验；
  `evidence_only` 库保留它，用于日后与原文比对（但不含原文本身）
- `polarity` ∈ `1` 看多 / `-1` 看空。**中性观点（polarity=0）不要写入知识库**
  —— 它既不可回测，也不是方向判断
- `strength` ∈ 1..5，`confidence` ∈ 0..1

### 4.5 `evaluations.jsonl`（可选，但强烈建议带）

让 App **离线就能出绩效榜**。体积很小（每条约 80 字节）。

```json
{"opinion_id":"9f3c1a…","horizon_days":5,"benchmark_secid":"1.000300",
 "entry_date":"2026-07-29","entry_close":4321.5,"exit_date":"2026-08-05","exit_close":4388.2,
 "bench_return":0.0121,"excess_return":0.0033,"signed_excess":0.0033,
 "hit":1,"max_adverse":-0.008,"status":"ok"}
```

`status` ∈ `ok` / `pending` / `no_data`。
`pending` 表示观察窗口尚未走完（观点太新），App 联网后应可重算。

> **知识库不含行情原始数据。** 行情是客观公开数据、体积大且易过期；
> 知识库只带**结论**。App 需要重算或核对时再自行获取行情。

### 4.6 `documents.jsonl`（仅 `full_text`）

```json
{"doc_ref":"xueqiu:512345678","author_uid":"xueqiu:0000000000",
 "published_at":"2026-07-28T21:03:11+08:00","kind":"post","title":null,
 "text":"现在持仓有些股票已经拒绝下跌…","content_hash":"ab12…",
 "permalink":"https://xueqiu.com/S/SH000300","raw_meta":{"like_count":12}}
```

`kind` ∈ `post` / `retweet` / `comment` / `live_replay` / `live_segment` / `community`

---

## 5. 版本与兼容

- `format_version` 为 `MAJOR.MINOR`。
- **MAJOR 不同 → App 必须拒绝载入**并提示，不得猜测。
- MINOR 更高 → 可载入，但需忽略不认识的字段并提示。
- 未知字段一律**忽略而非报错**，保证向后兼容。

---

## 6. 校验规则（`kb-validate` 实现）

| 级别 | 规则 |
|---|---|
| 错误 | 缺必需文件 / `kb_format` 不符 / `format_version` 的 MAJOR 不认识 |
| 错误 | `opinions` 引用了 `instruments` 里没有的 `secid` |
| 错误 | `evaluations` 引用了 `opinions` 里没有的 `opinion_id` |
| 错误 | `content_policy=full_text` 却没有 `documents.jsonl` |
| 错误 | `content_policy=evidence_only` 却带了 `documents.jsonl` |
| 错误 | `evidence` 长度超过 `quote_policy.max_evidence_chars` |
| 错误 | `integrity.files` 里的哈希与实际不符 |
| 警告 | `counts` 与实际行数不符 |
| 警告 | 缺 `evaluations.jsonl`（App 将无法离线出榜） |
| 警告 | 缺 `author.json` 的 `summary` / `methodology` |

---

## 7. 体积

**知识库可以很小 —— 因为它装的是「结论」，不是数据。**

这也是"知识库按需下载 / 随手分享"能成立的前提。

以仓库里的合成演示库为例（9 篇帖子 / 12 条观点 / 7 个标的）：

| 组成 | `evidence_only` | `full_text` |
|---|---|---|
| manifest + author | ~2 KB | ~2 KB |
| instruments | <1 KB | <1 KB |
| opinions | ~3 KB | ~3 KB |
| evaluations | ~4 KB | ~4 KB |
| documents | — | 帖子原文是主要体积来源 |
| **ZIP 后合计** | **~9 KB** | 随原文长度线性增长 |

两条经验：

- **`evidence_only` 的体积几乎只由观点条数决定**（每条只留一段短引用，
  上限由 `quote_policy.max_evidence_chars` 控制），跟语料原始体量关系不大。
  万条观点量级的库通常也在几百 KB 以内。
- **`full_text` 的体积由原文长度决定**，一篇几百字的帖子约 0.2 KB。
  它只适合个人留档，不适合分享。

抽几篇真实语料自己跑一遍 `kb-export`，就能得到你那个语料规模的确切数字 ——
比任何外推都准。这也比让人下载一个内置了同样内容的 App 轻得多。

> **注意**：**词表规则抽取器的召回率很低**（口语化内容常常一条都抽不出来）。
> 口语化、正话反说的内容必须用 LLM 抽取，召回率和准确率都会高得多，
> 见 §8 第 2 步。

---

## 8. 给第三方构建者的最小路径

1. 采集你自己的信息源，得到 `(author, published_at, text, permalink)` 四元组
2. 用任意 LLM 按 §4.4 的字段抽取结构化观点
   （**不要用词表规则** —— 口语化内容会判反方向）
3. 汇总观点里出现过的标的，写出 `instruments.jsonl`
4. 写出 `manifest.json`（`content_policy` 按用途选）、`author.json`
5. 算 `integrity` 哈希，打成 zip
6. `python run.py kb-validate <文件>` 自检

第 2 步是本格式唯一有技术门槛的地方，也是构建器存在的意义。
