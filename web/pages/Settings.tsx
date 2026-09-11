import type { ThemeId } from '../lib/theme';
import { GRADE_DEFINITIONS } from '../../shared/grading-meta';
import { ThemeCardGrid } from '../components/ThemeSwitcher';
import { IconPalette, IconZap } from '../components/icons';

export function Settings({ theme, onPickTheme }: { theme: ThemeId; onPickTheme: (id: ThemeId) => void }) {
  return (
    <div className="page">
      <div className="page-head">
        <h1>系统设置</h1>
        <div className="sub">颜色主题、模型环境变量与 A/B/C/D 定级规则说明。</div>
      </div>

      <div className="settings-grid">
        {/* 颜色主题 + 环境变量 */}
        <div className="stack">
          <div className="card card-pad">
            <div className="section-label">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconPalette size={14} /> 颜色主题（白 / 淡蓝为主 · Apple 风格）
              </span>
            </div>
            <ThemeCardGrid value={theme} onPick={onPickTheme} />
          </div>

          <div className="card card-pad">
            <div className="section-label">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconZap size={14} /> 环境变量（.env，作为默认配置）
              </span>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 2.1 }}>
              <div style={{ color: 'var(--text-3)' }}># 识别前请在「模型配置」页面或 .env 中配置真实模型</div>
              <div>MULTIMODAL_API_BASE_URL=https://api.xxx.com/v1</div>
              <div>MULTIMODAL_API_KEY=sk-xxx</div>
              <div>MULTIMODAL_MODEL=vision-model</div>
              <div style={{ color: 'var(--text-3)' }}>PORT=3001</div>
            </div>
          </div>
        </div>

        <div className="card card-pad">
          <div className="section-label">A/B/C/D 隐患分级规则</div>
          {(['A', 'B', 'C', 'D'] as const).map((g) => (
            <div style={{ marginBottom: 12 }} key={g}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`grade-badge grade-${g}`} style={{ height: 22 }}>
                  <span className="flag" />
                  {g} 级
                </span>
                <b>{GRADE_DEFINITIONS[g].label}</b>
              </div>
              <div className="small muted" style={{ marginTop: 4, lineHeight: 1.7 }}>{GRADE_DEFINITIONS[g].rule}</div>
            </div>
          ))}
          <div className="small muted">定级辅助：风险值 = 严重度(1-5) × 可能性(1-5)，并结合法规要求、历史案例等级与现场危险状态综合判定。</div>
        </div>
      </div>
    </div>
  );
}
