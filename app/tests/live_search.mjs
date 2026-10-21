/**
 * 内置免密搜索的**真实端点验证**。
 *
 * 为什么单独做这个：单元测试只能验证「函数不报错」，
 * 验证不了「我写的正则/JSONP 拆壳能不能真的解析线上响应」。
 * 一旦东财或必应改了页面结构，单元测试照样全绿，线上却全空。
 *
 * 用法：node tests/live_search.mjs
 * 需要联网。失败不代表代码错（可能只是网络不通），但**成功很有意义**。
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const H = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseJsonp(text) {
  const t = text.trim()
  const m = /^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(t)
  return JSON.parse(m ? m[1] : t)
}

let fail = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    fail++
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

async function eastmoneyNews(query, max) {
  const param = {
    uid: '', keyword: query, type: ['cmsArticleWebOld'],
    client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: max, preTag: '', postTag: '' } },
  }
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + encodeURIComponent(JSON.stringify(param))
  const res = await fetch(url, { headers: { ...H, Referer: 'https://so.eastmoney.com/' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = parseJsonp(await res.text())
  return (data.result?.cmsArticleWebOld ?? []).map((r) => ({
    title: stripTags(r.title ?? ''), url: r.url ?? '',
    snippet: stripTags(r.content ?? ''), published: r.date,
  }))
}

async function bing(query, max) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${max}&setlang=zh-CN`
  const res = await fetch(url, { headers: { ...H, Accept: 'text/html,application/xhtml+xml' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const out = []
  for (const block of html.split(/<li class="b_algo"/i).slice(1)) {
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? ''
    out.push({ title: stripTags(a[2]), url: a[1], snippet: stripTags(snip) })
    if (out.length >= max) break
  }
  return out
}

async function announcements(code, max) {
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann' +
    `?sr=-1&page_size=${max}&page_index=1&ann_type=A&client_source=web&stock_list=${code}`
  const res = await fetch(url, { headers: { ...H, Referer: 'https://data.eastmoney.com/' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.data?.list ?? []
}

console.log('=== 1) 东财财经新闻搜索 ===')
try {
  const hits = await eastmoneyNews('碳酸锂 价格', 5)
  check('解析出结果', hits.length > 0, String(hits.length))
  check('标题非空', hits.every((h) => h.title.length > 0))
  check('带发布时间', hits.some((h) => /^\d{4}-\d{2}-\d{2}/.test(h.published ?? '')))
  check('带可点链接', hits.every((h) => /^https?:\/\//.test(h.url)), JSON.stringify(hits[0]))
  if (hits[0]) console.log(`     例：${hits[0].published} ${hits[0].title.slice(0, 50)}`)
} catch (e) {
  check('东财新闻可用', false, e.message)
}

console.log('\n=== 2) 必应中国 ===')
try {
  const hits = await bing('碳酸锂 最新价格', 5)
  check('解析出结果', hits.length > 0, String(hits.length))
  check('标题非空', hits.every((h) => h.title.length > 0))
  check('链接有效', hits.every((h) => /^https?:\/\//.test(h.url)))
  if (hits[0]) console.log(`     例：${hits[0].title.slice(0, 50)} → ${hits[0].url.slice(0, 50)}`)
} catch (e) {
  check('必应可用', false, e.message)
}

console.log('\n=== 3) 个股公告 ===')
try {
  const list = await announcements('600519', 5)
  check('解析出公告', list.length > 0, String(list.length))
  check('有标题', list.every((r) => (r.title ?? '').length > 0))
  check('有日期', list.some((r) => /^\d{4}-\d{2}-\d{2}/.test(r.notice_date ?? '')))
  if (list[0]) console.log(`     例：${(list[0].notice_date ?? '').slice(0, 10)} ${list[0].title.slice(0, 50)}`)
} catch (e) {
  check('公告接口可用', false, e.message)
}

console.log('\n' + '='.repeat(56))
if (fail) {
  console.log(`失败 ${fail} 项 —— 解析器可能已与实际响应不匹配，需更新`)
  process.exit(1)
}
console.log('全部通过：三个免密源在真实响应上都解析成功')
