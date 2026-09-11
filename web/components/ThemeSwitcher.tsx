import { THEMES, type ThemeId } from '../lib/theme';
import { IconCheck } from './icons';

export function ThemeCardGrid({ value, onPick }: { value: ThemeId; onPick: (id: ThemeId) => void }) {
  return (
    <div className="theme-grid">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={`theme-card ${value === t.id ? 'active' : ''}`}
          onClick={() => onPick(t.id)}
          title={t.desc}
        >
          <div className="swatches">
            {t.swatch.map((c, i) => (
              <span key={i} className="swatch-dot" style={{ background: c }} />
            ))}
            {value === t.id && (
              <span style={{ marginLeft: 'auto', color: 'var(--primary)', display: 'flex', alignItems: 'center' }}>
                <IconCheck size={14} />
              </span>
            )}
          </div>
          <div className="t-label">{t.label}</div>
          <div className="t-desc">{t.desc}</div>
        </button>
      ))}
    </div>
  );
}

export function ThemePopoverList({ value, onPick }: { value: ThemeId; onPick: (id: ThemeId) => void }) {
  return (
    <div className="theme-switch-pop">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={`theme-option ${value === t.id ? 'active' : ''}`}
          onClick={() => onPick(t.id)}
        >
          <span className="swatches">
            {t.swatch.map((c, i) => (
              <span key={i} className="swatch-dot" style={{ background: c }} />
            ))}
          </span>
          <span className="theme-meta">
            <span className="t-label">{t.label}</span>
            <span className="t-desc" style={{ display: 'block' }}>{t.desc}</span>
          </span>
          {value === t.id && <IconCheck size={14} />}
        </button>
      ))}
    </div>
  );
}
