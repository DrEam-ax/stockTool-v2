# stockTool —— 把大V的语料变成「数字化的军师」

一款**选股 / 选基金**的手机 App。它不荐股，而是把某位大V的公开语料提炼成
**可迁移的决策框架**，再用这个框架去**检验你自己的操作**。

> ✗ 「这位大V会买 XX 吗？」 —— 这是预测，会错、会过期，也把大V变成了荐股机器人
> ✓ 「我 7/20 跌到 0.8471 加仓了，用他的框架帮我审一下」 —— 这是审计，框架可复用

**App 只是壳，价值全在数据管道里。**

---

## 现在是什么状态

**管道已跑通，App 已可用。** 仓库里带一份**合成演示数据**，
clone 下来就能完整跑通全流程（不依赖任何真实语料）：

```
任意一位大V的公开语料
  → LLM 抽取结构化观点（方向 / 强度 / 周期 / 原话证据）
  → 真实行情回测（T+5 / T+20 / T+60 / T+250），带随机选股基线对照
  → 作者画像 + 可迁移的决策框架（persona）
  → 知识库 .stkb（自包含，App 直接载入）
  → Android APK
```

### 两种资产

| | 做什么 | 给出什么 |
|---|---|---|
| **研究模式** | 查他过去怎么看某个标的，附事后的**真实超额收益** | 有据可查，但只谈过去 |
| **军师模式** | 用他的框架推演**他没遇到过的新情况** | 能迁移，但不预测收益 |
| **检验模式** | 他坐在对面审**你的操作** | 最诚实：不荐股、不承诺收益 |

**检验模式** 的输出长这样（标的已脱敏）：

```
| 你的操作              | 用他的框架怎么检验                          |
|----------------------|-------------------------------------------|
| 某标的跌到 X 时加仓    | 「破位二分法」→ 前提是处在低位；高位破位就该卖   |
| 减仓 1/3              | 除非卖的是纯概念股，否则与「长期持有」自相矛盾  |
| 某板块在你的持仓里      | 持有符合框架 —— 但你刚减的那笔是不是它？直接冲突 |
```

它会**指出你没问到的矛盾**，也会**拒绝在没有数据时下结论**。

---

## 三条被数据推翻或修正过的结论

这个项目最大的教训：**先测量，再下判断**。

1. **「显著差于随机」是我自己的 bug**
   「大盘」类观点的标的就是基准本身，超额收益恒为 0、命中恒为 0，被记成全错。
   这批样本约占 8%，足以把「与随机无异」扭曲成「显著差于随机」。

2. **判定不能对着 50%**
   A 股中位数个股本来就跑输市值加权指数。实测随机选股在同一批日期上的命中率
   只有 **44%/45%/43%**（T+5/20/60）—— 这是全市场的事实，不是某个人的问题。
   拿 50% 当原假设会冤枉所有人。

3. **必须看长周期**
   实测存在一类大V：短周期（T+5/20/60）与随机无异，一年期却显著强于随机。
   他们是「左侧 + 长期持有」型，用 60 天的尺子量，量的是完全错误的东西。
   **周期必须匹配风格**，否则会把人误判成没水平。

另外：**重复发帖必须去重**。有人在同一天把同一段话回复多人，实测重复率可达两成
（同一观点最多重复七次）。不去重会让样本量虚高、p 值假性显著。

---

## 仓库结构

