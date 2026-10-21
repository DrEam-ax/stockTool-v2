# Android 打包

## 为什么一定要打包

**CORS 是浏览器的限制，不是接口的限制。**

这个 App 的「AI 自己调用工具」能力依赖行情、基金持仓、联网新闻等接口。
这些接口**都不返回 `Access-Control-Allow-Origin`**，所以在浏览器里
`fetch` 会被直接拦掉——不是代码写错了，是浏览器不让。

打包成 App 后，`CapacitorHttp` 会 **patch `window.fetch` 走原生 HTTP**，
原生层根本没有同源策略，所有工具立刻可用。

| 环境 | 行情/联网工具 | 说明 |
|---|---|---|
| 浏览器 `pnpm dev` | ❌ 不可用 | 会明确报 CORS，不静默失败 |
| **打包后的 App** | ✅ 全部可用 | 走原生 HTTP |

---

## 前置条件

| 项 | 要求 | 本机状态 |
|---|---|---|
| **JDK** | **21 或更高**（Capacitor 8 / AGP 8.14 要求源码级别 21） | 见下方「JDK 的坑」 |
| Android SDK | platforms 36、build-tools 35+ | `D:\Android\Sdk` |
| Gradle | 由 wrapper 自动下载 | 8.14.3 |

`compileSdk` / `targetSdk` = 36，`minSdk` = 24（Android 7.0+）。

### JDK 的坑（踩了两次，务必看）

要同时满足**两个**条件，缺一不可：

1. **版本 ≥ 21** —— Capacitor 8 / AGP 把源码级别设成了 21
2. **必须是完整 JDK（要有 `jlink`）** —— AGP 的 `JdkImageTransform` 会调用它

本机踩坑记录：

| 路径 | 版本 | jlink | 结果 |
|---|---|---|---|
| `C:\...\Microsoft\jdk-17.0.10.7-hotspot` | 17 | — | ✗ `错误: 无效的源发行版：21` |
| `D:\Ideaiu for Java\IntelliJ IDEA 2025.2.1\jbr` | 21.0.8 | **缺** | ✗ `jlink executable does not exist` |
| `D:\pycharm\PyCharm 2025.2.0.1\jbr` | 21.0.7 | **缺** | 同上 |
| **`D:\Java`** | **23.0.2** | **✓** | **✅ BUILD SUCCESSFUL** |

**两个陷阱：**

- `java -version` 显示 23 是**假的**。PATH 上是 Oracle 的 `javapath` 垫片，
  和 `JAVA_HOME` 不是一回事，**Gradle 只认 `JAVA_HOME`**。
- **JetBrains 的 JBR 版本号够（21）但不能用**，它是精简版，没有 `jlink`。
  这个坑不看报错信息根本想不到。

