import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ANALYSIS_STEPS } from '../lib/constants';
import type { ModelOutputEntry, RunViewState } from '../lib/workbenchSession';
import { IconAnalyze, IconChartBar, IconCheck, IconCheckCircle, IconClipboard, IconShield } from './icons';

interface Props {
  run: RunViewState;
  modelName?: string;
  /** 是否通过后端任务状态恢复（页面刷新/重进后任务仍在后台运行）。 */
  reattached?: boolean;
}

export function AnalysisProgress({ run, modelName, reattached }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const streaming = run.status === 'connecting' || run.status === 'streaming';
  const completed = run.status === 'completed';
  const displayModel = run.modelName ?? modelName ?? '正在获取模型配置';
  const modelOutputs: ModelOutputEntry[] = run.modelOutputs?.length
    ? run.modelOutputs
    : run.publicOutput.status !== 'idle'
      ? [{ channel: 'public_summary', label: '最终分析摘要', model: displayModel, text: run.publicOutput.text, status: run.publicOutput.status, sequence: Number.MAX_SAFE_INTEGER }]
      : [];
  const timelineItems = [
    ...run.logs.map((entry) => ({ kind: 'log' as const, sequence: entry.sequence, entry })),
    ...modelOutputs.map((entry) => ({ kind: 'model' as const, sequence: entry.sequence + 0.1, entry })),
  ].sort((a, b) => a.sequence - b.sequence);

  useEffect(() => {
    if (!stickToBottom || !logRef.current) return;
    logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [run.logs.length, modelOutputs.map((entry) => entry.text.length).join(','), stickToBottom]);

  const scrollToBottom = () => {
    setStickToBottom(true);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className={`card progress-card stream-analysis-card ${completed ? 'is-completed' : ''}`}>
      <div className="stream-head">
        <div className="stream-brand-icon"><IconAnalyze size={23} /></div>
        <div className="stream-head-copy">
          <h3>{completed ? 'agent思考完成' : run.status === 'failed' ? '大模型判断已中断' : 'agent正在思考>>>>'}</h3>
          <div className="stream-model-line">
            模型：AI 模式 · {displayModel}
            {run.runId && <span title={run.runId}> · Run {shortId(run.runId)}</span>}
          </div>
        </div>
        <div className={`stream-status ${statusClass(run)}`}>
          <span className="stream-status-dot" />
          {statusLabel(run)}
        </div>
      </div>

      <div className="stream-progress-row">
        <span>总体进度</span>
        <strong>{run.progress}%</strong>
      </div>
      <div className="progress-bar-track stream-progress-track">
        <div className="progress-bar-fill" style={{ width: `${run.progress}%` }} />
      </div>

      {(reattached || run.replayStatus === 'replaying') && (
        <div className="disclaimer-bar stream-notice">正在从后台任务恢复并回放真实分析轨迹…</div>
      )}
      {run.replayStatus === 'unavailable' && completed && (
        <div className="disclaimer-bar stream-notice">运行轨迹已过期，仅保留最终结构化结果。</div>
      )}

      <div className="stream-main-grid">
        <section className="stream-panel stream-timeline-panel" aria-label="分析流程">
          <div className="stream-panel-title">分析流程</div>
          <div className="stream-timeline">
            {ANALYSIS_STEPS.map((item, index) => {
              const state = completed || run.completedStages.includes(item.stage)
                ? 'done'
                : item.stage === run.activeStage ? 'active' : 'pending';
              return (
                <div className={`stream-timeline-item ${state}`} key={item.stage}>
                  <span className="stream-timeline-node">
                    {state === 'done' ? <IconCheck size={12} /> : state === 'active' ? <span className="stream-node-pulse" /> : index + 1}
                  </span>
                  <span className="stream-timeline-label">{item.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="stream-panel stream-log-panel" aria-label="实时输出日志">
          <div className="stream-panel-title stream-log-title">
            <span>实时输出日志</span>
            <span className={`stream-mini-chip ${streaming ? 'active' : ''}`}>
              {streaming ? '实时生成中' : completed ? '输出完成' : '已中断'}
            </span>
          </div>
          <div
            ref={logRef}
            className="stream-log-list"
            aria-live="polite"
            onScroll={(event) => {
              const el = event.currentTarget;
              setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 44);
            }}
          >
            {!timelineItems.length && run.replayStatus !== 'unavailable' && (
              <div className="stream-log-empty"><span className="spinner" /> 正在等待第一个分析事件…</div>
            )}
            {timelineItems.map((item, index) => item.kind === 'log' ? (
              <div className={`stream-log-entry ${item.entry.tone} ${index === timelineItems.length - 1 ? 'latest' : ''}`} key={item.entry.id}>
                <time>[{formatTime(item.entry.timestamp)}]</time>
                <span>{item.entry.text}</span>
              </div>
            ) : (
              <ModelOutput key={item.entry.channel} output={item.entry} />
            ))}
          </div>
          {!stickToBottom && (
            <button type="button" className="stream-to-bottom" onClick={scrollToBottom}>回到底部</button>
          )}
        </section>

        <section className="stream-panel stream-summary-panel" aria-label="实时分析摘要">
          <div className="stream-panel-title">实时分析摘要</div>
          <div className="stream-summary-list">
            <SummaryItem icon={<IconChartBar size={17} />} tone="blue" label="识别场景" value={run.summary.scenes.length ? run.summary.scenes.join(' / ') : '识别中…'} />
            <SummaryItem icon={<IconShield size={17} />} tone="orange" label="当前风险" value={run.summary.currentGrade ? `${run.summary.currentGrade} 级` : '--'} />
            <SummaryItem icon={<IconCheckCircle size={17} />} tone="green" label="识别置信度" value={run.summary.confidence == null ? '--' : `${Math.round(run.summary.confidence * 100)}%`} />
            <SummaryItem icon={<IconClipboard size={17} />} tone="purple" label="规则命中" value={run.summary.ruleHits == null ? '--' : `${run.summary.ruleHits} 项`} />
          </div>
        </section>
      </div>

      <div className={`stream-wave ${streaming ? 'active' : 'completed'}`} aria-hidden="true">
        {Array.from({ length: 34 }, (_, index) => <span key={index} style={{ animationDelay: `${(index % 9) * -0.08}s` }} />)}
        <i />
      </div>
      <div className={`stream-footer ${streaming ? 'active' : ''}`}>
        {streaming ? <><span className="stream-dot-grid" />模型正在持续输出判定结果，请稍候…</> : completed ? '全部分析阶段已完成，结果与运行轨迹已保留' : '分析未完成，请查看错误信息后重试'}
      </div>

      {run.fallbackReason && <div className="disclaimer-bar" style={{ marginTop: 12 }}>已切换保守降级路径：{run.fallbackReason}</div>}
    </div>
  );
}

function ModelOutput({ output }: { output: ModelOutputEntry }) {
  return (
    <div className={`stream-model-output ${output.status}`} aria-label={output.label}>
      <div className="stream-model-output-head">
        <span><IconAnalyze size={13} />{output.label}</span>
        <small>{output.status === 'streaming' ? '流式输出中' : output.status === 'completed' ? '输出完成' : '输出中断'}</small>
      </div>
      <div className="stream-model-output-body">
        {output.text || '正在等待模型输出…'}
        {output.status === 'streaming' && <i className="stream-caret" aria-hidden="true" />}
        {output.status === 'interrupted' && <em>（已保留中断前内容）</em>}
      </div>
    </div>
  );
}

function SummaryItem({ icon, tone, label, value }: { icon: ReactNode; tone: string; label: string; value: string }) {
  return (
    <div className={`stream-summary-item ${tone}`}>
      <span className="stream-summary-icon">{icon}</span>
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function statusLabel(run: RunViewState): string {
  if (run.replayStatus === 'replaying') return 'Replaying';
  if (run.status === 'completed') return 'Completed';
  if (run.status === 'failed') return 'Interrupted';
  return 'Streaming';
}

function statusClass(run: RunViewState): string {
  if (run.replayStatus === 'replaying') return 'replaying';
  return run.status;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function shortId(id: string): string {
  return id.replace(/^run_/, '').slice(0, 8);
}
