/**
 * 隐患分析报告 HTML 生成（纯函数，无 DOM 依赖）。
 * 服务端 /api/export 与前端共用；输出自包含 HTML，可直接用浏览器打印为 PDF。
 */
import type { AnalysisResult, Hazard, Grade, RectificationItem } from './types.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const GRADE_COLORS: Record<Grade, string> = { A: '#c0392b', B: '#e67e22', C: '#d4a017', D: '#2f6f9f' };
const KIND_LABEL: Record<RectificationItem['kind'], string> = {
  immediate: '立即措施',
  corrective: '整改措施',
  preventive: '预防措施',
};

interface ReportOptions {
  title?: string;
  org?: string;
}

export function renderReportHtml(analysis: AnalysisResult, opts: ReportOptions = {}): string {
  const org = opts.org ?? '核电工程隐患智能识别与定级系统';
  const title = opts.title ?? `隐患分析报告 · ${analysis.analysisId}`;
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 } as Record<Grade, number>;
  for (const h of analysis.hazards) gradeCounts[h.grade] += 1;
  const overall = analysis.overallRisk ? `${analysis.overallRisk} 级` : '未定级';

  const hazardBlocks = analysis.hazards
    .map((h, i) => {
      const color = GRADE_COLORS[h.grade];
      const refs = h.standardReferences
        .map(
          (r) => `
          <li class="ref-item">
            <span class="tag tag-${r.type}">${typeLabel(r.type)}</span>
            <strong>《${escapeHtml(r.documentName)}》${escapeHtml(r.documentCode)} 第 ${escapeHtml(r.clause)} 条</strong><br/>
            <span class="muted">${escapeHtml(r.clauseTitle)} · 相关度 ${Math.round(r.relevance * 100)}%</span>
            <p>${escapeHtml(r.content)}</p>
          </li>`
        )
        .join('');
      const cases = h.historicalReferences
        .map(
          (c) => `
          <li>${escapeHtml(c.caseId)}（历史定级 ${c.grade} 级）· 相似度 ${Math.round(c.similarity * 100)}% · ${escapeHtml(c.description)}</li>`
        )
        .join('');
      const rules = (h.ruleReferences ?? [])
        .map(
          (r) => `<li><strong>${escapeHtml(r.code)} · ${escapeHtml(r.levelName)}</strong>${r.starred ? ' · 星标规则（需复核）' : ''}<br/><span class="muted">${escapeHtml(r.categoryPath)} · 相关度 ${Math.round(r.relevance * 100)}%</span><p>${escapeHtml(r.text)}</p></li>`
        )
        .join('');
      const ev = h.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
      const rec = h.rectification
        .map((r) => `<li><span class="kind kind-${r.kind}">${KIND_LABEL[r.kind]}</span> ${escapeHtml(r.text)}</li>`)
        .join('');
      return `
      <section class="hazard">
        <div class="hazard-head">
          <span class="idx">隐患 ${String(i + 1).padStart(2, '0')}</span>
          <span class="grade" style="background:${color}">${h.grade} 级 · ${analysis.overallRisk === h.grade ? '' : ''}${h.category}</span>
          <span class="conf">AI 置信度 ${Math.round(h.confidence * 100)}%</span>
        </div>
        <h3>${escapeHtml(h.title)}</h3>
        <p class="desc">${escapeHtml(h.description)}</p>
        <div class="grid">
          <div>
            <h4>识别依据</h4><ul>${ev}</ul>
          </div>
          <div>
            <h4>可能后果</h4><p>${escapeHtml(h.possibleConsequence)}</p>
          </div>
        </div>
        <h4>定级依据</h4>
        <p class="muted">${escapeHtml(h.gradeReason)}</p>
        <h4>法规标准引用</h4><ul class="refs">${refs || '<li class="muted">无引用</li>'}</ul>
        <h4>历史相似案例</h4><ul class="cases">${cases || '<li class="muted">无匹配案例</li>'}</ul>
        <h4>领域判定规则</h4><ul class="refs">${rules || '<li class="muted">无匹配规则</li>'}</ul>
        <h4>整改建议</h4><ul class="recs">${rec}</ul>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:#1e293b; background:#fff; margin:0; padding:32px 40px; }
  .head { border-bottom: 3px solid #1d63ed; padding-bottom: 16px; margin-bottom: 20px; }
  .head h1 { font-size: 22px; margin: 0 0 6px; color:#0b2545; }
  .meta { color:#64748b; font-size: 13px; }
  .summary { display:flex; gap: 18px; flex-wrap: wrap; background:#f1f6fe; border:1px solid #dbe7fb; border-radius:10px; padding:14px 18px; margin-bottom:18px; }
  .summary .cell strong { display:block; font-size: 22px; color:#1d63ed; }
  .summary .cell span { font-size: 12px; color:#64748b; }
  .summary .cell.grade strong { color:#0b2545; }
  .hazard { border:1px solid #e2e8f0; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; break-inside: avoid; }
  .hazard-head { display:flex; align-items:center; gap:10px; margin-bottom: 8px; }
  .idx { font-weight:700; color:#0b2545; }
  .grade { color:#fff; border-radius: 6px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .conf { font-size: 13px; color:#64748b; }
  h3 { margin: 6px 0 4px; font-size: 17px; color:#0b2545; }
  h4 { margin: 12px 0 4px; font-size: 13px; color:#334155; text-transform: none; }
  ul { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
  .muted { color:#64748b; }
  .desc { font-size: 14px; line-height: 1.7; }
  .tag { display:inline-block; border-radius: 4px; padding: 0 6px; font-size: 11px; margin-right:6px; color:#fff; }
  .tag-general { background:#1d63ed; }
  .tag-nuclear { background:#7c3aed; }
  .tag-enterprise { background:#0e9f6e; }
  .kind { display:inline-block; border-radius:4px; padding:0 6px; font-size:11px; margin-right:6px; color:#fff; }
  .kind-immediate { background:#dc2626; }
  .kind-corrective { background:#d97706; }
  .kind-preventive { background:#2563eb; }
  .refs li, .cases li { margin-bottom: 6px; }
  .note { font-size:12px; color:#b45309; background:#fef3c7; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; margin-top:18px; }
  @media print { body { padding: 0; } .hazard { break-inside: avoid; } }
</style>
</head>
<body>
  <div class="head">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(org)} · 分析流水号：${escapeHtml(analysis.analysisId)} · 生成时间：${escapeHtml(new Date(analysis.createdAt).toLocaleString('zh-CN'))} · 模式：AI 模式 · 模型：${escapeHtml(analysis.modelName ?? '-')}${analysis.agentMeta ? ` · Run：${escapeHtml(analysis.agentMeta.runId)}${analysis.agentMeta.fallbackUsed ? ' · 保守降级' : ''}` : ''}</div>
  </div>
  <div class="summary">
    <div class="cell"><strong>${analysis.hazards.length}</strong><span>隐患数量</span></div>
    <div class="cell grade"><strong>${overall}</strong><span>综合风险等级</span></div>
    <div class="cell"><strong>${gradeCounts.A}</strong><span>A 级</span></div>
    <div class="cell"><strong>${gradeCounts.B}</strong><span>B 级</span></div>
    <div class="cell"><strong>${gradeCounts.C}</strong><span>C 级</span></div>
    <div class="cell"><strong>${gradeCounts.D}</strong><span>D 级</span></div>
    <div class="cell"><strong>${analysis.stats.standardsCited}</strong><span>引用标准条款</span></div>
    <div class="cell"><strong>${analysis.stats.casesCited}</strong><span>引用历史案例</span></div>
  </div>
  <p class="muted">现场概况：${escapeHtml(analysis.imageSummary)}</p>
  ${hazardBlocks || '<p>未发现明确安全隐患。</p>'}
  ${analysis.disclaimer ? `<div class="note">${escapeHtml(analysis.disclaimer)}</div>` : ''}
</body>
</html>`;
}

function typeLabel(t: string): string {
  return t === 'general' ? '通用标准' : t === 'nuclear' ? '核电专用' : '企业文件';
}

/** 从 AnalysisResult 提取可序列化的简化数据（供导出接口）。 */
export function asSerializable(analysis: AnalysisResult): unknown {
  return JSON.parse(JSON.stringify(analysis));
}