```
src/stocktool/          Python 管线（stdlib + requests，零额外依赖）
  ingest/               雪球采集、cURL/cookie 解析
  extract/              rule / llm 抽取器、标的解析、画像与决策框架
    persona.py          ★ 「可迁移的决策框架」—— 这个项目最核心的文件
    audit.py            ★ 「用框架检验操作」的提示词
  market/               行情多源容灾（腾讯 → 新浪 → 东财）
  backtest/             回测、随机选股基线、Wilson 区间、符号检验
  kb/                   .stkb 知识库格式（ZIP + JSONL）
app/                    Vue 3 + Capacitor，本地 IndexedDB，无后端
  src/services/persona.ts   persona 提示词（与 Python 侧同构）
  src/services/audit.ts     检验模式提示词
  scripts/build-apk.mjs     一键打包（版本号单一来源）
  TESTING.md            ★ 测试策略与踩过的坑
docs/kb-format.md       知识库格式规范（第三方也能据此构建）
data/seed/              合成语料，用于测试
data/kb/demo_*.stkb     合成军师，可用来试「多军师」
```

### 这个仓库里**没有**什么（以及为什么）

| 文件 | 原因 |
|---|---|
| `config/llm_api_key.txt`、`config/xueqiu_cookie.txt` | **真实凭据**，绝不入库 |
| `data/raw/`、`data/stocktool.db` | 抓取语料与整库快照，体积大 |
| `data/kb/luo_*.stkb` | **真实人物的作品**，且含对具名者的负面评价，公开仓库不合适 |
| `app/node_modules/`、`dist/`、`*.apk` | 依赖与构建产物 |

要连语料一起备份，请把仓库改成私有，再显式放行（见 `.gitignore` 注释）。

---

## 快速开始

### Python 管线

```powershell
cd D:\dsh-stockTool
python run.py initdb
python run.py pipeline            # 一键：标的→语料→抽取→行情→回测→报告
python run.py profile-author --author <名字>   # 提炼画像 + 决策框架
python run.py kb-export out.stkb --author <名字> --policy evidence_only
```

### App

```powershell
cd D:\dsh-stockTool\app
pnpm install
pnpm dev          # 浏览器（受 CORS 限制，联网工具不可用）
pnpm ship         # 测试全过 → 打包 APK（自动升版本号）
pnpm test:all     # 类型 + 逻辑 + DOM 测试
```

**联网工具必须装 App**：浏览器受 CORS 限制，打包后走原生 HTTP 才没有限制。

---

## 测试

| 层 | 数量 | 覆盖 |
|---|---|---|
| App 逻辑 | 127 项 | 抽取、KB 往返、提示词、三种模式、版本一致性 |
| **App DOM** | **38 项** | **渲染、交互流程、标签结构、CSS 选择器** |
| Python | 113 项 | 抽取、cookie/dump 解析、KB 往返 |
| 联网 | 3 源 | 免密搜索对**真实响应**的解析 |

详见 [app/TESTING.md](app/TESTING.md)。**为什么单独有 DOM 层**：
用户报过的 bug 里，函数返回值全都正常，坏在渲染、样式、异步副作用上
（`v-model` 被重渲染清空、CSS 后代选择器把输入框压扁、IndexedDB 无法克隆 Vue Proxy）。

---

## 数据来源与合规

- 语料为**公开可见**的社交平台发言，仅作个人研究用途。
- App **不内置任何内容**，只提供引擎；知识库是外部文件。
- 知识库两种内容策略：`evidence_only`（短引用，可分享）/ `full_text`（含原文，仅个人留档）。
- 本项目**不构成投资建议**，只描述历史统计事实。

---

## 详细文档

- [app/README.md](app/README.md) —— App 功能与 CORS 说明
- [app/ANDROID.md](app/ANDROID.md) —— 打包（JDK/版本号那些坑）
- [app/TESTING.md](app/TESTING.md) —— 测试分层与交付闸门
- [docs/kb-format.md](docs/kb-format.md) —— 知识库格式规范
- [data/kb/README.md](data/kb/README.md) —— 知识库产物说明与两种用法

---

## 旧版说明（P0 阶段，保留作记录）

以下是最初验证「抽取 → 回测」这条链路时的记录，数字已过时，但方法仍然适用。

---

## 快速开始

无需 pip install。系统里 `D:\Python\python.exe`（3.13.7）已自带 `requests`，
行情接口全部直连，**本阶段零新增依赖**。

