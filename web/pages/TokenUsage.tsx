/** Agent 上下文与 Usage Ledger：数据只来自 Runtime telemetry，不从 UI 消息反推。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CONTEXT_CATEGORIES, CONTEXT_CATEGORY_META, type AgentContextSummary, type LLMStep } from '../../shared/context-observability';
import type { TokenUsageOverview } from '../../shared/token-usage';
import { fetchContextObservability, fetchContextStep, fetchTokenUsageOverview } from '../api/token-usage';
import { ApiError } from '../api/client';
import { ContextBrowser } from '../components/ContextBrowser';
import { ContextStack, ContextTrendChart } from '../components/ContextCharts';
import { IconAlert, IconChartBar, IconRefresh } from '../components/icons';
import { formatTokens } from '../lib/token-format';

export function TokenUsagePage() {
  const [context, setContext] = useState<Awaited<ReturnType<typeof fetchContextObservability>> | null>(null);
  const [usage, setUsage] = useState<TokenUsageOverview | null>(null);
  const [agentId, setAgentId] = useState('master');
  const [selectedStepId, setSelectedStepId] = useState('');
  const [stepDetail, setStepDetail] = useState<LLMStep | null>(null);
  const [trendMode, setTrendMode] = useState<'step' | 'turn'>('step');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [contextData, usageData] = await Promise.all([fetchContextObservability(signal), fetchTokenUsageOverview(signal)]);
      setContext(contextData);
      setUsage(usageData);
      const firstAgent = contextData.agents.find((item) => item.agentId === agentId) ?? contextData.agents[0];
      if (firstAgent) {
        setAgentId(firstAgent.agentId);
        setSelectedStepId((current) => current && firstAgent.steps.some((step) => step.stepId === current) ? current : firstAgent.currentStepId ?? '');
      }
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof ApiError ? reason.message : String((reason as Error).message ?? reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const agent = useMemo(() => context?.agents.find((item) => item.agentId === agentId) ?? context?.agents[0] ?? null, [context, agentId]);
  const selectedSummary = agent?.steps.find((step) => step.stepId === selectedStepId) ?? agent?.steps.at(-1) ?? null;

  useEffect(() => {
    if (!selectedSummary) {
      setStepDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetchContextStep(selectedSummary.stepId, controller.signal)
      .then(setStepDetail)
      .catch(() => setStepDetail(selectedSummary))
      .finally(() => setDetailLoading(false));
    return () => controller.abort();
  }, [selectedSummary?.stepId]);

  const current = agent?.steps.find((step) => step.stepId === agent.currentStepId) ?? agent?.steps.at(-1) ?? null;
  const browserStep = stepDetail?.stepId === selectedSummary?.stepId ? stepDetail : selectedSummary;

  return <div className="page token-page context-page">
    <div className="page-head token-page-head">
      <div><h1>上下文统计</h1><div className="sub">逐次还原真实 LLM 请求上下文；Context Snapshot 与累计 Usage Ledger 分开统计。</div></div>
      <button className="btn btn-outline" onClick={() => void load()} disabled={loading}><IconRefresh size={14} />刷新</button>
    </div>
    {error && <div className="disclaimer-bar" role="alert"><IconAlert size={15} />{error}</div>}
    {loading && !context && <div className="card card-pad"><div className="state-block"><span className="spinner" /><p>正在读取 Agent Context Trace…</p></div></div>}
    {!loading && context && context.agents.length === 0 && <Empty />}
    {context && agent && <>
      <div className="context-toolbar card">
        <label>Agent<select className="select" value={agent.agentId} onChange={(event) => { setAgentId(event.target.value); setSelectedStepId(''); }}><option value={agent.agentId}>{agent.name}</option>{context.agents.filter((item) => item.agentId !== agent.agentId).map((item) => <option key={item.agentId} value={item.agentId}>{item.name}</option>)}</select></label>
        <span className="mono">Session {context.sessionId}</span><span className="mono">Conversation {context.conversationId}</span>
      </div>

      <section className="card context-stats">
        <div className="token-section-head"><div><h2>上下文统计</h2><span>统计所选 Agent 当前保留的历史窗口；累计消耗见页面底部。</span></div></div>
        <div className="context-stat-grid">
          <Stat label="轮次" value={String(agent.stats.turnCount)} /><Stat label="步数" value={String(agent.stats.stepCount)} /><Stat label="注入" value={String(agent.stats.injectionCount)} /><Stat label="压缩" value={String(agent.stats.compressionCount)} /><Stat label="剪枝" value={String(agent.stats.pruningCount)} /><Stat label="图片" value={String(agent.stats.imageCount)} /><Stat label="缓存命中" value={agent.stats.cacheHitRate === undefined ? '--' : `${(agent.stats.cacheHitRate * 100).toFixed(2)}%`} /><Stat label="预计费用" value={agent.stats.estimatedCost === undefined ? '--' : `${agent.stats.costCurrency ?? ''}${agent.stats.estimatedCost.toFixed(4)}`} />
        </div>
      </section>

      {current && <section className="card context-current">
        <div className="token-section-head"><div><h2>当前构成</h2><span>{current.model} · {current.provider} · 第{current.turnIndex}轮第{current.stepIndex}步</span></div><div className="context-window-value"><strong>{formatTokens(current.actualPromptTokens ?? current.snapshot.estimatedPromptTokens)}</strong> / {current.snapshot.contextWindow ? formatTokens(current.snapshot.contextWindow) : '--'} tokens <b>{usageRatio(current)}</b></div></div>
        <div className="context-current-body"><ContextStack step={current} /><div className="context-category-grid">{CONTEXT_CATEGORIES.map((category) => { const item = current.snapshot.categories[category]; return <div key={category}><i style={{ background: CONTEXT_CATEGORY_META[category].color }} /><span>{CONTEXT_CATEGORY_META[category].label}<small>{item.itemCount}项</small></span><strong>≈{formatTokens(item.estimatedTokens)}</strong><b>{(item.percentage * 100).toFixed(0)}%</b></div>; })}</div><div className="context-estimate-note">分类估算合计 ≈{formatTokens(current.snapshot.estimatedPromptTokens)}；实际 prompt {current.actualPromptTokens === undefined ? '--' : formatTokens(current.actualPromptTokens)}。Provider 实际值不会反向缩放分类。</div>{current.snapshot.categories.tool_definition.itemCount === 0 && <div className="context-estimate-note">工具定义 Top：当前 Provider 请求未发送原生 tools/functions schema。</div>}</div>
      </section>}

      <section className="card context-history">
        <div className="token-section-head"><div><h2>历史趋势</h2><span>柱高为每个 Snapshot 的分类估算；轮次视图取该轮最后一个有效 Step。</span></div><div className="token-segments"><button className={trendMode === 'step' ? 'active' : ''} onClick={() => setTrendMode('step')}>步骤</button><button className={trendMode === 'turn' ? 'active' : ''} onClick={() => setTrendMode('turn')}>轮次</button></div></div>
        <div className="context-legend">{CONTEXT_CATEGORIES.map((category) => <span key={category}><i style={{ background: CONTEXT_CATEGORY_META[category].color }} />{CONTEXT_CATEGORY_META[category].label}</span>)}</div><ContextTrendChart steps={agent.steps} mode={trendMode} />
      </section>

      {browserStep && <section className="card context-browser">
        <div className="token-section-head"><div><h2>上下文浏览器</h2><span>选择任意历史 Step，原文按需加载；Diff 对比同一 Agent 的前一个 Step。</span></div><select className="select context-step-select" value={browserStep.stepId} onChange={(event) => { setSelectedStepId(event.target.value); setStepDetail(null); }}>{[...agent.steps].reverse().map((step) => <option key={step.stepId} value={step.stepId}>第 {step.turnIndex} 轮 · 第 {step.stepIndex} 步 · {time(step.startedAt)} · {step.phase}</option>)}</select></div>
        <ContextBrowser key={browserStep.stepId} step={browserStep} loading={detailLoading} />
      </section>}

      <UsageLedger agent={agent} usage={usage} />
    </>}
  </div>;
}

function UsageLedger({ agent, usage }: { agent: AgentContextSummary; usage: TokenUsageOverview | null }) {
  return <section className="card context-ledger"><div className="token-section-head"><div><h2>累计 Usage Ledger</h2><span>每行对应一个 Provider request invocation；与“当前上下文大小”不是同一指标。</span></div><strong>Input {formatTokens(agent.stats.cumulativePromptTokens)} · Output {formatTokens(agent.stats.cumulativeCompletionTokens)}{usage ? ` · ${usage.session.llmCallCount} logical calls` : ''}</strong></div><div className="context-ledger-list">{agent.steps.map((step) => <div key={step.stepId}><b>Step #{step.stepIndex}</b><span>{step.phase}</span><span>{step.model}</span><span>Input {step.actualPromptTokens === undefined ? '--' : formatTokens(step.actualPromptTokens)}</span><span>Output {step.completionTokens === undefined ? '--' : formatTokens(step.completionTokens)}</span><span>Cached {step.cachedTokensAvailable ? formatTokens(step.cacheReadTokens ?? 0) : '--'}</span><span>{step.latencyMs === undefined ? '--' : `${step.latencyMs}ms`}</span><em className={step.status}>{step.status}</em></div>)}</div></section>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function usageRatio(step: LLMStep): string { if (!step.snapshot.contextWindow) return '-- 上下文已用'; const used = step.actualPromptTokens ?? step.snapshot.estimatedPromptTokens; return `${Math.round(used / step.snapshot.contextWindow * 100)}% 上下文已用`; }
function time(value: string): string { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }
function Empty() { return <div className="card card-pad"><div className="state-block"><div className="big-ico"><IconChartBar size={28} /></div><h3>当前 Session 暂无 LLM Step</h3><p>请先运行一次图片分析。系统不会用 UI 消息或字符数伪造实际 Provider usage。</p></div></div>; }
