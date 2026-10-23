/**
 * 真实浏览器里验证「输入框随内容变高」。
 *
 * 为什么必须有这个脚本：
 *   jsdom 没有布局引擎，scrollHeight 恒为 0。用 Object.defineProperty 打桩后
 *   断言 style.height 被赋值过，只能证明「代码被调用」，**证明不了框子会变高**。
 *   之前就是靠这种假测试交付的，用户在真机上直接发现没生效。
 *   所以关键布局行为必须拿真浏览器量。
 *
 * 做法：用 Edge/Chrome 的 headless 模式打开测试页，页面自己测量并把结果
 *       写进 DOM，这里 --dump-dom 取回来断言。
 *
 * 跑法：node tools/run_composer_layout_test.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = resolve(HERE, 'composer-layout-test.html')
const MAX_H = 130

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

function findBrowser() {
  for (const p of BROWSERS) {
    if (existsSync(p)) return p
  }
  return null
}

function run() {
  if (!existsSync(PAGE)) {
    console.error(`找不到测试页：${PAGE}`)
    process.exit(1)
  }
  const browser = findBrowser()
  if (!browser) {
    // 明确说「没验证」，不要让人误以为这条过了
    console.log('⚠ 跳过：本机没找到 Chrome/Edge，输入框自增高**未**做真实浏览器验证')
    process.exit(0)
  }

  const profile = mkdtempSync(join(tmpdir(), 'composer-layout-'))
  let dom = ''
  try {
    dom = execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=3000',
        '--window-size=412,900',
        '--dump-dom',
        `file:///${PAGE.replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }

  const m = /RESULT_JSON:(\[[\s\S]*?\])/.exec(dom)
  if (!m) {
    console.error('页面没有返回测量结果')
    console.error(dom.slice(0, 1200))
    process.exit(1)
  }
  const rows = JSON.parse(m[1])

  console.log('真实浏览器测量结果（412px 宽）')
  console.log('阶段'.padEnd(16) + '实际高 scrollingH 可滚动 光标可见')
  let failures = 0
  const check = (ok, msg) => {
    if (!ok) {
      failures += 1
      console.log(`  ✗ ${msg}`)
    }
  }

  let prev = 0
  for (const r of rows) {
    console.log(
      String(r.tag).padEnd(16) +
        String(r.rectHeight).padStart(6) +
        String(r.scrollHeight).padStart(10) +
        String(r.scrollable).padStart(8) +
        '   ' +
        (r.caretVisible ? '是' : '否'),
    )
    check(r.rectHeight <= MAX_H + 0.5, `${r.tag} 高度 ${r.rectHeight} 超过上限 ${MAX_H}`)
    check(r.caretVisible, `${r.tag} 光标行不可见`)
    // 没到上限时不该有滚动量（否则最后一行被切）
    if (r.rectHeight < MAX_H - 0.5) {
      check(r.scrollable === 0, `${r.tag} 未封顶却还有 ${r.scrollable}px 滚动量，最后一行会被切`)
    } else {
      check(
        r.scrollTop >= r.scrollable - 1,
        `${r.tag} 封顶后没有顶到底（scrollTop=${r.scrollTop}, 可滚=${r.scrollable}）`,
      )
    }
    if (r.tag !== '初始') {
      check(r.rectHeight >= prev, `${r.tag} 高度没有随内容增加`)
    }
    prev = r.rectHeight
  }

  console.log()
  if (failures) {
    console.log(`✗ ${failures} 项不通过`)
    process.exit(1)
  }
  console.log('✓ 全部通过：随内容变高、封顶不超、最后一行与光标始终可见')
}

run()
