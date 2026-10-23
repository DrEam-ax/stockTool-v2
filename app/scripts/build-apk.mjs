/**
 * 一键打包 Android APK。
 *
 * 做四件事，顺序不能乱：
 *   1. 同步版本号（package.json → android/version.properties + src/version.ts）
 *   2. 构建 Web 产物
 *   3. cap sync 把产物拷进 Android 工程
 *      —— 少了这步，装到手机上看到的还是旧版本
 *   4. gradlew assembleDebug，并按**真实版本号**复制到 dist/
 *
 * 版本规则（重要）：
 *   **默认只升最后一位（patch）。** 因为绝大多数改动是修 bug，
 *   而 patch 递增才能让用户一眼看出"这是新的一版"。
 *   中间位（minor）留给真正的**新增功能**，大版本（major）留给不兼容改动。
 *
 *   pnpm apk              → 最后一位 +1 再打包（默认，给用户的都用这个）
 *   pnpm apk:patch        → 同上（显式写法）
 *   pnpm apk:minor        → 中间位 +1（只有加了功能才用）
 *   pnpm apk:raw          → 不升版本，按当前版本打包（本地反复调试用）
 *   node scripts/build-apk.mjs --version 2.0.0   → 直接指定
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ROOT = resolve(APP, '..')
const ANDROID = resolve(APP, 'android')
const DIST = resolve(ROOT, 'dist')

const isWin = platform() === 'win32'

function run(cmd, args, cwd, extraEnv) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  // stdio: 'inherit' —— 不用管道，避免受限环境下 EPERM，也让输出实时可见
  //
  // **不要用 shell: true**：Node 24 会为此报 DEP0190（参数只拼接不转义），
  // 而这个警告写到 stderr 后会被 PowerShell 判成"命令失败"，
  // 于是 `pnpm ship` 里的 && 链会莫名其妙断掉 —— 明明 BUILD SUCCESSFUL。
  // Windows 上只有 .bat 需要 shell，单独用 cmd.exe /c 处理即可。
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
}

/** Windows 上跑 .bat 要走 cmd.exe；否则交给 execFileSync 直接执行 */
function runBatch(bat, args, cwd, extraEnv) {
  if (isWin) run('cmd.exe', ['/c', bat, ...args], cwd, extraEnv)
  else run(bat, args, cwd, extraEnv)
}

/** 找可用的 JDK（必须 21+ 且带 jlink，JBR 缺 jlink 不能用） */
function findJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    'D:\\Java',
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
  ].filter(Boolean)
  for (const c of candidates) {
    const jlink = resolve(c, 'bin', isWin ? 'jlink.exe' : 'jlink')
    const javac = resolve(c, 'bin', isWin ? 'javac.exe' : 'javac')
    if (existsSync(jlink) && existsSync(javac)) return c
  }
  throw new Error(
    '找不到可用的 JDK（需要 21+ 且含 jlink）。\n' +
      '注意：JetBrains 的 JBR 版本号够但没有 jlink，不能用。\n' +
      '请设置 JAVA_HOME 指向完整 JDK。',
  )
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    'D:\\Android\\Sdk',
    resolve(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(resolve(c, 'platform-tools'))) return c
  }
  throw new Error('找不到 Android SDK，请设置 ANDROID_HOME。')
}

// ---------- 0) 决定版本号 ----------
// 默认 patch：只动最后一位。理由见文件顶部。
const argv = process.argv.slice(2)
const explicitVersion = (() => {
  const i = argv.indexOf('--version')
  return i >= 0 ? argv[i + 1] : null
})()
const bumpIdx = argv.indexOf('--bump')
const bumpKind = bumpIdx >= 0 ? argv[bumpIdx + 1] : (argv.includes('--no-bump') || argv.includes('--raw') ? null : 'patch')

const pkgPath = resolve(APP, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const before = String(pkg.version)

if (explicitVersion) {
  pkg.version = explicitVersion
} else if (bumpKind) {
  if (!['patch', 'minor', 'major'].includes(bumpKind)) {
    throw new Error(`--bump 只支持 patch / minor / major，收到：${bumpKind}`)
  }
  let [ma, mi, pa] = before.split('.').map((n) => parseInt(n, 10) || 0)
  if (bumpKind === 'major') {
    ma++
    mi = 0
    pa = 0
  } else if (bumpKind === 'minor') {
    mi++
    pa = 0
  } else {
    pa++
  }
  // 版本号每段只允许一位数（0-9）：patch 到 10 就进 minor，minor 到 10 就进 major。
  // 这样 1.5.9 的下一个补丁版本是 1.6.0，而不是 1.5.10 —— 后者会出现两位数段。
  if (pa > 9) {
    pa = 0
    mi++
  }
  if (mi > 9) {
    mi = 0
    ma++
  }
  pkg.version = `${ma}.${mi}.${pa}`
}

// 兜底校验：任何一段出现两位数都直接失败，别把 1.5.12 这种写进去
{
  const segs = String(pkg.version).split('.')
  const bad = segs.find((s) => !/^\d$/.test(s))
  if (bad !== undefined) {
    throw new Error(
      `版本号每段只能是一位数字（0-9），"${pkg.version}" 不合法。` +
        `\n  提示：patch 到 10 应该进位成 minor+1、patch=0（例如 1.5.9 → 1.6.0）。`,
    )
  }
}

if (pkg.version !== before) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`\n版本：${before} → ${pkg.version}  （${explicitVersion ? '指定' : bumpKind}）`)
} else {
  console.log(`\n版本：${pkg.version}（未变）`)
}

// ---------- 1) 同步版本 ----------
run(process.execPath, [resolve(HERE, 'sync-version.mjs')], APP)

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version

// ---------- 2) 构建 Web ----------
run(process.execPath, [resolve(APP, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], APP)

// ---------- 3) 同步到 Android ----------
run(
  process.execPath,
  [resolve(APP, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'],
  APP,
)

// ---------- 4) 打包 ----------
const javaHome = findJavaHome()
const sdk = findAndroidSdk()
console.log(`\nJAVA_HOME    = ${javaHome}`)
console.log(`ANDROID_HOME = ${sdk}`)

runBatch('gradlew.bat', ['assembleDebug', '--console=plain'], ANDROID, {
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
})

// ---------- 5) 按真实版本命名并复制 ----------
const built = resolve(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
if (!existsSync(built)) throw new Error(`没找到产物：${built}`)
mkdirSync(DIST, { recursive: true })
const target = resolve(DIST, `选股助手-v${version}-debug.apk`)
copyFileSync(built, target)

console.log('\n' + '='.repeat(60))
console.log(`打包完成：${target}`)
console.log(`包内版本：versionName=${version}　（文件名与 App 内显示都取这个值）`)
console.log('='.repeat(60))