```powershell
cd D:\dsh-stockTool

python run.py initdb --reset     # 建库（改过 schema 要用 --reset）
python run.py pipeline           # 一键跑通：标的→语料→抽取→行情→回测→报告
python run.py status             # 看数据概况
```

分步执行：

```powershell
python run.py fetch-universe             # 标的全集：新浪个股 + 板块ETF + 指数
python run.py import                     # 导入 data/seed/ 下的语料
python run.py extract --show 20          # 抽取观点
python run.py extract --llm              # 启用 LLM 抽取（需 API key）
python run.py fetch-quotes               # 抓行情
python run.py evaluate                   # 回测打分
python run.py report                     # 生成报告到 reports/
```

跑回归测试（共 113 项断言）：

```powershell
python tests\test_extraction.py      # 24 项：抽取器 + 回测入场规则 + 统计
python tests\test_xueqiu_cookie.py   # 18 项：Cookie / cURL 解析容错
python tests\test_xueqiu_dump.py     # 21 项：浏览器导出 JSON 的导入链路
python tests\test_llm_extract.py     # 13 项：LLM 抽取的解析与合并策略
python tests\test_kb_roundtrip.py    # 33 项：知识库 导出→校验→导入 闭环
```

环境变量：

| 变量 | 用途 |
|---|---|
| `STOCKTOOL_LLM_API_KEY` | LLM 抽取的 key（不配也能跑，走纯规则） |
| `STOCKTOOL_LLM_BASE_URL` | 默认 `https://api.deepseek.com/v1`，OpenAI 兼容即可 |
| `STOCKTOOL_LLM_MODEL` | 默认 `deepseek-chat` |
| `STOCKTOOL_BENCHMARK` | 基准 secid，默认 `1.000300`（沪深300） |

> **装包注意**：官方 PyPI 在本机超时，用镜像
> `-i https://pypi.tuna.tsinghua.edu.cn/simple`。

---

## 架构

```
采集层 adapter          归一化          抽取层               回测层
  manual (种子/粘贴)  →  RawDoc   →  rule@1 规则抽取  →  行情对齐
  <平台 adapter>                       llm:<model> 可选      超额收益
  <音视频 adapter>                                            Wilson 区间
  <人工兜底>                                                  绩效榜 + 共识
```

> 具体 adapter 按来源形态实现（见「下一步」）。仓库里只带 `manual`
> 与雪球导入（浏览器导出 JSON），其余按需接。

```
src/stocktool/
  schema.sql            数据库结构（核心资产，注释详尽）
  models.py             领域模型
  matching.py           最长匹配扫描（"坚定看好" 必须赢过 "看好"）
  ingest/
    manual.py           种子/手工导入，统一的 RawDoc
    xueqiu.py           雪球采集 + cURL 解析 + 浏览器导出导入
  extract/
    lexicon.py          情绪词表加载（含否定正则）
    resolver.py         标的归一化：cashtag / 裸代码 / 名称 / 别名
    rule_extractor.py   规则抽取（踩坑注释都在这里）
    llm_extractor.py    LLM 抽取（口语化内容必须用它）
    runner.py           抽取编排 + 幂等落库 + 清理重建
  market/
    symbols.py          secid / symbol 转换
    tencent.py          腾讯行情（当前主力价格源）
    sina.py             新浪标的清单 + 行情兜底
    eastmoney.py        东财（K线 + 板块清单，可能被限流）
    prices.py           多源故障转移
    sectors.py          板块 → 可交易 ETF 映射
  backtest/
    evaluate.py         回测（前视偏差防护、停牌处理）
    scoreboard.py       绩效榜 + 板块共识
    stats.py            Wilson 区间、符号检验
  kb/                   知识库：导出 / 载入 / 校验（见 docs/kb-format.md）
    spec.py             格式常量与标识符规则
    bundle.py           目录 / ZIP 两种容器
    exporter.py         库 -> 知识库
    importer.py         知识库 -> 库
    validator.py        规范校验
  report/render.py      Markdown 报告
```

