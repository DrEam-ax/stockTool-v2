# stockTool 协作日志（COLLAB LOG）

> 本文件是**多个 AI 接力协作**的同步机制。任何接手本项目的 AI（包括我自己）都必须遵守下面的规则。

---

## 使用规则（每个接手工作的 AI 必读）

1. **每次开始任务前，必须先读本文件**：确认上一个 AI 做了什么、当前基线是什么、有什么待办或坑。
2. **开工前先 `git status`**：如果看到自己没动过的未提交改动，说明另一位正在干活 ——
   **不要覆盖、不要 `git checkout --`**，先提交它或先问项目所有者。
   同理，**每完成一小步就提交**，别攒成一个大改动，否则没法判断冲突。
3. **每次完成任务后，必须在「变更日志」最顶部追加一条记录**（倒序，最新在最上）。记录要写清楚：
   - 改了什么 / 为什么改
   - 涉及哪些文件
   - 怎么验证的（跑了什么测试 / 命令，结果如何）
   - 遗留问题或下一步建议
4. **如果本文件不存在或没有上一条 AI 的记录**：先探查项目当前状态（`git log`、`README.md`、目录结构、`git status`），把探查到的基线补写进文档，再动手。
5. **只记录真实发生的事**：不编造改动；没做的验证要写明"未验证"。
6. **发现别人记错了就订正它**，并在条目里注明「原先记为 X，实际 Y」——不要默默改掉。
7. 记录用中文；条目格式见「变更日志」示例。

---

## 当前基线（2026-10-23 更新）

- **Git HEAD**：`0630a8d`（修复「推荐问题回答中断」：轮数被工具吃光，2026-10-23 21:24 提交，main 分支，工作区干净）
- **App 版本**：1.6.8（versionCode 10608，来源 `app/package.json`，由 `scripts/sync-version.mjs` 同步到 `app/src/version.ts` 与 `app/android/version.properties`）
- **本地最新构建产物**：`dist/选股助手-v1.6.8-debug.apk`（4.04 MB，21:24 生成，与源码版本一致）
  - 注：AI-A 最初记为 v1.6.7，实际是 v1.6.8，已由 AI-B 核对订正。

### 项目一句话

把大V的公开语料提炼成「可迁移的决策框架」（persona），用真实行情回测出历史超额收益，打包成 `.stkb` 知识库，由 Vue3 + Capacitor 的 App 加载，App 内的 AI Agent 带工具（知识库检索 / 实时行情 / 基金持仓 / 联网搜索）回答用户问题。**App 是引擎，知识库是内容**，不荐股、不预测。

### 关键目录速览

| 路径 | 内容 |
|---|---|
| `src/stocktool/` | Python 数据管线（stdlib + requests）：`ingest/` 采集、`extract/`（`persona.py`★核心、`audit.py`）、`market/` 多源行情、`backtest/` 回测、`kb/` .stkb 知识库、`report/` 报告 |
| `app/` | Vue 3 + Vite + Capacitor 安卓 App，本地 IndexedDB 无后端；`src/services/`（`agent.ts`★Agent 循环、`prompt.ts`、`persona.ts`、`audit.ts`、`tools/`）、`src/views/` 4 个页面 |
| `config/` | 词典、板块映射、**真实凭据（gitignore，不入库）** |
| `data/` | `stocktool.db`（51MB）、`raw/`（雪球/B站语料）、`kb/`（demo_* 合成 + luo_* 真实人物，后者 gitignore）、`seed/` 合成语料 |
| `docs/kb-format.md` | .stkb 格式规范 |
| `tools/` | B站采集/ASR、雪球诊断、审计工具等 |

### 常用命令

```powershell
python run.py pipeline            # Python 管线一键全流程
python run.py status              # 数据概况
python run.py kb-export out.stkb --author <名字> --policy evidence_only
cd app; pnpm test / typecheck / build / ship   # App 测试·类型检查·构建·打包 APK
```

### 已知待办（README「下一步」）

- [ ] 周期声明参与过滤（short/mid/long 目前只记录，未用于限定评价窗口）
- [ ] LLM 抽取补召回（隐含表达、不带方向词的观点）
- [ ] 板块成分股（「这个板块里哪些个股被点名」）
- [ ] 行情数据在 App 联网时自行重算

### 踩坑红线（改动时别踩回去）

1. 回测入场：观点发布日**之后**第一个交易日收盘，防前视偏差
2. 判定不能对 50%：随机基线命中率实测 44%/45%/43%（T+5/20/60）
3. 周期必须匹配风格（左侧+长期持有型要看 T+250）
4. 重复发帖必须去重（实测重复率约两成）
5. 6 位代码跨市场撞车 → 全面用 **secid** 做主键
6. 行情多源故障转移（腾讯 → 新浪 → 东财），东财密集翻页会封 IP

---

## 变更日志

### 2026-10-23 21:30 · 接手 + 基线校正 + 补录「用户约定」与「未解决问题」（AI-B）

**先做的事**：读本文件 → 核对基线 → 发现一处与实际不符并已订正（`dist` 里是 v1.6.8，不是 v1.6.7）。

**今天这一轮形成的提交（`git log` 可见，此处只补"为什么"）**：

