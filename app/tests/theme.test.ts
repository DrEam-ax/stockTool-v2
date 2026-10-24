/**
 * 多主题换肤系统（src/lib/themes.ts）的行为测试。
 *
 * 语义（用户约定 + 方案思路）：
 *   - 主题 = 纯数据表，每套主题覆盖同一组语义变量，键必须完整
 *   - applyTheme 一次性 setProperty 覆盖根元素变量，不重建 DOM
 *   - 选择持久化到 localStorage，重启后 loadTheme 恢复
 *   - 无效 key 一律回退默认主题
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME,
  STORAGE_KEY,
  THEMES,
  applyTheme,
  currentThemeKey,
  findTheme,
  loadTheme,
} from '@/lib/themes'

/** 以第一套主题的变量键作为"完整变量集"的基准 */
const FULL_KEYS = Object.keys(THEMES[0].v)

/** 抽查的关键变量映射（覆盖代表性简写键 → CSS 变量名） */
const KEY_SAMPLES: Array<[string, string]> = [
  ['bg', '--bg'],
  ['accent', '--accent'],
  ['on', '--on-accent'],
  ['bar', '--tabbar-bg'],
  ['ebg', '--err-bg'],
  ['strong', '--strong'],
]

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.colorScheme = ''
})

describe('THEMES 数据完整性', () => {
  it('主题表非空且包含默认主题 dark', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(5)
    expect(THEMES.some((t) => t.key === DEFAULT_THEME)).toBe(true)
  })

  it('每套主题都包含完整变量集，且元信息齐全', () => {
    expect(FULL_KEYS.length).toBeGreaterThan(0)
    for (const t of THEMES) {
      expect(Object.keys(t.v).sort()).toEqual([...FULL_KEYS].sort())
      expect(t.label).toBeTruthy()
      expect(t.swatch).toBeTruthy()
      expect(['dark', 'light']).toContain(t.scheme)
    }
  })

  it('主题 key 唯一', () => {
    const keys = THEMES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('findTheme', () => {
  it('有效 key 命中对应主题', () => {
    expect(findTheme('pink')?.key).toBe('pink')
  })

  it('无效 key / null / undefined 回退第一套主题', () => {
    expect(findTheme('nope')).toBe(THEMES[0])
    expect(findTheme(null)).toBe(THEMES[0])
    expect(findTheme(undefined)).toBe(THEMES[0])
  })
})

describe('applyTheme', () => {
  it('一次性覆盖根元素全部变量（setProperty 调用数 = 变量数）', () => {
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty')
    const t = THEMES.find((x) => x.key === 'mint')!

    applyTheme('mint')

    expect(setProperty).toHaveBeenCalledTimes(Object.keys(t.v).length)
    for (const [short, name] of KEY_SAMPLES) {
      expect(setProperty).toHaveBeenCalledWith(name, t.v[short])
    }
  })

  it('设置 colorScheme 与 data-theme', () => {
    applyTheme('blue')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('blue')

    applyTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('持久化到 localStorage', () => {
    applyTheme('orange')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('orange')
  })

  it('无效 key 回退第一套并持久化其 key', () => {
    applyTheme('whatever' as never)
    expect(document.documentElement.dataset.theme).toBe(THEMES[0].key)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(THEMES[0].key)
  })
})

describe('currentThemeKey', () => {
  it('无记录 → 默认主题', () => {
    expect(currentThemeKey()).toBe(DEFAULT_THEME)
  })

  it('有合法记录 → 返回该主题', () => {
    localStorage.setItem(STORAGE_KEY, 'pink')
    expect(currentThemeKey()).toBe('pink')
  })

  it('有非法记录 → 回退默认主题', () => {
    localStorage.setItem(STORAGE_KEY, 'neon')
    expect(currentThemeKey()).toBe(DEFAULT_THEME)
  })
})

describe('loadTheme', () => {
  it('恢复上次选择并应用', () => {
    localStorage.setItem(STORAGE_KEY, 'orange')
    const key = loadTheme()

    expect(key).toBe('orange')
    expect(document.documentElement.dataset.theme).toBe('orange')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('orange')
  })

  it('无记录 → 默认主题（不写入垃圾记录）', () => {
    const key = loadTheme()
    expect(key).toBe(DEFAULT_THEME)
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(DEFAULT_THEME)
  })
})