---

## 数据源现状与坑（重要）

| 源 | 用途 | 状态 |
|---|---|---|
| 腾讯 `web.ifzq.gtimg.cn` | 日线（前复权，个股/指数/ETF） | ✅ 主力，**上限 800 根** |
| 新浪 `vip.stock.finance.sina.com.cn` | A股清单（分页 100/页） | ✅ 主力 |
| 新浪 `quotes.sina.cn` | 日线兜底 | ✅ **上限 1023 根** |
| 东财 `push2his` / `push2` | K线 + 行业/概念板块清单 | ⚠️ **会对密集翻页做边缘封禁** |

### 踩过的坑

1. **东财 IP 封禁**：`push2` 集群在密集翻页后返回 **0 字节直接断连**，
   所有镜像主机（`1./7./82.push2`）一起失效，换客户端（PowerShell）也没用。
   所以价格层改成了**多源故障转移**（腾讯 → 新浪 → 东财），不能单点依赖。
   过一段时间会自动解封；`fetch-universe --with-boards` 可在解封后补充行业/概念板块指数。

2. **腾讯 K线上限 800**：`count=1500/2000` 会被**静默截断到 641**，
   `count>=4000` 直接 `param error`。已在 `Tencent.MAX_BARS` 里夹紧。

3. **新浪股票名带空格和全角**：`五 粮 液`、`万 科Ａ`。
   不做归一化的话这批股票的名称匹配**全部失效**。
   已在 `upsert_instruments`（唯一入库入口）统一处理。

4. **6 位代码跨市场撞车**：`000001` 既是深市**平安银行**(`0.000001`)，又是沪市**上证指数**(`1.000001`)。
   早期用代码做主键导致上证指数被去重丢掉、大盘观点被算到平安银行头上。
   现已全面改用 **secid** 做主键。

5. **板块怎么办**：东财 BK 板块指数被限流时不自由。
   现方案是 **用 ETF 作为板块的可交易代理**（`config/sectors.json`，43 个已逐个验证存在）。
   ETF 有真实K线、是用户真正能买的东西，且不依赖被限流的接口。

---

## 抽取器的四条规则（都是踩坑换来的）

在 `extract/rule_extractor.py` 里，每条都有对应的回归测试：

1. **不预切分逗号**。否则「贵州茅台，我看好」会把标的和方向切开。
   改为整句内找全部标的 + 全部方向词，用**就近归属**配对 ——
   这样「白酒我看好，但半导体要小心」能正确得到两个**相反**的观点。

2. **否定必须紧邻**，且中间只允许副词。
   否则「不**错**，看好茅台」会被 `不` 误判成看空。

3. **让步从句和条件从句里的方向词不算主论断**。
   - 「**虽然**估值不**便宜**，**但**产业趋势足够强」→ 不能判成看空
   - 「**除非**政策有**超预期**的力度，否则我暂时不碰」→ 不能判成看多（真实态度是"暂时不碰"=看空）

4. **主语跨句继承**。大V 常先点名标的、后面若干句只谈观点：
   「`$寒武纪$` 产业趋势强。**我坚定看好，长线持有。**」
   不继承的话，后半段的观点会因为"没主语"被整句丢掉。
   继承来的观点置信度打折，可用「观点句里找不到 `subject_raw`」反查。

---

## 知识库：App 是引擎，内容是数据

这是本项目的核心架构决定。完整规范见 **[docs/kb-format.md](docs/kb-format.md)**。

```
采集器 ──> 结构化观点 ──> 知识库(.stkb) ──> App 载入
                              ↑
                    任何人可产出、可分享、可替换
```

**为什么这样切**：