| 提交 | 内容 | 起因 |
|---|---|---|
| `dee9575` | 会话 tab 记住上次会话；统计卡与卡片间距 | 用户：从别的模块点回「会话」被踢回列表；「板块分布」和统计卡贴在一起 |
| `6df88c6` | 定投加「每日」 | 用户要求 |
| `e29239a` | 输入框随内容变高 | 用户参照微信输入框提出 |
| `aff7b50` | 自增高加 `watch(input)` 第二道触发 | 真机仍不生效 |
| `bff51ce` | 版本号改「每段一位数字」（1.5.12 → 1.6.2） | 用户：某一段不能超过一位数 |
| `560e6e9` | 自增高：`field-sizing: content` + `compositionend` + rAF/setTimeout | 用户反馈「打字不变高、删字却正常」，定位到输入法组合态 |
| `8fe3786` | 修「读取网页失败：跨域」——**真因是 Android 9+ 禁止明文 HTTP** | 工具轨 8ms 失败，`usesCleartextTraffic` 缺失 |
| `39d7f8b` | 自增高加「聚焦期间每 150ms 定时校验」（不依赖事件） | 事件层已加无可加，真机仍失败 |
| `b787c13` | 放开推荐 + 联网需授权 + 新工具 `check_holdings` | 用户：军师没法推荐板块/基金，但要求联网先征得同意、基金名有偏移要核对持仓 |
| `9ee0dbe` | 修「点顶部开关会清空输入框文字」 | 组合态下 v-model 失同步 + 重渲染覆盖 DOM |
| `0630a8d` | 修「推荐问题回答中断」 | 轮数被 14 次工具调用吃光，收尾返回空 |

**必须传递给下一位的约定（用户明确要求，不在代码里，最容易漏）**：

1. **推送规则**：用户说「每次更新 App 都要推 GitHub；如果是让你去爬数据/找资料，就别推送」。
   - App 代码/测试改动 → 提交并推送 `origin main`（`https://github.com/DrEam-ax/stockTool-v2`）
   - 纯采集/数据任务 → 只做本地，不推
2. **推送前必须跑闸门**：`python tools/prepush_check.py`
   - 查三类：不该进库的文件、内容里的敏感词、真实凭据内容
   - 敏感词清单在 `tools/.prepush-forbidden.txt`（**已 gitignore，只在本机**）
   - 绕不过去的原因见下一条
3. **仓库是公开的，这几样永远不能推**：`config/llm_api_key.txt`、`config/xueqiu_cookie*.txt`、`config/bilibili_cookie*.txt`、`config/settings.json`、`data/stocktool.db`、`data/raw/`、`data/kb/luo_*.stkb`
   - 真实人物知识库含姓名/UID/语料统计，公开会出事（历史上有过一次差点推出，靠闸门拦住）
4. **版本号规则**：`major.minor.patch`，**每段只能一位数字**。patch 到 10 进位 minor（1.5.9 → 1.6.0）。写了两位数段 `build-apk.mjs` / `sync-version.mjs` 会直接抛错。
5. **交付闸门**：`cd app; pnpm ship` = typecheck + 逻辑测试 + DOM 测试 + **真实浏览器布局测试** + 打包。测试不过不出包。
6. **自增高/输入框相关改动必须过** `pnpm test:layout`（用真实 Edge/Chrome headless 量 `scrollHeight`/`clientHeight`，jsdom 没有布局引擎，打桩测试只能证明"代码被调用过"，**证明不了会不会变高**——这个坑踩过）。

**未解决 / 需谨慎的问题（别再重复踩）**：

1. **输入框自增高在真机上仍未由用户确认成功**。
   - 现有三层兜底：`field-sizing: content`（CSS 原生）+ `input`/`compositionend` 事件 + rAF + setTimeout + **聚焦期间每 150ms 定时校验**（不依赖任何事件）。
   - 桌面 Chromium 实测正常（41→62→130 封顶，光标可见），但**桌面无法复现 Android WebView 的重排推迟**。
   - 用户最后一次反馈（v1.6.5 前后）仍失败。**下一个接手的人：先向用户确认版本号和现象，不要盲目再改**。
   - 若仍失败，需用户提供：设置页版本号截图 + 打三行字后输入框近景截图（区分"高度没算对"和"被 CSS 压住"）。
2. **`v-model` + 中文输入法组合态是同一个坑的三个变种**，已出现三次：
   - 发送按钮点不动（状态空 → 按钮禁用）
   - 输入框不变高（组合态重排推迟）
   - 点开关丢文字（重渲染用空状态覆盖 DOM）
   - 通用对策：**任何涉及输入框的交互，状态都要能从 DOM 兜底**，别只信 `v-model`。
3. **上下文膨胀**：一次「自己查行情再推荐」实测 12.5 万 prompt token（每轮重发全部工具结果）。已把 `maxRounds` 6→9、`check_holdings` 改批量，但**工具返回内容长度尚未压缩**，是下一步优化点。

**下一步建议**：
- 压工具返回内容的长度（搜索每次 10 条全量回灌，是 token 大头）
- 待办清单见上方「已知待办」

---

### 2026-10-23 · 建立协作日志 + 项目摸底（AI-A）

- **做了什么**：应项目所有者要求建立本协作日志；此前完整摸底了项目（本地代码 + GitHub 仓库 `DrEam-ax/stockTool-v2` 对照，两者一致）。
- **代码改动**：无（仅新增本文件 `COLLAB_LOG.md`）。
- **摸底结论**：见上方「当前基线」。管道已跑通、App 可用；本地含真实人物知识库 `data/kb/luo_*.stkb` 与 51MB `stocktool.db`（均 gitignore，不入公库）。
- **验证**：`git log`、`git status`（工作区干净）、读取 README / run.py / requirements.txt / app README 与核心目录结构。
- **遗留**：`dist/` 中 APK 为 v1.6.7，落后于源码 1.6.8，下次打包会由 `pnpm ship` 自动升版。
