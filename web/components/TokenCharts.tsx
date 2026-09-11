/** Token 柱状图与互斥构成饼图；数据只来自后端归一化 usage。 */
import type { LLMCallUsage, TokenUsageAggregate } from '../../shared/token-usage';

export function TokenCallBarChart({ calls }: { calls: LLMCallUsage[] }) {
  if (!calls.length) return <ChartEmpty />;
  const width = Math.max(680, calls.length * 104);
  const height = 292;
  const margin = { top: 24, right: 20, bottom: 54, left: 64 };
  const chartHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...calls.flatMap((call) => [call.inputTokens, call.outputTokens, call.cachedTokens]));
  const groupWidth = (width - margin.left - margin.right) / calls.length;
  const barWidth = Math.min(18, Math.max(8, (groupWidth - 18) / 3));
  const ticks = Array.from({ length: 5 }, (_, index) => Math.round((maxValue * index) / 4));
  const y = (value: number) => margin.top + chartHeight - (value / maxValue) * chartHeight;
  const series = [
    { key: 'inputTokens' as const, label: 'Input', className: 'token-input' },
    { key: 'outputTokens' as const, label: 'Output', className: 'token-output' },
    { key: 'cachedTokens' as const, label: 'Cached', className: 'token-cached' },
  ];

  return (
    <div className="token-chart-scroll">
      <svg className="token-bar-chart" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }} role="img" aria-labelledby="token-call-chart-title token-call-chart-desc">
        <title id="token-call-chart-title">按 LLM 调用对比 Token Usage</title>
        <desc id="token-call-chart-desc">每组依次展示 Input、Output 与 Cached Token；Cached 是 Input 的子集。</desc>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="token-grid-line" />
            <text x={margin.left - 10} y={y(tick) + 4} textAnchor="end" className="token-axis-label">{formatCompact(tick)}</text>
          </g>
        ))}
        <line x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + chartHeight} className="token-axis-line" />
        <line x1={margin.left} x2={width - margin.right} y1={margin.top + chartHeight} y2={margin.top + chartHeight} className="token-axis-line" />
        {calls.map((call, index) => {
          const center = margin.left + groupWidth * index + groupWidth / 2;
          return (
            <g key={call.callId}>
              {series.map((item, seriesIndex) => {
                const value = call[item.key];
                const x = center + (seriesIndex - 1) * (barWidth + 3) - barWidth / 2;
                const top = y(value);
                return (
                  <rect key={item.key} x={x} y={top} width={barWidth} height={Math.max(0, margin.top + chartHeight - top)} rx="3" className={item.className}>
                    <title>{`Call #${index + 1} · ${item.label}: ${formatNumber(value)}`}</title>
                  </rect>
                );
              })}
              <text x={center} y={height - 30} textAnchor="middle" className="token-axis-label">Call #{index + 1}</text>
              <text x={center} y={height - 13} textAnchor="middle" className="token-axis-sub">{shortRun(call.runId)}</text>
            </g>
          );
        })}
        <text x={14} y={margin.top + chartHeight / 2} textAnchor="middle" transform={`rotate(-90 14 ${margin.top + chartHeight / 2})`} className="token-axis-title">Tokens</text>
      </svg>
    </div>
  );
}

export function TokenTotalBarChart({ usage }: { usage: TokenUsageAggregate }) {
  const items = [
    { label: 'Input', value: usage.inputTokens, className: 'token-input' },
    { label: 'Output', value: usage.outputTokens, className: 'token-output' },
    { label: 'Cached', value: usage.cachedTokens, className: 'token-cached' },
  ];
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="token-total-bars" role="img" aria-label="Token 总量柱状图；Cached 是 Input 的子集">
      {items.map((item) => (
        <div className="token-total-row" key={item.label}>
          <span className="token-total-label">{item.label}</span>
          <div className="token-total-track">
            <span className={item.className} style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <strong>{item.label === 'Cached' && !usage.cacheHitRateAvailable ? '未返回' : formatNumber(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

export function TokenCompositionPie({ usage }: { usage: TokenUsageAggregate }) {
  if (!usage.cacheHitRateAvailable) {
    return <div className="token-chart-empty">Provider 未返回完整 Cached Token 明细，无法构造互斥饼图。</div>;
  }
  const parts = [
    { label: 'Uncached Input', value: usage.uncachedInputTokens, className: 'token-input' },
    { label: 'Cached Input', value: usage.cachedTokens, className: 'token-cached' },
    { label: 'Output', value: usage.outputTokens, className: 'token-output' },
  ].filter((item) => item.value > 0);
  const total = parts.reduce((sum, item) => sum + item.value, 0);
  if (!total) return <ChartEmpty />;
  let angle = -Math.PI / 2;
  const radius = 76;
  const center = 96;
  return (
    <div className="token-pie-layout">
      <svg className="token-pie" viewBox="0 0 192 192" role="img" aria-labelledby="token-pie-title token-pie-desc">
        <title id="token-pie-title">Token 互斥构成</title>
        <desc id="token-pie-desc">输入拆分为未缓存输入与缓存输入，再加输出，三部分互不重叠。</desc>
        {parts.length === 1 ? (
          <circle cx={center} cy={center} r={radius} className={parts[0].className}><title>{`${parts[0].label}: ${formatNumber(parts[0].value)}`}</title></circle>
        ) : parts.map((part) => {
          const start = angle;
          const delta = (part.value / total) * Math.PI * 2;
          angle += delta;
          return (
            <path key={part.label} d={arcPath(center, center, radius, start, angle)} className={part.className}>
              <title>{`${part.label}: ${formatNumber(part.value)} (${formatPercent(part.value / total)})`}</title>
            </path>
          );
        })}
        <circle cx={center} cy={center} r="43" className="token-pie-hole" />
        <text x={center} y={center - 3} textAnchor="middle" className="token-pie-value">{formatCompact(total)}</text>
        <text x={center} y={center + 17} textAnchor="middle" className="token-axis-sub">构成总量</text>
      </svg>
      <div className="token-legend">
        {parts.map((part) => (
          <div className="token-legend-row" key={part.label}>
            <span className={`token-legend-swatch ${part.className}`} />
            <span>{part.label}</span>
            <strong>{formatNumber(part.value)}</strong>
            <span className="muted">{formatPercent(part.value / total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartEmpty() {
  return <div className="token-chart-empty">暂无可绘制的 Provider Token Usage。</div>;
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number): string {
  const startPoint = { x: cx + radius * Math.cos(start), y: cy + radius * Math.sin(start) };
  const endPoint = { x: cx + radius * Math.cos(end), y: cy + radius * Math.sin(end) };
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} 1 ${endPoint.x} ${endPoint.y} Z`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value));
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function shortRun(runId: string): string {
  return runId.length > 10 ? `${runId.slice(4, 10)}…` : runId;
}