1. **合规**：App 只发布**引擎**，不发布内容。内容由用户自己产出、自己载入。
   这从架构上解决了"爬大V内容有没有风险"的问题
2. **体积**：App 里只有解析/渲染/回测逻辑；知识库按需下载
3. **扩展**：加一个信息源不需要改 App，只需要一份新知识库

### 三个关键设计

| 设计 | 理由 |
|---|---|
| **两层内容策略**<br>`evidence_only`（可分享）/ `full_text`（仅自用） | 归纳转述一个人的**判断与统计**，和复制传播他的**文章**，是两件不同的事。分享用前者才站得住 |
| **知识库不放行情，放回测结果** | 行情又大又易过期（200 标的 5 年日线 ≈ 20MB）；回测结果每条约 80 字节。这样 App **离线即可出绩效榜**，联网时可自行重算 |
| **标的字典自包含** | 观点里存 `1.600519`，App 得知道这是"贵州茅台"。不能依赖 App 内置全市场 5622 个标的——那正是要减掉的体积。所以知识库**只带被引用到的标的 + 别名** |

### 用起来

```powershell
# 导出：个人留档用 full_text，分享给朋友用 evidence_only（默认）
python run.py kb-export data\kb\out.stkb --author 示例大V --policy full_text
python run.py kb-export share.stkb --author 示例大V            # evidence_only

# 校验（第三方构建者用它自检）
python run.py kb-validate share.stkb
python run.py kb-info share.stkb

# 载入
python run.py kb-import share.stkb
python run.py report
```

校验器会拦住：缺必需文件、引用了未声明的标的、引用超长（越界即视为转载而非引用）、
策略与文件不符、完整性哈希不符、不认识的格式主版本。

### 让朋友也能产出知识库

格式不是门槛，**构建器**才是。朋友需要：采集器 + 抽取器（LLM）。
两件事都能从本仓库复用：

```powershell
python run.py collect-xueqiu <昵称或uid>      # 采集（HTTP 通道，需 Cookie）
python run.py import-xueqiu <导出.json>       # 或从浏览器导出导入
python run.py extract --extractor llm        # 抽取（口语化内容必须用 LLM）
python run.py kb-export my_kb.stkb
```

> 第 3 步是唯一有技术门槛的地方。**不要用词表规则** ——
> 实测在口语化、正话反说的内容上会判出**相反**的方向，
> 比抽不出来危险得多（错误方向的观点会污染整张绩效榜）。

---

## 回测方法论

- **入场**：观点发布日**之后**的第一个交易日收盘。绝不使用当日盘中价，
  从根上杜绝前视偏差（lookahead bias）。
- **停牌**：个股停牌顺延到复牌后第一个交易日；基准取**相同日期**，保证区间对齐。
- **超额收益** = 标的收益 − 基准收益（默认沪深300），按看多/看空取符号。
- **hit** = 方向调整后的超额收益 > 0。
- **统计严谨性**：小样本是这类产品的最大陷阱。一个"3 次全对"的大V看起来命中率 100%，
  所以报告同时给出 **Wilson 95% 置信区间**和**符号检验 p 值**。
  请优先看 Wilson 下界，不要只看命中率。

---

## 下一步

### 1. 采集源的三种形态

不同来源的抓取难度差别很大，但**形态就那么几种**。按你手上是什么来选方案：

| 形态 | 典型难度 | 要点 |
|---|---|---|
| **有公开 API / 页面可直接解析** | 低 | 直接 HTTP 抓。注意分页上限（很多接口会静默截断）与限频 |
| **只能靠真实浏览器** | 中 | 有 WAF / JS 挑战时，HTTP 客户端永远过不去（见下节）。走「浏览器执行 + 导出」 |
| **音视频（直播回放、播客）** | 中 | `m3u8 → ffmpeg 转 16k 单声道 → ASR → 热词纠错`。**音频提取不是难点，ASR 准确率才是** |
| **封闭 App / 付费社区** | 高 | 先抓包定性：WebView 套壳？裸 JSON？SSL Pinning？内容是文本还是**图片**（付费社区常见，那就是 OCR 问题） |
| **以上都不通** | — | 人工粘贴兜底，走同一条管道（`ingest/manual.py`） |

