import { useState } from 'react';
import type { Grade } from '../../shared/types';
import { GradeBadge } from '../components/GradeBadge';
import { IconDownload, IconEye, IconHistory, IconTrash } from '../components/icons';
import { postExportReport } from '../api/analysis';
import { loadRecords, removeRecord, saveLastResult, type SavedRecord } from '../lib/storage';

export function Records({ onOpenRecord }: { onOpenRecord: () => void }) {
  const [records, setRecords] = useState<SavedRecord[]>(() => loadRecords());

  function remove(id: string) {
    setRecords(removeRecord(id));
  }

  function open(rec: SavedRecord) {
    saveLastResult(rec.analysis, rec.image ?? null);
    onOpenRecord();
  }

  async function exportOne(rec: SavedRecord) {
    try {
      const { html } = await postExportReport(rec.analysis);
      const win = window.open('', '_blank');
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
      }
    } catch {
      /* 忽略导出错误 */
    }
  }

  function gradeOf(overall: string | null): Grade {
    if (overall) {
      const g = overall.trim().charAt(0);
      if (['A', 'B', 'C', 'D'].includes(g)) return g as Grade;
    }
    return 'D';
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>隐患记录</h1>
        <div className="sub">已保存的分析结果（本地浏览器存储，最多保留 30 条）。</div>
      </div>

      {records.length === 0 ? (
        <div className="card card-pad">
          <div className="state-block">
            <div className="big-ico"><IconHistory size={28} /></div>
            <h3>暂无保存的隐患记录</h3>
            <p>在「智能识别」页完成分析后点击「保存结果」，相关记录将出现在这里。</p>
          </div>
        </div>
      ) : (
        <div className="records-grid">
          {records.map((rec) => (
            <div className="card record-card" key={rec.id}>
              <div className="rc-head">
                <div className="haz-index" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--navy)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
                  {rec.hazardCount}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--navy)' }}>{rec.analysisId}</div>
                  <div className="small muted">{new Date(rec.savedAt).toLocaleString('zh-CN')}</div>
                </div>
                <span className="mode-chip ai">
                  <span className="dot" />
                  AI
                </span>
              </div>
              <div className="rc-body">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <GradeBadge grade={gradeOf(rec.overallRisk)} />
                  <span className="chip">综合风险 {rec.overallRisk ?? '未定级'}</span>
                  <span className="chip">隐患 {rec.hazardCount} 项</span>
                </div>
                {rec.image && (
                  <img src={rec.image.dataUrl} alt="隐患原图" style={{ width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 8 }} />
                )}
                <div className="small muted">现场概况：{rec.analysis.imageSummary}</div>
              </div>
              <div className="rc-foot">
                <button className="btn btn-primary-soft btn-sm" onClick={() => open(rec)}>
                  <IconEye size={13} />
                  查看
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => void exportOne(rec)}>
                  <IconDownload size={13} />
                  导出报告
                </button>
                <div className="spacer" style={{ flex: 1 }} />
                <button className="btn btn-danger-soft btn-sm" onClick={() => remove(rec.id)}>
                  <IconTrash size={13} />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
