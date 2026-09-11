import { useCallback, useMemo, useState } from 'react';
import { TEST_GRADES, type TestAccuracy } from '../../shared/hazard-test';
import type { Grade } from '../../shared/types';
import { GradeBadge } from '../components/GradeBadge';
import { HazardTestDetail, TestVerdict } from '../components/HazardTestDetail';
import { IconDownload, IconEye } from '../components/icons';
import { downloadTestErrors } from '../api/hazard-test';
import { useHazardTest } from '../lib/useHazardTest';
import './HazardTest.css';
import { TEST_MAX_CONCURRENCY, TEST_MIN_OUTPUT_TOKENS, TEST_MAX_OUTPUT_TOKENS } from '../../shared/hazard-test';

const percent = (value?: TestAccuracy) => value?.percent == null ? '—' : `${value.percent.toFixed(1)}%`;
const STATUS = { running: '测试中', stopping: '停止中（等待正在执行的条目完成）', stopped: '已停止', completed: '测试完成' };
type Filter = 'all' | 'incorrect' | 'correct' | 'failed';

export function HazardTest() {
  const { dataset, job, busy, active, error, pollError, options, setOptions, loadDefault, upload, start, stop } = useHazardTest();
  const validOptions = Number.isInteger(options.concurrency) && options.concurrency >= 1 && options.concurrency <= TEST_MAX_CONCURRENCY
    && Number.isInteger(options.maxOutputTokens) && options.maxOutputTokens >= TEST_MIN_OUTPUT_TOKENS && options.maxOutputTokens <= TEST_MAX_OUTPUT_TOKENS;
  const [filter, setFilter] = useState<Filter>('all');
  const [gradeFilter, setGradeFilter] = useState<Grade | ''>('');
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const closeDetail = useCallback(() => setSelected(null), []);
  const stats = job?.stats;
  const filtered = useMemo(() => (job?.rows ?? []).filter(row => {
    if (filter === 'incorrect' && row.accuracy.overall !== false) return false;
    if (filter === 'correct' && row.accuracy.overall !== true) return false;
    if (filter === 'failed' && row.status !== 'failed') return false;
    return !gradeFilter || row.accuracy[gradeFilter] === false;
  }), [job, filter, gradeFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pageCount);
  const selectedRow = job?.rows.find(row => row.index === selected);
  const progress = stats?.total ? stats.completed / stats.total * 100 : 0;

  async function exportErrors() {
    if (!job) return;
    setExporting(true); setExportError('');
    try { await downloadTestErrors(job.id); }
    catch (e) { setExportError((e as Error).message); }
    finally { setExporting(false); }
  }

  return <div className="page hazard-test-page">
    <div className="page-head"><h1>隐患测试</h1><div className="sub">使用人工标注的隐患文本，检验现有 Agent 的 A/B/C/D 定级结果。</div></div>
    {(error || pollError || exportError) && <div className="card card-pad test-error" role="alert">{error || pollError || exportError}</div>}
    <section className="card card-pad">
      <div className="test-toolbar">
        <div className="test-dataset"><strong>{dataset?.fileName ?? (busy ? '正在加载测试集…' : '尚未加载测试集')}</strong>
          {dataset && <div className="small muted">共 {dataset.total} 条 · 有标准答案 {dataset.labeled} 条 · {TEST_GRADES.map(g => `${g}级 ${dataset.gradeCounts[g]}`).join(' / ')}</div>}
        </div>
        <button className="btn btn-outline" disabled={busy || active} onClick={() => { setSelected(null); void loadDefault(); }}>使用默认数据</button>
        <label className={`btn btn-outline test-upload ${busy || active ? 'is-disabled' : ''}`}>
          上传 CSV<input aria-label="上传自定义 CSV 测试集" type="file" accept=".csv,text/csv" disabled={busy || active} onChange={event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
            if (file) { setSelected(null); void upload(file); }
          }} />
        </label>
        <button className="btn btn-primary" disabled={busy || active || !dataset || !validOptions} onClick={() => { setSelected(null); setPage(1); void start(); }}>{active ? '测试进行中' : '开始测试'}</button>
        {active && <button className="btn btn-danger-soft" disabled={busy || job?.status === 'stopping'} onClick={() => void stop()}>停止测试</button>}
      </div>
      <div className="test-toolbar test-settings">
        <label>并发数（线程） <input aria-label="并发数（线程）" type="number" min={1} max={TEST_MAX_CONCURRENCY} step={1}
          disabled={busy || active} value={Number.isNaN(options.concurrency) ? '' : options.concurrency}
          onChange={event => setOptions(previous => ({ ...previous, concurrency: event.target.valueAsNumber }))} /></label>
        <label>单条输出上限（tokens） <input aria-label="单条输出上限（tokens）" type="number" min={TEST_MIN_OUTPUT_TOKENS} max={TEST_MAX_OUTPUT_TOKENS} step={1}
          disabled={busy || active} value={Number.isNaN(options.maxOutputTokens) ? '' : options.maxOutputTokens}
          onChange={event => setOptions(previous => ({ ...previous, maxOutputTokens: event.target.valueAsNumber }))} /></label>
        <span className="small muted">并发 1–{TEST_MAX_CONCURRENCY}；输出上限 {TEST_MIN_OUTPUT_TOKENS}–{TEST_MAX_OUTPUT_TOKENS}</span>
      </div>
      {!validOptions && <p className="test-error" role="alert">请输入范围内的整数后开始测试。</p>}
      <p className="small muted">并发数控制同时测试的条数。若遇到 finish_reason=length 空输出，可提高单条输出上限后重测；实际支持的上限取决于模型服务。</p>
      <p className="small muted">CSV 必须包含“隐患描述”“隐患级别”，自动识别“隐患分类”；最多 500 条 / 5MB，支持 UTF-8、GBK 编码。</p>
      {dataset?.warnings.map(warning => <p key={warning} className="test-notice">{warning}</p>)}
      <div className="test-progress-head" role="status"><strong>{job ? STATUS[job.status] : '待开始'}</strong><span>已完成 {stats?.completed ?? 0} / {dataset?.total ?? 0} · 执行中 {job?.rows.filter(row => row.status === 'running').length ?? 0} · 执行成功 {stats?.success ?? 0} · 执行失败 {stats?.failed ?? 0}</span></div>
      {job && <p className="small muted">本次设置：并发 {job.options?.concurrency ?? 1} · 单条输出上限 {job.options?.maxOutputTokens ?? TEST_MIN_OUTPUT_TOKENS} tokens</p>}
      <progress className="test-progress" aria-label="测试进度" max={100} value={progress} />
      <div className="small muted">测试结果临时保存在后端，刷新页面可恢复最近任务；最多缓存 12 个任务，24 小时后、容量淘汰或服务重启后失效。停止操作会等待正在执行的条目结束。</div>
    </section>
    <section className="card test-stat-grid" aria-label="测试统计">
      {[
        ['总测试量', dataset?.total ?? 0], ['已测试', stats?.completed ?? 0], ['正确数量', stats?.correct ?? 0],
        ['错误数量', stats?.incorrect ?? 0], ['总体准确率', percent(stats?.overall)],
      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong>{label === '总体准确率' && <small>正确 {stats?.overall.correct ?? 0} / 有效 {stats?.overall.valid ?? 0}</small>}</div>)}
    </section>
    <section className="card card-pad">
      <div className="test-grade-grid">{TEST_GRADES.map(grade => <div key={grade}>
        <span>{grade} 准确率</span><strong>{percent(stats?.byGrade[grade])}</strong>
        <small>正确 {stats?.byGrade[grade].correct ?? 0} / 有效 {stats?.byGrade[grade].valid ?? 0}</small>
        <small>{grade} 级样本命中率：{percent(stats?.recall[grade])}（{stats?.recall[grade].correct ?? 0}/{stats?.recall[grade].valid ?? 0}）</small>
      </div>)}</div>
      <p className="small muted test-metric-note">A/B/C/D 是“隐患级别”的四种互斥分类。各项准确率 = “属于 / 不属于该等级”判断正确数 ÷ 有效测试数，包含正确排除；样本命中率仅统计标准答案属于该等级的数据。无标准答案、执行失败及未完成数据均不计入分母；无有效样本显示“—”。总体要求等级完全一致。</p>
      {stats && <div className="small muted">未计分的已成功条目：{stats.unscored} · 执行失败：{stats.failed} · 未完成：{stats.total - stats.completed}</div>}
    </section>
    <section className="card">
      <div className="test-toolbar card-pad">
        <label>结果 <select value={filter} onChange={e => { setFilter(e.target.value as Filter); setPage(1); }}>
          <option value="all">查看全部数据</option><option value="incorrect">只看错误数据</option><option value="correct">只看正确数据</option><option value="failed">只看执行失败</option>
        </select></label>
        <label>差异字段 <select value={gradeFilter} onChange={e => { setGradeFilter(e.target.value as Grade | ''); setFilter('all'); setPage(1); }}>
          <option value="">全部等级</option>{TEST_GRADES.map(g => <option key={g} value={g}>{g} 项错误</option>)}
        </select></label>
        <span className="small muted">共 {filtered.length} 条</span>
        <button className="btn btn-outline btn-sm test-export" disabled={exporting || !stats || stats.incorrect + stats.failed === 0} onClick={() => void exportErrors()}><IconDownload size={14} />导出错误数据（含执行失败）</button>
      </div>
      <div className="test-table-scroll"><table className="table test-results"><thead><tr>
        <th>序号</th><th>隐患数据摘要</th><th>标准答案</th><th>Agent 判断</th>{TEST_GRADES.map(g => <th key={g}>{g}</th>)}<th>整体结果</th><th>操作</th>
      </tr></thead><tbody>
        {filtered.slice((currentPage - 1) * 20, currentPage * 20).map(row => <tr key={row.index} onClick={() => setSelected(row.index)}>
          <td>{row.index}</td><td><div className="test-description" title={row.sourceData['隐患描述']}>{row.sourceData['隐患描述']}</div><small className="muted">{row.sourceData['隐患单号'] ?? '无单号'}</small></td>
          <td>{row.expected ? <GradeBadge grade={row.expected} /> : '无标准答案'}</td>
          <td>{row.actual ? <GradeBadge grade={row.actual} /> : '—'}</td>
          {TEST_GRADES.map(g => <td key={g}><TestVerdict value={row.accuracy[g]} /></td>)}
          <td>{row.status === 'failed' ? <span className="tag test-verdict is-incorrect">执行失败</span> : row.status !== 'success' ? <span className="tag">{row.status === 'running' ? '执行中' : job?.status === 'stopped' ? '未执行' : '待执行'}</span> : row.accuracy.overall === null ? <span className="tag">未计分</span> : <TestVerdict value={row.accuracy.overall} />}</td>
          <td><button className="btn btn-outline btn-sm" aria-label={`查看第 ${row.index} 条详情`} onClick={event => { event.stopPropagation(); setSelected(row.index); }}><IconEye size={13} />详情</button></td>
        </tr>)}
        {!filtered.length && <tr><td colSpan={10} className="test-empty">{job ? '没有符合筛选条件的数据。' : '测试集已准备好，点击“开始测试”查看逐条结果。'}</td></tr>}
      </tbody></table></div>
      <div className="test-pagination"><button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pageCount}</span><button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
    </section>
    {selectedRow && <HazardTestDetail row={selectedRow} onClose={closeDetail} />}
  </div>;
}
