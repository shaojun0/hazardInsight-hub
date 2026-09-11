import { useState } from 'react';
import { CONTEXT_CATEGORIES, CONTEXT_CATEGORY_META, type LLMStep } from '../../shared/context-observability';
import { ContextStack } from './ContextCharts';
import { formatTokens } from '../lib/token-format';

export function ContextBrowser({ step, loading }: { step: LLMStep; loading: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renderMode, setRenderMode] = useState<'raw' | 'markdown'>('raw');
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div className="context-browser-body">
      <div className="context-browser-metrics">
        <span>估算合计 <strong>≈{formatTokens(step.snapshot.estimatedPromptTokens)}</strong></span>
        <span>实际 prompt <strong>{step.actualPromptTokens === undefined ? '--' : formatTokens(step.actualPromptTokens)}</strong></span>
        <span>输出 <strong>{step.completionTokens === undefined ? '--' : formatTokens(step.completionTokens)}</strong></span>
        {loading && <span className="muted">正在加载原文…</span>}
      </div>
      <ContextStack step={step} />
      <div className="context-browser-tools"><button className={renderMode === 'raw' ? 'active' : ''} onClick={() => setRenderMode('raw')}>原文</button><button className={renderMode === 'markdown' ? 'active' : ''} onClick={() => setRenderMode('markdown')}>Markdown</button></div>
      <div className="context-category-list">
        {CONTEXT_CATEGORIES.map((category) => {
          const stats = step.snapshot.categories[category];
          const diff = step.diff.categories[category];
          const categoryOpen = open.has(category);
          const items = step.snapshot.items.filter((item) => item.category === category);
          return <section className="context-category" key={category}>
            <button className="context-category-head" onClick={() => toggle(category)} aria-expanded={categoryOpen}>
              <i style={{ background: CONTEXT_CATEGORY_META[category].color }} />
              <strong>{CONTEXT_CATEGORY_META[category].label}</strong>
              <span>{stats.itemCount}项</span>
              <span className={diff.itemCountDelta >= 0 ? 'delta-up' : 'delta-down'}>{signed(diff.itemCountDelta)}项 / {signed(diff.tokenDelta)} tokens</span>
              <b>≈{formatTokens(stats.estimatedTokens)} · {(stats.percentage * 100).toFixed(0)}%</b>
            </button>
            {categoryOpen && <div className="context-items">{items.length === 0 ? <div className="context-empty-row">本 Step 未发送该类内容</div> : items.map((item) => {
              const itemOpen = open.has(item.id);
              return <article className="context-item" key={item.id}>
                <button onClick={() => toggle(item.id)}><span>{item.label}</span><small>{item.sourceType}{item.sourceId ? ` · ${item.sourceId}` : ''}</small><b>≈{formatTokens(item.estimatedTokens)}</b></button>
                {itemOpen && <pre className={renderMode === 'markdown' ? 'is-markdown' : ''}>{item.content === undefined ? '原文未加载' : serialize(item.content)}</pre>}
              </article>;
            })}</div>}
          </section>;
        })}
      </div>
    </div>
  );
}

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
function serialize(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
