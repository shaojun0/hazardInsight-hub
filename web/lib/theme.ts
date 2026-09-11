/**
 * 主题系统：多套颜色主题（Apple 风格：白色 / 淡蓝为主，附加深色模式）。
 * 通过 html[data-theme] 切换 CSS 变量，选择持久化到 localStorage。
 */
export type ThemeId = 'blue' | 'ocean' | 'graphite' | 'energy' | 'midnight';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  desc: string;
  /** 主题色板（用于选择器展示：主色 / 辅助色 / 底色） */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  { id: 'blue', label: '经典蓝', desc: 'Apple 系统蓝，白底淡蓝，默认主题', swatch: ['#0071e3', '#d4e8ff', '#f5f7fa'] },
  { id: 'ocean', label: '海洋青', desc: '科技青蓝，清爽冷静', swatch: ['#00a6d6', '#c9ecf7', '#eef8fb'] },
  { id: 'graphite', label: '石墨灰', desc: '冷灰配蓝，理性专业', swatch: ['#5b6b8c', '#e3e8ef', '#f6f7f9'] },
  { id: 'energy', label: '能量绿', desc: '绿蓝能量，清新进取', swatch: ['#0d9b8a', '#cdeeea', '#f2faf8'] },
  { id: 'midnight', label: '深空(深色)', desc: 'Apple 深色模式，夜间护眼', swatch: ['#0a84ff', '#2c3340', '#16181d'] },
];

export const DEFAULT_THEME: ThemeId = 'blue';

const KEY = 'hazard.theme.v1';

export function getTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(KEY) as ThemeId | null;
    if (stored && THEMES.some((t) => t.id === stored)) return stored;
  } catch {
    /* noop */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* noop */
  }
  applyTheme(id);
}
