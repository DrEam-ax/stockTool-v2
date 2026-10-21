/**
 * .stkb 知识库解析（规范见 docs/kb-format.md）。
 *
 * 在浏览器里做，所以必须：
 *   · 不信任输入 —— 第三方产出的库可能是坏的，宁可明确报错也不静默降级
 *   · 建好派生索引 —— 提问时不能全表扫
 */

import { unzipSync, strFromU8 } from 'fflate'
import type {
  KbAuthor,
  KbDocument,
  KbEvaluation,
  KbInstrument,
  KbManifest,
  KbOpinion,
  KnowledgeBase,
} from '@/types'
import { uid } from '@/lib/fmt'

export const SUPPORTED_MAJOR = '1'
const REQUIRED = ['manifest.json', 'author.json', 'instruments.jsonl', 'opinions.jsonl']

export interface ParseResult {
  kb: KnowledgeBase
  warnings: string[]
}

export class KbParseError extends Error {
  constructor(
    message: string,
    readonly kind: 'notzip' | 'missing' | 'format' | 'version' | 'content' = 'content',
  ) {
    super(message)
    this.name = 'KbParseError'
  }
}

function parseJsonl<T>(text: string): T[] {
  const out: T[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch (e) {
      throw new KbParseError(
        `JSONL 第 ${i + 1} 行解析失败：${(e as Error).message}`,
        'content',
      )
    }
  }
  return out
}

export function parseKbBytes(buf: Uint8Array, sizeBytes?: number): ParseResult {
  const warnings: string[] = []

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buf)
  } catch {
    throw new KbParseError(
      '这不是有效的知识库文件（应为 .stkb / zip）。',
      'notzip',
    )
  }

  const has = (n: string) => Object.prototype.hasOwnProperty.call(files, n)
  const missing = REQUIRED.filter((n) => !has(n))
  if (missing.length) {
    throw new KbParseError(`缺少必需文件：${missing.join(', ')}`, 'missing')
  }

  const text = (n: string) => (has(n) ? strFromU8(files[n]) : '')

  let manifest: KbManifest
  try {
    manifest = JSON.parse(text('manifest.json')) as KbManifest
  } catch {
    throw new KbParseError('manifest.json 不是合法 JSON', 'format')
  }
  if (manifest.kb_format !== 'stocktool-kb') {
    throw new KbParseError(
      `不是 StockTool 知识库（kb_format=${manifest.kb_format}）`,
      'format',
    )
  }
  const major = String(manifest.format_version || '').split('.')[0]
  if (major !== SUPPORTED_MAJOR) {
    throw new KbParseError(
      `知识库格式主版本为 ${manifest.format_version}，本 App 只支持 ${SUPPORTED_MAJOR}.x。\n` +
        '请升级 App，或让制作者导出兼容版本。',
      'version',
    )
  }

  let author: KbAuthor
  try {
    author = JSON.parse(text('author.json')) as KbAuthor
  } catch {
    throw new KbParseError('author.json 不是合法 JSON', 'format')
  }

  const instruments = parseJsonl<KbInstrument>(text('instruments.jsonl'))
  const opinions = parseJsonl<KbOpinion>(text('opinions.jsonl'))
  const evaluations = has('evaluations.jsonl')
    ? parseJsonl<KbEvaluation>(text('evaluations.jsonl'))
    : []
  const documents = has('documents.jsonl')
    ? parseJsonl<KbDocument>(text('documents.jsonl'))
    : []

  if (!evaluations.length) {
    warnings.push('该知识库不含回测结果，App 无法离线显示历史命中率')
  }
  if (manifest.content_policy === 'evidence_only' && documents.length) {
    warnings.push('声明为 evidence_only 却带了原文，已忽略原文以尊重其内容策略')
    documents.length = 0
  }
  if (manifest.content_policy === 'full_text' && !documents.length) {
    warnings.push('声明为 full_text 但没有原文')
  }

  // ---- 索引 ----
  const instrumentIndex: Record<string, KbInstrument> = {}
  const nameIndex: Record<string, string> = {}
  for (const it of instruments) {
    if (!it?.secid) continue
    instrumentIndex[it.secid] = it
    if (it.name && it.name.length >= 2) nameIndex[it.name] = it.secid
    for (const a of it.aliases ?? []) {
      if (a && a.length >= 2) nameIndex[a] = it.secid
    }
  }

  const evalIndex: Record<string, KbEvaluation[]> = {}
  for (const e of evaluations) {
    if (!e?.opinion_id) continue
    ;(evalIndex[e.opinion_id] ||= []).push(e)
  }

  // ---- 引用完整性（坏库要明确报错，不要带病运行）----
  let orphan = 0
  for (const o of opinions) {
    const secid = o?.subject?.secid
    if (secid && !instrumentIndex[secid]) orphan++
  }
  if (orphan) {
    throw new KbParseError(
      `有 ${orphan} 条观点引用了未声明的标的，知识库不完整。`,
      'content',
    )
  }

  const kb: KnowledgeBase = {
    id: uid('kb_'),
    manifest,
    author,
    instruments,
    opinions,
    documents,
    instrumentIndex,
    nameIndex,
    evalIndex,
    importedAt: new Date().toISOString(),
    enabled: true,
    sizeBytes: sizeBytes ?? buf.byteLength,
  }
  return { kb, warnings }
}

export async function parseKbFile(file: File): Promise<ParseResult> {
  const buf = new Uint8Array(await file.arrayBuffer())
  return parseKbBytes(buf, file.size)
}

/** 从问题文本里找出提到了哪些标的（最长匹配） */
export function matchSubjects(kb: KnowledgeBase, text: string): string[] {
  const found = new Set<string>()
  const n = text.length
  const maxLen = Math.min(
    10,
    Object.keys(kb.nameIndex).reduce((m, k) => Math.max(m, k.length), 2),
  )
  let i = 0
  while (i < n) {
    let hit: string | null = null
    for (let len = Math.min(maxLen, n - i); len >= 2; len--) {
      const secid = kb.nameIndex[text.slice(i, i + len)]
      if (secid) {
        hit = secid
        i += len
        break
      }
    }
    if (hit) found.add(hit)
    else i++
  }
  return [...found]
}

/** 知识库的确定性问题：用于设置页/详情页展示 */
export function describeKb(kb: KnowledgeBase) {
  const m = kb.manifest
  const civil = m.content_policy === 'full_text' ? '含原文' : '仅观点'
  const src = m.sources?.[0]
  return {
    title: m.title || kb.author?.name || '未命名知识库',
    author: kb.author?.name || '未知',
    source: src?.source || kb.author?.source || '',
    period:
      src?.period?.first && src?.period?.last
        ? `${src.period.first} ~ ${src.period.last}`
        : '',
    docCount: src?.doc_count ?? m.counts?.documents ?? 0,
    opinionCount: kb.opinions.length,
    instrumentCount: kb.instruments.length,
    policy: civil,
    extractor: m.extractor?.mode || '未知',
    version: m.format_version,
  }
}
