/** 生成短 id。不用 crypto.randomUUID 是为了兼容老 WebView。 */
export function uid(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  const t = Date.now().toString(36)
  return `${prefix}${t}${rnd}`
}

export function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(off) / 60))
  const om = pad(Math.abs(off) % 60)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  )
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

export function fmtPct(v?: number | null, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

export function fmtSignedPct(v?: number | null, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = (v * 100).toFixed(digits)
  return v > 0 ? `+${s}%` : `${s}%`
}

export function fmtMoney(v?: number | null, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtBytes(n?: number | null): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function relTime(iso?: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return iso.slice(0, 10)
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,%\s]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 极简 Markdown 渲染：只支持标题/粗体/列表/代码/换行，够聊天用 */
export function renderMarkdown(src: string): string {
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const lines = esc.split('\n')
  const out: string[] = []
  let inList = false
  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const lvl = Math.min(h[1].length + 2, 6)
      out.push(`<h${lvl}>${h[2]}</h${lvl}>`)
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${li[1]}</li>`)
      continue
    }
    closeList()
    if (line.trim() === '') {
      out.push('<div class="md-gap"></div>')
    } else {
      out.push(`<p>${line}</p>`)
    }
  }
  closeList()
  return out.join('')
}
