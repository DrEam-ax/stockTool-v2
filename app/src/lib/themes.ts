/**
 * 多主题换肤系统。
 *
 * 核心思路（用户提供的方案）：
 *   - UI 不写颜色，全部用语义化 CSS 变量（--accent / --bg / --fg …）
 *   - 主题 = 纯数据表，每套主题只是同一组变量名的不同色值
 *   - 切换 = 一次性 setProperty 覆盖根元素变量，不重建 DOM
 *   - 持久化到 localStorage，启动时 loadTheme()
 *
 * 变量名按"用途"命名，不按"颜色"命名——换主题时含义不变，只是值在变。
 */

export type ThemeKey = 'dark' | 'blue' | 'mint' | 'orange' | 'pink'

export interface ThemeDef {
  key: ThemeKey
  label: string
  /** 设置页色板圆点显示的主色 */
  swatch: string
  scheme: 'dark' | 'light'
  /** 语义变量 → 色值。键是简写，映射见 VAR_MAP。 */
  v: Record<string, string>
}

/** 简写 → CSS 变量名的映射 */
const VAR_MAP: Record<string, string> = {
  bg: '--bg',
  bg1: '--bg-1',
  bg2: '--bg-2',
  bg3: '--bg-3',
  line: '--line',
  fg: '--fg',
  fg2: '--fg-dim',
  fg3: '--fg-mute',
  accent: '--accent',
  accent2: '--accent-dim',
  press: '--accent-press', // 主色按钮按下态
  on: '--on-accent', // 主色底上的文字
  bar: '--tabbar-bg', // 底栏背景
  ub: '--user-border', // 用户气泡边框
  eb: '--err-border', // 错误态边框（错误气泡/工具行）
  ebg: '--err-bg', // 错误态背景
  db: '--danger-border', // 危险按钮边框
  strong: '--strong', // 气泡内强调文字
  wf: '--warn-fg',
  ef: '--err-fg',
  inf: '--info-fg',
  okf: '--ok-fg',
}

export const THEMES: ThemeDef[] = [
  {
    key: 'dark',
    label: '深空蓝',
    swatch: '#4f8cff',
    scheme: 'dark',
    v: {
      bg: '#0f1115', bg1: '#161922', bg2: '#1d212c', bg3: '#262b38',
      line: '#2a3040', fg: '#e6e8ee', fg2: '#98a1b5', fg3: '#6b7488',
      accent: '#4f8cff', accent2: '#2a4a86', press: '#3d78e0', on: '#ffffff',
      bar: 'rgba(18, 21, 28, 0.96)', ub: '#34527f',
      eb: '#5a2b2b', ebg: '#241a1c', db: '#40262a',
      strong: '#ffffff',
      wf: '#f0c684', ef: '#f0a09a', inf: '#a8c4f5', okf: '#86d9b3',
    },
  },
  {
    key: 'blue',
    label: '晨雾蓝',
    swatch: '#4f8cff',
    scheme: 'light',
    v: {
      bg: '#f5f7fb', bg1: '#ffffff', bg2: '#eef2f8', bg3: '#e4eaf3',
      line: '#dfe4ee', fg: '#1d1d1f', fg2: '#5f6b7a', fg3: '#98a1ad',
      accent: '#4f8cff', accent2: '#3a6fd8', press: '#3a6fd8', on: '#ffffff',
      bar: 'rgba(255, 255, 255, 0.96)', ub: '#4f8cff',
      eb: '#e6bcb7', ebg: '#fdf0ef', db: '#f0bcb8',
      strong: '#1d1d1f',
      wf: '#8a5a10', ef: '#b23a33', inf: '#2a63c7', okf: '#1f7a52',
    },
  },
  {
    key: 'mint',
    label: '薄荷绿',
    swatch: '#3fa97f',
    scheme: 'light',
    v: {
      bg: '#f3f8f6', bg1: '#ffffff', bg2: '#eaf2ee', bg3: '#dfebe3',
      line: '#dbe7e0', fg: '#1d1d1f', fg2: '#5c7068', fg3: '#94a69e',
      accent: '#3fa97f', accent2: '#2f8c68', press: '#2f8c68', on: '#ffffff',
      bar: 'rgba(255, 255, 255, 0.96)', ub: '#3fa97f',
      eb: '#e3c5bc', ebg: '#fbf1ee', db: '#efc9c0',
      strong: '#1d1d1f',
      wf: '#8a5a10', ef: '#b23a33', inf: '#2a63c7', okf: '#1f7a52',
    },
  },
  {
    key: 'orange',
    label: '暖橙',
    swatch: '#e8794f',
    scheme: 'light',
    v: {
      bg: '#faf6f3', bg1: '#ffffff', bg2: '#f6efe9', bg3: '#efe3da',
      line: '#e9ddd3', fg: '#1d1d1f', fg2: '#77685f', fg3: '#a29187',
      accent: '#e8794f', accent2: '#c8643e', press: '#c8643e', on: '#ffffff',
      bar: 'rgba(255, 255, 255, 0.96)', ub: '#e8794f',
      eb: '#e3c4ba', ebg: '#fbf1ed', db: '#efc5ba',
      strong: '#1d1d1f',
      wf: '#8a5a10', ef: '#b23a33', inf: '#2a63c7', okf: '#1f7a52',
    },
  },
  {
    key: 'pink',
    label: '蔷薇粉',
    swatch: '#d4769b',
    scheme: 'light',
    v: {
      bg: '#fbf5f7', bg1: '#ffffff', bg2: '#f7edf1', bg3: '#f1e2e9',
      line: '#ebdde4', fg: '#1d1d1f', fg2: '#796069', fg3: '#a48d96',
      accent: '#d4769b', accent2: '#b95e82', press: '#b95e82', on: '#ffffff',
      bar: 'rgba(255, 255, 255, 0.96)', ub: '#d4769b',
      eb: '#e3c2cb', ebg: '#fbf0f3', db: '#efc6d0',
      strong: '#1d1d1f',
      wf: '#8a5a10', ef: '#b23a33', inf: '#2a63c7', okf: '#1f7a52',
    },
  },
]

export const STORAGE_KEY = 'app_theme'
export const DEFAULT_THEME: ThemeKey = 'dark'

export function findTheme(key: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]
}

/** 切换主题：一次性覆盖根元素变量，不重建 DOM */
export function applyTheme(key: ThemeKey): void {
  const t = findTheme(key)
  const root = document.documentElement
  root.style.colorScheme = t.scheme
  for (const [short, value] of Object.entries(t.v)) {
    const name = VAR_MAP[short]
    if (name) root.style.setProperty(name, value)
  }
  root.dataset.theme = t.key
  try {
    localStorage.setItem(STORAGE_KEY, t.key)
  } catch {
    /* 隐私模式下 localStorage 可能不可写，主题仍然生效 */
  }
}

/** 当前主题 key（只读，不重复应用） */
export function currentThemeKey(): ThemeKey {
  let key: ThemeKey = DEFAULT_THEME
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && THEMES.some((t) => t.key === saved)) key = saved as ThemeKey
  } catch {
    /* 同上 */
  }
  return key
}

/** 启动时调用：恢复上次选择的主题 */
export function loadTheme(): ThemeKey {
  const key = currentThemeKey()
  applyTheme(key)
  return key
}