**长视频/直播的价值往往最高**：作者会把完整推理链讲出来，还会现场回答
"某个新情况怎么办"。这类素材对生成决策框架最有帮助，短帖只能给出结论。

### 为什么有时候不能用 HTTP 客户端抓

以某个有 WAF 保护的财经社区为例（`tools/diag_xueqiu.py` 可复现同类诊断）：

1. **匿名访问无效** —— 首页只发基础 cookie，接口返回错误码
2. **`document.cookie` 拿不到凭证** —— 关键 token 是 **HttpOnly**，
   浏览器禁止 JS 读取。必须从「网络 → 请求标头 → Cookie」或 **Copy as cURL** 取
3. **重放浏览器全部请求头也无效** —— 对照实验试过精确 UA、
   `sec-ch-ua` 客户端提示、全部 14 个请求头，一律被拒
4. **错误码不是「token 无效」** —— 连**故意写错的路径**和**本该公开的**接口
   都返回同一个码。它是对**所有非浏览器请求**的通用拒绝
5. **根因**：WAF 的 JS 挑战。真实浏览器会执行 JS 算出令牌，
   `requests` 永远算不出来

**所以这类源的正确通道是「浏览器执行 + 导出 + 本地导入」**：

```powershell
# 1. 在浏览器里跑 tools/xueqiu_harvest.js（文件内有详细说明）
#    会导出一个 xueqiu_0000000000.json
# 2. 导入（自动校验作者身份，不符即中止）
python run.py import-xueqiu "C:\Users\你\Downloads\xueqiu_0000000000.json" --expect-uid 0000000000 --expect-name 示例大V
```

这条路反而更干净：请求由真实浏览器发出，带着用户自己的合法会话。

> 附带发现：`/v4/statuses/user_timeline.json` 是唯一返回 **WAF 挑战页**
> 而非 JSON 错误的路径 —— 说明它被单独重点保护，反过来也印证了它是正确端点。
> 一旦雪球放松风控，`collect-xueqiu` 这条 HTTP 通道可直接启用
> （Cookie 解析、限速、断点续抓、原始 JSON 落盘都已就绪）。

**音视频 ASR 配置建议**（以 8GB 显存的笔记本显卡为例）：
`large-v3` 满血 float16 在长音频上会顶到显存上限，
用 `compute_type=int8_float16` 或 `large-v3-turbo`，
并把标的/板块词表灌进 `initial_prompt` 做热词偏置 ——
否则「半导体」「碳酸锂」「CXO」这类词会错得很离谱。

### 2. 产品侧待办

- [ ] 周期声明参与过滤（现在 short/mid/long 只记录，未用于限定评价窗口）
- [ ] LLM 抽取补召回（隐含表达、不带方向词的观点）
- [ ] 前端：Vue3 响应式 Web → 验证后再用 Capacitor 套壳成 APK
- [ ] 板块成分股（「这个板块里哪些个股被点名」）

### 3. 合规红线

个人自用 + 小圈子内测没问题。但要注意：

- 向公众提供证券投资分析/预测/建议**需要持牌**
- 行情数据商用需交易所授权，免费源仅限个人研究
- 大V内容爬取涉及平台协议、著作权；**用户自导入风险最低**
- 「小圈子」开始分发时，付费内容（订阅、充电、付费社群）的二次传播风险最高，
  这类内容不要进分享版知识库

---

## 免责声明

本工具输出的是**历史统计事实**，不构成任何投资建议，不预测未来。
`data/seed/` 下全部为**合成测试语料**，人物与观点均为虚构，仅用于验证管道正确性。
