import { useEffect, useRef } from 'react';
import { TEST_GRADES, type HazardTestRow } from '../../shared/hazard-test';
import { IconX } from './icons';

export function TestVerdict({ value }: { value: boolean | null }) {
  return <span className={`tag test-verdict ${value === true ? 'is-correct' : value === false ? 'is-incorrect' : ''}`}>
    {value === true ? '正确' : value === false ? '错误' : '—'}
  </span>;
}

export function HazardTestDetail({ row, onClose }: { row: HazardTestRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>('button, summary, [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  return <>
    <div className="drawer-mask" onClick={onClose} />
    <div className="drawer test-detail" role="dialog" aria-modal="true" aria-labelledby="test-detail-title" ref={dialogRef}>
      <div className="drawer-head">
        <h3 id="test-detail-title">测试详情 · 第 {row.index} 条</h3>
        <button ref={closeRef} className="btn btn-outline btn-sm" onClick={onClose}><IconX size={14} />关闭</button>
      </div>
      <div className="drawer-body">
        <div className="test-detail-summary">
          <p><strong>标准答案：</strong>{row.expected ? `${row.expected}级` : '无标准答案，不计入准确率'}</p>
          <p><strong>Agent 判断：</strong>{row.actual ? `${row.actual}级` : row.status === 'failed' ? '执行失败，无有效预测' : '尚未完成'}</p>
          <p><strong>差异字段：</strong>{row.differences.join(' / ') || '无'}</p>
          {row.errorMessage && <p role="alert" className="test-error">{row.errorMessage}</p>}
          <p className="small muted">运行 ID：{row.runId ?? '—'}<br />开始：{row.startedAt ?? '—'}<br />完成：{row.completedAt ?? '—'}</p>
        </div>
        <table className="table"><thead><tr><th>等级判断</th><th>标准答案</th><th>Agent 判断</th><th>结果</th></tr></thead>
          <tbody>{TEST_GRADES.map(grade => <tr key={grade}><td>是否为 {grade} 级</td><td>{row.expected ? row.expected === grade ? '是' : '否' : '—'}</td><td>{row.actual ? row.actual === grade ? '是' : '否' : '—'}</td><td><TestVerdict value={row.accuracy[grade]} /></td></tr>)}</tbody>
        </table>
        <h4>隐患描述</h4><p className="test-prewrap">{row.sourceData['隐患描述']}</p>
        <h4>人工 A/B 级判定标准</h4><p className="test-prewrap">{row.sourceData['A/B级判定标准'] || '未提供'}</p>
        <h4>Agent 定级说明</h4><p className="test-prewrap">{row.analysis?.hazards[0]?.gradeReason || '暂无'}</p>
        {row.analysis?.needManualReview && <p className="test-notice">Agent 标记需人工复核；有效的暂定等级仍按最终等级参与比对。</p>}
        <details open><summary>原始 CSV 数据（全部字段）</summary><pre>{JSON.stringify(row.sourceData, null, 2)}</pre></details>
        <details open><summary>Agent 原始输出（公开推理正文）</summary><pre>{row.agentRawOutput || '暂无模型输出'}</pre></details>
        <details><summary>Agent 完整结果与定级追踪</summary><pre>{JSON.stringify(row.analysis ?? null, null, 2)}</pre></details>
      </div>
    </div>
  </>;
}