> 现在用的是 `D:\Java`（Oracle JDK 23）。AGP 没报不兼容，构建正常。
> 若日后换环境，装个独立的 JDK 21（[Temurin](https://adoptium.net/) /
> [Microsoft OpenJDK](https://learn.microsoft.com/java/openjdk/download)）最稳妥。

---

## 构建

**先读这段（踩过的坑）**：以前我改 APK **文件名**（v1.0 / v1.1 / v1.2…）
却忘了改 `build.gradle`，结果**文件名写着 v1.3、包内 versionName 还是 1.0**。
装到手机上系统显示的是**包内**版本号，所以怎么装都是 1.0、根本分不清。
而且 `versionCode` 一直是 1，系统会认为它们**就是同一个版本**。

**现在只有一个版本源：`package.json` 的 `version`。** 其余全部自动推导：

```
package.json  version: "1.3.1"
      │  scripts/sync-version.mjs
      ├─→ android/version.properties   versionCode=10301 / versionName=1.3.1
      │        （Gradle 从这里读，不再写死）
      └─→ src/version.ts               App 设置页顶部显示 v1.3.1
```

`versionCode` 编码规则：`major*10000 + minor*100 + patch`（单调递增，Android 靠它判断"是不是新版本"）。

### 版本怎么升（`1.5.1` 三位数字）

| 位置 | 什么时候动 | 例子 |
|---|---|---|
| **最后一位 patch** | **修 bug（绝大多数情况）** | 1.5.1 → 1.5.2 |
| 中间位 minor | 真正**新增功能** | 1.5.1 → 1.6.0 |
| 第一位 major | 不兼容的大改 | 1.5.1 → 2.0.0 |

**踩过的坑**：我一开始把两个纯修 bug 的版本按中间位发成了 `1.4.0`、`1.5.0`，
用户看到的是版本号跳跃、不是预期的"最后一位 +1"，反而更难分辨。

**所以 `pnpm apk` 现在默认就只升最后一位**，让默认行为不可能出错：

```powershell
pnpm apk          # 最后一位 +1 再打包 ← 给用户的都用这个
pnpm apk:patch    # 同上（显式写法）
pnpm apk:minor    # 中间位 +1（只有加了功能才用）
pnpm apk:raw      # 不升版本（本地反复调试，避免版本号被灌水）
```

`scripts/build-apk.mjs` 会依次做：升版本 → 同步版本 → 构建 Web →
`cap sync` → `gradlew assembleDebug` → 按**真实版本号**复制到 `dist/`。
它会自动找 `JAVA_HOME` / `ANDROID_HOME`，不用每次手设。

### 手动构建（需要时）

```powershell
$env:ANDROID_HOME     = "D:\Android\Sdk"
$env:ANDROID_SDK_ROOT = "D:\Android\Sdk"
$env:JAVA_HOME        = "D:\Java"     # 完整 JDK 21+（有 jlink）
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

node scripts/sync-version.mjs
pnpm build
pnpm exec cap sync android
cd android
.\gradlew.bat assembleDebug
```

产物：`dist\选股助手-v<版本>-debug.apk`

**顺序很重要**：`cap sync` 会把 `dist/` 拷进 `android/app/src/main/assets/public/`。
只跑 `gradlew` 不跑 `cap sync`，装到手机上看到的还是旧前端。

### 怎么确认装的是哪一版

两个地方都能看，而且**必然一致**（同一个源）：

1. **App 内 → 设置页最顶部**：
   「选股助手 v1.3.1 · 构建于 2026-10-09 · versionCode 10301」
2. **命令行**：
   ```powershell
   D:\Android\Sdk\build-tools\36.0.0\aapt2.exe dump badging `
     android\app\build\outputs\apk\debug\app-debug.apk | Select-String "^package"
   ```

---

## 装到手机

**方式一：数据线（推荐）**
```powershell
# 手机开「开发者选项 → USB 调试」，插上后：
D:\Android\Sdk\platform-tools\adb.exe install -r app\build\outputs\apk\debug\app-debug.apk
```

**方式二：直接传 APK**
把 `app-debug.apk` 拷到手机，用文件管理器点开安装
（需要允许「安装未知来源应用」）。

---

## 已知限制

1. **流式输出会退化成整段返回。**
   原生 HTTP 不提供可读流，SSE 拿不到 `res.body`。
   `services/llm.ts` 里做了兼容：检测不到可读流就把整段当 SSE 解析，
   **结果一样**，只是回答一次性出现而不是逐字蹦。

2. **debug 包未签名，不能上架**，仅供自己和朋友安装。
   要正式分发需要生成 keystore 并打 release 包。

3. **网络权限**已由 Capacitor 模板自动加上（`INTERNET`）。

4. **`minSdk 24`** 意味着 Android 7.0 以下装不了。若需要更低，
   改 `android/variables.gradle` 的 `minSdkVersion`——但
   Capacitor 8 官方最低支持到 23，再低会有兼容风险。

---

## 改了代码之后

| 改了什么 | 要做什么 |
|---|---|
| 前端 `.vue` / `.ts` | `pnpm apk`（自动升最后一位 + build + sync + 打包） |
| `capacitor.config.ts` | `pnpm apk` |
| `android/` 里的原生代码 | `cd android; .\gradlew.bat assembleDebug` |
| 依赖（`package.json`） | `pnpm install` → `pnpm apk` |
| 加了新功能要发版 | `pnpm apk:minor`（只有这种情况才动中间位） |

**调试技巧**：`chrome://inspect` 可以连上手机 WebView 看 console，
和调网页一模一样。前提是 App 是 debug 包。
