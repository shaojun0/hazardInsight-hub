import { useMemo, useState } from 'react';
import type { Grade } from '../../shared/types';
import { GradeBadge } from '../components/GradeBadge';
import { IconClipboard, IconPlus, IconShieldCheck, IconTrash } from '../components/icons';
import {
  loadLedger,
  removeLedgerItem,
  STATUS_META,
  updateLedgerItem,
  type LedgerItem,
  type LedgerStatus,
} from '../lib/ledger';
import { addLedgerItems } from '../lib/ledger';
import { GRADE_META } from '../lib/constants';
import { CATEGORY_OPTIONS } from '../lib/constants';

const SOURCE_LABEL: Record<LedgerItem['source'], string> = {
  camera: '摄像头',
  robot: '机器人',
  workbench: '工作台',
  manual: '手动登记',
};

export function Prevent() {
  const [items, setItems] = useState<LedgerItem[]>(() => loadLedger());
  const [q, setQ] = useState('');
  const [grade, setGrade] = useState('全部');
  const [statusF, setStatusF] = useState('全部');
  const [showAdd, setShowAdd] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; category: string; grade: Grade; description: string }>({
    title: '',
    category: '临时用电',
    grade: 'C',
    description: '',
  });

  const filtered = useMemo(
    () =>
      items.filter((it) => {
        if (grade !== '全部' && it.grade !== grade) return false;
        if (statusF !== '全部' && it.status !== statusF) return false;
        if (q && !(`${it.title}${it.category}${it.description}`.includes(q))) return false;
        return true;
      }),
    [items, q, grade, statusF]
  );

  const stats = useMemo(() => {
    const s = { pending: 0, processing: 0, closed: 0 };
    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const it of items) {
      s[it.status] += 1;
      grades[it.grade] += 1;
    }
    return { ...s, grades, total: items.length };
  }, [items]);

  function addManual() {
    if (!draft.title.trim()) return;
    addLedgerItems([
      {
        id: `ledger-manual-${Date.now()}`,
        source: 'manual',
        title: draft.title.trim(),
        category: draft.category,
        grade: draft.grade,
        confidence: 0.5,
        description: draft.description.trim() || draft.title.trim(),
        evidence: ['人工登记'],
        rectificationTexts: [],
        foundAt: new Date().toISOString(),
        status: 'pending',
      },
    ]);
    setItems(loadLedger());
    setDraft({ title: '', category: '临时用电', grade: 'C', description: '' });
    setShowAdd(false);
  }

  function setStatus(id: string, status: LedgerStatus) {
    setItems(updateLedgerItem(id, { status }));
  }

  async function exportLedger() {
    if (!items.length) return;
    const { renderReportHtml } = await import('../../shared/report');
    const fakeAnalysis = {
      analysisId: 'LEDGER-EXPORT',
      imageSummary: '隐患台账导出（明细见各条隐患）',
      overallRisk: null,
      needManualReview: false,
      hazards: items.map((it, i) => ({
        id: it.id,
        index: i + 1,
        title: it.title,
        category: it.category,
        description: it.description,
        confidence: it.confidence,
        bbox: { x: 0, y: 0, width: 0.02, height: 0.02 },
        evidence: it.evidence,
        possibleConsequence: it.possibleConsequence ?? '',
        grade: it.grade,
        gradeReason: `台账状态：${STATUS_META[it.status].label}`,
        severityScore: 3,
        probabilityScore: 2,
        riskScore: 6,
        standardReferences: [],
        historicalReferences: [],
        rectification: it.rectificationTexts.map((t) => ({ kind: 'corrective' as const, text: t })),
        manualReviewRequired: true,
      })),
      stats: { standardsCited: 0, casesCited: 0 },
      mode: 'ai' as const,
      modelName: '隐患台账',
      disclaimer: '',
      createdAt: new Date().toISOString(),
    };
    const html = renderReportHtml(fakeAnalysis, { title: `隐患台账 · ${new Date().toLocaleDateString('zh-CN')}` });
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
    }
  }

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>隐患防控</h1>
          <div className="sub">隐患台账闭环管理：排查 · 登记 · 整改 · 复查 · 销号；支持来源登记、责任人与整改时限。</div>
        </div>
        <div className="row">
          <button className="btn btn-outline" onClick={() => void exportLedger()}>
            <IconClipboard size={14} />
            导出台账
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd((v) => !v)}>
            <IconPlus size={14} />
            新增隐患
          </button>
        </div>
      </div>

      {/* 概览 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 16 }}>
        <StatCard label="全部隐患" value={stats.total} tone="var(--primary)" />
        <StatCard label="待整改" value={stats.pending} tone={STATUS_META.pending.tone} />
        <StatCard label="整改中" value={stats.processing} tone={STATUS_META.processing.tone} />
        <StatCard label="已闭环" value={stats.closed} tone={STATUS_META.closed.tone} />
      </div>

      <div className="settings-grid" style={{ gridTemplateColumns: '1fr 320px' }}>
        <div className="card scroll-x">
          <div className="card-pad filter-bar" style={{ paddingBottom: 12 }}> 
            <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="搜索隐患标题 / 类别 / 描述" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="select" style={{ width: 130 }} value={grade} onChange={(e) => setGrade(e.target.value)}>
              {['全部', 'A', 'B', 'C', 'D'].map((g) => (
                <option key={g} value={g}>{g === '全部' ? '全部等级' : `${g} 级`}</option>
              ))}
            </select>
            <select className="select" style={{ width: 130 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              {(['全部', 'pending', 'processing', 'closed'] as const).map((s) => (
                <option key={s} value={s}>{s === '全部' ? '全部状态' : STATUS_META[s].label}</option>
              ))}
            </select>
            <span className="chip">共 {filtered.length} 条</span>
          </div>

          {showAdd && (
            <div className="card-pad" style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <input className="input" style={{ flex: 2, minWidth: 200 }} placeholder="隐患标题（必填）" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                <select className="select" style={{ width: 140 }} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                  {CATEGORY_OPTIONS.filter((c) => c !== '全部').map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select className="select" style={{ width: 130 }} value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value as Grade })}>
                  {(['A', 'B', 'C', 'D'] as Grade[]).map((g) => (
                    <option key={g} value={g}>{g} 级</option>
                  ))}
                </select>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                  <textarea className="textarea" rows={2} placeholder="隐患描述（选填）" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-primary-soft btn-sm" onClick={addManual}>提交登记</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setShowAdd(false)}>取消</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <table className="table">
            <thead>
              <tr>
                <th>来源</th>
                <th>隐患标题</th>
                <th>类别</th>
                <th>等级</th>
                <th>发现时间</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id}>
                  <td><span className="chip">{SOURCE_LABEL[it.source]}</span></td>
                  <td className="link" style={{ maxWidth: 320 }} onClick={() => setDetailId(it.id)}>{it.title}</td>
                  <td>{it.category}</td>
                  <td><GradeBadge grade={it.grade} showLabel={false} size="sm" /></td>
                  <td className="small muted">{new Date(it.foundAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 104, height: 28, padding: '2px 26px 2px 8px', fontSize: 12 }}
                      value={it.status}
                      onChange={(e) => setStatus(it.id, e.target.value as LedgerStatus)}
                    >
                      {(['pending', 'processing', 'closed'] as const).map((s) => (
                        <option key={s} value={s}>{STATUS_META[s].label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="row">
                      <button className="btn btn-primary-soft btn-sm" onClick={() => setDetailId(it.id)}>详情</button>
                      <button className="btn btn-danger-soft btn-sm" onClick={() => setItems(removeLedgerItem(it.id))}>
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="state-block" style={{ padding: '30px 10px' }}>
                      <div className="big-ico"><IconShieldCheck size={26} /></div>
                      <p>暂无匹配的台账记录。可前往「智能识别 / 隐患发现」识别后转入，或点击「新增隐患」手动登记。</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="stack">
          <div className="card card-pad">
            <b className="small" style={{ color: 'var(--navy)' }}>等级分布</b>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(['A', 'B', 'C', 'D'] as Grade[]).map((g) => (
                <div key={g} className="row" style={{ gap: 8 }}>
                  <span style={{ width: 22, color: GRADE_META[g].color, fontWeight: 700, fontSize: 12 }}>{g} 级</span>
                  <div style={{ flex: 1, height: 8, background: 'var(--surface-3)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${stats.total ? (stats.grades[g] / stats.total) * 100 : 0}%`, background: GRADE_META[g].color }} />
                  </div>
                  <span className="small muted">{stats.grades[g]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad">
            <b className="small" style={{ color: 'var(--navy)' }}>闭环管理流程</b>
            <ol className="small" style={{ paddingLeft: 18, lineHeight: 2, color: 'var(--text-2)', margin: '10px 0 0' }}>
              <li><b>排查发现</b>：摄像头 / 机器人 / 智能识别自动发现隐患；</li>
              <li><b>登记入账</b>：一键转入台账并自动分级；</li>
              <li><b>整改实施</b>：落实责任人、期限，更新整改措施；</li>
              <li><b>复查验证</b>：专业安全人员现场复核；</li>
              <li><b>销号闭环</b>：验证合格后标记「已闭环」。</li>
            </ol>
          </div>

          <div className="card card-pad">
            <b className="small" style={{ color: 'var(--navy)' }}>防控措施建议</b>
            <p className="small muted" style={{ lineHeight: 1.8, marginTop: 8 }}>
              每条隐患整改建议分为 <b style={{ color: '#e0342f' }}>立即措施</b>（消除眼前风险）、
              <b style={{ color: '#e97a1f' }}>整改措施</b>（消除根本原因）、
              <b style={{ color: 'var(--primary-700)' }}>预防措施</b>（防止复发）。
              A/B 级隐患由项目负责人督办并提级验证。
            </p>
          </div>
        </div>
      </div>

      {detailId && <LedgerDetail id={detailId} items={items} onUpdate={(id, patch) => setItems(updateLedgerItem(id, patch))} onClose={() => setDetailId(null)} onSetStatus={(id, s) => setStatus(id, s)} />}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: 'color-mix(in srgb, ' + tone + ' 14%, var(--surface))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: tone, fontSize: 17 }}>{value}</span>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>{label}</div>
        <div className="small muted">条</div>
      </div>
    </div>
  );
}

function LedgerDetail({
  id,
  items,
  onUpdate,
  onClose,
  onSetStatus,
}: {
  id: string;
  items: LedgerItem[];
  onUpdate: (id: string, patch: Partial<LedgerItem>) => void;
  onClose: () => void;
  onSetStatus: (id: string, s: LedgerStatus) => void;
}) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>隐患详情 · {it.title}</h3>
          <button className="btn btn-outline btn-sm" onClick={onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <div className="doc-hero">
            <div className="doc-code">{it.id.split('-').slice(0, 2).join('-')} · 来源：{SOURCE_LABEL[it.source]}</div>
            <div className="doc-name" style={{ fontSize: 15 }}>{it.title}</div>
            <div className="doc-meta">类别：{it.category} · 发现：{new Date(it.foundAt).toLocaleString('zh-CN')}</div>
          </div>

          <div className="row" style={{ gap: 8, marginBottom: 14 }}>
            <GradeBadge grade={it.grade} />
            <span className="chip">置信度 {Math.round(it.confidence * 100)}%</span>
            <div style={{ flex: 1 }} />
            <select className="select" style={{ width: 116 }} value={it.status} onChange={(e) => onSetStatus(id, e.target.value as LedgerStatus)}>
              {(['pending', 'processing', 'closed'] as const).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </div>

          <div className="section-label">描述</div>
          <p className="small" style={{ color: 'var(--text-2)', lineHeight: 1.8 }}>{it.description}</p>
          {it.possibleConsequence && (
            <>
              <div className="section-label">可能后果</div>
              <p className="small" style={{ color: 'var(--text-2)', lineHeight: 1.8 }}>{it.possibleConsequence}</p>
            </>
          )}
          {it.evidence.length > 0 && (
            <>
              <div className="section-label">识别依据</div>
              <ul className="small" style={{ color: 'var(--text-2)', paddingLeft: 18, lineHeight: 1.9, margin: 0 }}>
                {it.evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </>
          )}
          {it.rectificationTexts.length > 0 && (
            <>
              <div className="section-label">整改建议</div>
              <ol className="small" style={{ color: 'var(--text-2)', paddingLeft: 18, lineHeight: 1.9, margin: 0 }}>
                {it.rectificationTexts.map((t, i) => <li key={i}>{t}</li>)}
              </ol>
            </>
          )}

          <div className="section-label" style={{ marginTop: 14 }}>责任与时限</div>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" style={{ flex: 1 }} placeholder="责任人 / 班组" value={it.owner ?? ''} onChange={(e) => onUpdate(id, { owner: e.target.value })} />
            <input className="input" style={{ flex: 1 }} type="date" value={it.dueDate ?? ''} onChange={(e) => onUpdate(id, { dueDate: e.target.value })} />
          </div>
        </div>
      </div>
    </>
  );
}
