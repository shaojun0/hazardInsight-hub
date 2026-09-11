import { CONTEXT_CATEGORIES, CONTEXT_CATEGORY_META, type LLMStep } from '../../shared/context-observability';
import { formatTokens } from '../lib/token-format';

export function ContextStack({ step }: { step: LLMStep }) {
  const total = Math.max(1, step.snapshot.estimatedPromptTokens);
  return (
    <div className="context-stack" role="img" aria-label="当前上下文六类估算 Token 构成">
      {CONTEXT_CATEGORIES.map((category) => {
        const value = step.snapshot.categories[category].estimatedTokens;
        return value > 0 ? <span key={category} style={{ width: `${(value / total) * 100}%`, background: CONTEXT_CATEGORY_META[category].color }} title={`${CONTEXT_CATEGORY_META[category].label} ≈${formatTokens(value)}`} /> : null;
      })}
    </div>
  );
}

export function ContextTrendChart({ steps, mode }: { steps: LLMStep[]; mode: 'step' | 'turn' }) {
  const points = mode === 'step' ? steps : lastStepPerTurn(steps);
  if (!points.length) return <div className="token-chart-empty">暂无 LLM Step。</div>;
  const width = Math.max(720, points.length * 86);
  const height = 260;
  const chartHeight = 190;
  const baseline = 215;
  const max = Math.max(1, ...points.map((step) => step.snapshot.estimatedPromptTokens));
  const slot = (width - 70) / points.length;
  const barWidth = Math.min(42, slot * 0.62);
  return (
    <div className="token-chart-scroll">
      <svg className="context-trend" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }} role="img" aria-label="上下文历史趋势">
        {[0, .25, .5, .75, 1].map((ratio) => {
          const y = baseline - chartHeight * ratio;
          return <g key={ratio}><line x1="55" x2={width - 10} y1={y} y2={y} className="token-grid-line" /><text x="48" y={y + 4} textAnchor="end" className="token-axis-label">{formatTokens(max * ratio)}</text></g>;
        })}
        {points.map((step, index) => {
          const x = 60 + index * slot + (slot - barWidth) / 2;
          let y = baseline;
          const title = `第${step.turnIndex}轮 · 第${step.stepIndex}步\n估算 ≈${formatTokens(step.snapshot.estimatedPromptTokens)}\n实际 prompt ${step.actualPromptTokens === undefined ? '--' : formatTokens(step.actualPromptTokens)}\n输出 ${step.completionTokens === undefined ? '--' : formatTokens(step.completionTokens)}`;
          return <g key={step.stepId}><title>{title}</title>{CONTEXT_CATEGORIES.map((category) => {
            const value = step.snapshot.categories[category].estimatedTokens;
            const h = (value / max) * chartHeight;
            y -= h;
            return h > 0 ? <rect key={category} x={x} y={y} width={barWidth} height={h} fill={CONTEXT_CATEGORY_META[category].color} /> : null;
          })}<text x={x + barWidth / 2} y="238" textAnchor="middle" className="token-axis-sub">{mode === 'step' ? `S${step.stepIndex}` : `T${step.turnIndex}`}</text></g>;
        })}
      </svg>
    </div>
  );
}

function lastStepPerTurn(steps: LLMStep[]): LLMStep[] {
  const byTurn = new Map<number, LLMStep>();
  for (const step of steps) byTurn.set(step.turnIndex, step);
  return [...byTurn.values()];
}
