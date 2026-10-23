/**
 * 极简静态服务器：给「用真实 Vue 复现输入框自增高」的测试页用。
 *
 * 为什么需要：file:// 下 ES module 会被 CORS 拦掉，
 * 而测试页必须 `import { ref, watch } from 'vue'` 才能复现
 * v-model + @input + watch 的真实时序。
 *
 * 用法：node tools/serve-for-test.mjs [端口]
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.argv[2] || 5399)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0])
    // 防目录穿越
    const rel = normalize(url).replace(/^([/\\])+/, '')
    const path = join(ROOT, rel)
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const buf = await readFile(path)
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/`)
})
