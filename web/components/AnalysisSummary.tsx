import type { AnalysisResult } from '../../shared/types';
import { GRADE_META } from '../lib/constants';
import { IconDownload, IconInfo, IconRefresh, IconSave } from './icons';

interface Props {
  result: AnalysisResult;
  onReAnalyze: () => void;
  onExport: () => void;
  onSave: () => void;
}

export function AnalysisSummary({ result, onReAnalyze, onExport, onSave }: Props) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const h of result.hazards) counts[h.grade] += 1;
  const overall = result.overallRisk ? `${result.overallRisk} 级` : '未定级';

  return (
    <div className="card summary-card">
      <div className="summary-grid">
        <div className="sum-cell key">
          <div className="num">{result.hazards.length}</div>
          <div className="lbl">发现隐患</div>
        </div>
        <div className="sum-divider" />
        {(['A', 'B', 'C', 'D'] as const).map((g) => (
          <div className="sum-cell" key={g}>
            <div className="num" style={{ color: GRADE_META[g].color }}>
              {counts[g]}
            </div>
            <div className="lbl">{g} 级</div>
          </div>
        ))}
        <div className="sum-divider" />
        <div className="sum-cell risk">
          <div className="num">{overall}</div>
          <div className="lbl">综合风险等级</div>
        </div>
        <div className="sum-cell">
          <div className="num">{result.stats.standardsCited}</div>
          <div className="lbl">引用标准</div>
        </div>
        <div className="sum-cell">
          <div className="num">{result.stats.casesCited}</div>
          <div className="lbl">历史案例</div>
        </div>
      </div>
      <div className="sum-actions">
        <span className="chip">
          <IconInfo size={13} />
          AI 分析完成 · {new Date(result.createdAt).toLocaleTimeString('zh-CN')}
        </span>
        {result.agentMeta && (
          <span className="chip" title={result.agentMeta.runId}>
            Run {shortId(result.agentMeta.runId)} · {result.agentMeta.durationMs}ms
          </span>
        )}
        {result.agentMeta?.fallbackUsed && <span className="chip" style={{ color: 'var(--warn)' }}>保守降级</span>}
        {result.needManualReview && <span className="chip" style={{ color: 'var(--danger)' }}>需人工复核</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-outline btn-sm" onClick={onReAnalyze}>
          <IconRefresh size={13} />
          重新识别
        </button>
        <button className="btn btn-primary-soft btn-sm" onClick={onExport}>
          <IconDownload size={13} />
          导出报告
        </button>
        <button className="btn btn-primary btn-sm" onClick={onSave}>
          <IconSave size={13} />
          保存结果
        </button>
      </div>
    </div>
  );
}

function shortId(id: string): string {
  return id.replace(/^run_/, '').slice(0, 8);
}
