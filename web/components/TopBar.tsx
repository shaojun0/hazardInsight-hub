import { useEffect, useRef, useState } from 'react';
import type { ThemeId } from '../lib/theme';
import { IconHardHat, IconPalette } from './icons';
import { ThemePopoverList } from './ThemeSwitcher';

export interface TopBarProps {
  modelName: string;
  theme: ThemeId;
  onPickTheme: (id: ThemeId) => void;
}

export function TopBar({ modelName, theme, onPickTheme }: TopBarProps) {
  const [themeOpen, setThemeOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setThemeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThemeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeOpen]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-logo">
          <IconHardHat size={21} />
        </div>
        <div>
          <div className="brand-name">核电工程隐患智能识别与定级系统</div>
          <div className="brand-sub">Nuclear Power Engineering Hazard Identification & Grading</div>
        </div>
      </div>
      <div className="spacer" />
      <div className="topbar-right">
        <span className="mode-chip ai">
          <span className="dot" />
          {modelName ? `AI 模式 · ${modelName}` : 'AI 模式'}
        </span>
        <div className="theme-trigger" ref={popRef}>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setThemeOpen((v) => !v)}
            title="切换颜色主题"
            aria-label="切换颜色主题"
          >
            <IconPalette size={14} />
            主题
          </button>
          {themeOpen && <ThemePopoverList value={theme} onPick={(id) => onPickTheme(id)} />}
        </div>
      </div>
    </header>
  );
}
