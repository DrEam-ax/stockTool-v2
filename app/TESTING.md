# 测试与交付

## 为什么有这个文件

这个项目曾经连续几个版本把 bug 交给用户发现。复盘下来，
**根因不是"没写测试"，而是测试写在了错误的层次**：

| 那一版测了什么 | 为什么没拦住 bug |
|---|---|
| 函数返回值对不对 | 用户报的 bug **函数返回值全都正常** |
| 提示词拼得对不对 | 界面坏了跟提示词无关 |
| 知识库能不能解析 | 解析成功，但**渲染出来是空的** |

具体踩过的坑（全都被用户先发现了）：

| 现象 | 真正原因 | 哪一层能拦住 |
|---|---|---|
| 填完 API Key，点任意复选框就没了 | 输入框绑了 `v-model`，WebView 重渲染时回写成空 | DOM 交互测试 |
| 点保存没反应 | `db.put` 把 Vue 的 reactive 对象（Proxy）交给 IndexedDB，抛 `DataCloneError`，而 `onSave` 没有 try/catch | 含 IndexedDB 的交互测试 |
| 拉不到模型列表 | 上一条的连带：key 丢了 → 401 → 被误报成"服务不提供接口" | DOM 交互测试 |
| 识别出的持仓看不见 | `.check input` 是后代选择器，特异性与 `input[type=text]` 相同但写在后面，把文本输入框压成 16×16 | 渲染 + CSS 选择器测试 |
| 点输入框会误触复选框 | `<label class="check">` 里套了 7 个控件，HTML 规定点 label 会激活第一个 | 标签结构测试 |
| 装机永远显示 1.0 | 只改了 APK 文件名，没改 `build.gradle` 的 `versionName` | 构建产物元信息断言 |

**共同点：坏在渲染、样式、异步副作用、构建元信息上 —— 全都不在"函数返回什么"这一层。**

---

## 测试分层

| 层 | 命令 | 覆盖 | 数量 |
|---|---|---|---|
| 类型 | `pnpm typecheck` | TypeScript / Vue SFC | — |
| 逻辑 | `pnpm test` | 抽取、KB 往返、提示词组装、三种模式、版本一致性、IndexedDB Proxy | 127 项断言 |
| **DOM/组件** | `pnpm test:dom` | **渲染、交互流程、标签结构、CSS 选择器** | **38 项** |
| 联网 | `pnpm test:live` | 三个免密源对**真实响应**的解析 | 3 源 |
| Python | `python tests/test_*.py` | 抽取、雪球 cookie/dump、KB 往返 | 113 项断言 |

### DOM 层都测了什么

```
tests/dom.test.ts      持仓核对卡片：值真的渲染出来 / 复选框不误触 / 样式没泄漏
tests/views.test.ts    五个页面都能打开、空数据不白屏、不出现 undefined/NaN
                       （并断言没有 Vue warn —— 未捕获的渲染异常最难发现）
tests/settings.test.ts 填 Key → 点各种复选框 → Key 还在 → 保存 → 真的进列表
                       空 Key 保存要有可见提示
                       只存在于 DOM（粘贴没触发 input）也要能存下来
tests/flows.test.ts    载入真实 .stkb → 显示内容 → 点详情 → 决策框架渲染
                       损坏文件明确报错
                       建会话三种模式，模式真的存对了
```

---

## 交付闸门

**给用户的包必须由这一条命令产出：**

```powershell
cd D:\dsh-stockTool\app
pnpm ship          # typecheck → 逻辑测试 → DOM 测试 → 打包（自动升最后一位版本号）
pnpm ship:minor    # 加了新功能时才用（升中间位）
```

`pnpm ship` 用 `&&` 串联，**任何一层测试失败就不会产出 APK**。

### 为什么不用 shell: true

`scripts/build-apk.mjs` 里刻意用 `shell: false` + 显式 `cmd.exe /c` 调 `.bat`。
Node 24 对 `shell: true` 会报 `DEP0190`，那个警告写到 stderr 后
**会被 PowerShell 判成"命令失败"**，导致 `pnpm ship` 的 `&&` 链莫名断掉
—— 而 Gradle 明明打印了 `BUILD SUCCESSFUL`。

---

## 版本号

**只有一个源：`package.json` 的 `version`。** 其余全部推导：

```
package.json  version: "1.5.4"
      │  scripts/sync-version.mjs
      ├─→ android/version.properties   versionCode=10504 / versionName=1.5.4
      └─→ src/version.ts               App 设置页顶部显示 v1.5.4
```

| 位置 | 什么时候动 | 例子 |
|---|---|---|
| **最后一位** | **修 bug（绝大多数情况）** | 1.5.4 → 1.5.5 |
| 中间位 | 真正新增功能 | 1.5.4 → 1.6.0 |
| 第一位 | 不兼容的大改 | 1.5.4 → 2.0.0 |

`versionCode` 编码 `major*10000 + minor*100 + patch`，必须单调递增，
否则 Android 会拒绝覆盖安装。

**怎么确认装的是哪一版**：App 内 → 设置页最顶部（与 `aapt2 dump badging` 必然一致）。

---

## 写测试时的两个坑（自己踩过）

1. **`wrapper.html()` 不会序列化 `<input>` 的 value。**
   value 是 DOM 属性不是 HTML 属性。要用 `.element.value` 断言 ——
   一开始用 `html()` 查，误报失败，差点以为数据没绑上。

2. **IndexedDB 回调不是微任务，`flushPromises()` 刷不掉。**
   断言会跑在写入之前，误判成"保存没生效"。要用轮询式 `waitFor()`。

顺带：`fake-indexeddb` 的 `deleteDatabase` 在连接未关闭时会挂死
（App 的 `openDb` 缓存连接且永不 close），所以用例隔离靠 `db.clear()`，不靠删库。
