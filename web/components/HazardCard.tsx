import { useState } from 'react';
import type { Hazard, RectificationItem, StandardReference } from '../../shared/types';
import { GradeBadge, GradeSelect } from './GradeBadge';
import {
  RECT_KIND_COLOR,
  RECT_KIND_LABEL,
  STANDARD_TYPE_LABEL,
  TYPE_TAG_LABEL,
} from '../lib/constants';
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconInfo,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from './icons';

type Tab = 'desc' | 'evidence' | 'standard' | 'case' | 'rect';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'desc', label: '隐患描述' },
  { key: 'evidence', label: '识别依据' },
  { key: 'standard', label: '法规 / 规则' },
  { key: 'case', label: '历史案例' },
  { key: 'rect', label: '整改建议' },
];

interface Props {
  hazard: Hazard;
  active: boolean;
  onSelect: () => void;
  onUpdateHazard: (patch: Partial<Hazard>) => void;
  onDelete: () => void;
  onDownloadImage: () => void;
  onOpenReference: (ref: StandardReference) => void;
}

export function HazardCard({ hazard, active, onSelect, onUpdateHazard, onDelete, onDownloadImage, onOpenReference }: Props) {
  const [tab, setTab] = useState<Tab>('desc');
  const [editingDesc, setEditingDesc] = useState(false);
  const [editingRect, setEditingRect] = useState(false);
  const [draftTitle, setDraftTitle] = useState(hazard.title);
  const [draftDesc, setDraftDesc] = useState(hazard.description);
  const [draftRect, setDraftRect] = useState<RectificationItem[]>(hazard.rectification);

  const startEditDesc = () => {
    setDraftTitle(hazard.title);
    setDraftDesc(hazard.description);
    setEditingDesc(true);
  };
  const saveDesc = () => {
    onUpdateHazard({ title: draftTitle.trim() || hazard.title, description: draftDesc });
    setEditingDesc(false);
  };

  const startEditRect = () => {
    setDraftRect(hazard.rectification.map((r) => ({ ...r })));
    setEditingRect(true);
  };
  const saveRect = () => {
    onUpdateHazard({ rectification: draftRect });
    setEditingRect(false);
  };

  return (
    <div className={`card hazard-card ${active ? 'is-active' : ''}`} id={`hazard-${hazard.index}`}>
      <div className="hazard-head" onClick={onSelect} style={{ cursor: 'pointer' }}>
        <div className="haz-index">{String(hazard.index).padStart(2, '0')}</div>
        <div className="haz-mid">
          <div className="haz-cat">
            {hazard.category}
          </div>
          <div className="haz-title" title={hazard.title}>
            {hazard.title}
          </div>
        </div>
        <div className="haz-side" onClick={(e) => e.stopPropagation()}>
          <span className="conf-chip">置信度 {Math.round(hazard.confidence * 100)}%</span>
          <div className="haz-grade-control">
            <div className="haz-grade-label">AI 定级</div>
            <GradeSelect value={hazard.grade} onChange={(g) => onUpdateHazard({ grade: g })} />
          </div>
          <button className="btn btn-danger-soft btn-sm" onClick={onDelete} title="删除该条误判隐患及其标注">
            <IconTrash size={13} />
            删除
          </button>
        </div>
      </div>

      <div className="hazard-body">
        <div className="tabs hazard-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="hazard-pane">
          {tab === 'desc' && (
            <div>
              {editingDesc ? (
                <div className="edit-zone">
                  <input className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="隐患标题" />
                  <textarea className="textarea" rows={4} value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} placeholder="隐患描述" />
                  <div className="edit-actions">
                    <button className="btn btn-primary btn-sm" onClick={saveDesc}>保存</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditingDesc(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="kv-row">
                    <span className="k">风险描述</span>
                    <span>{hazard.description}</span>
                  </div>
                  <div className="kv-row">
                    <span className="k">风险类别</span>
                    <span className="chip">{hazard.category}</span>
                  </div>
                  <div className="kv-row">
                    <span className="k">风险后果</span>
                    <span>{hazard.possibleConsequence || '未提供'}</span>
                  </div>
                  <div className="kv-row">
                    <span className="k">AI 置信度</span>
                    <span>
                      <b style={{ color: 'var(--primary-600)' }}>{Math.round(hazard.confidence * 100)}%</b>
                      <span className="muted">（依据图片可见证据的充分程度）</span>
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'evidence' && (
            <div className="evidence-list">
              {hazard.evidence.map((ev, i) => (
                <div className="evidence-item" key={i}>
                  <span className="ok"><IconCheck size={15} /></span>
                  {ev}
                </div>
              ))}
              <div className="small muted" style={{ borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
                以上依据为模型对图像可见事实的客观描述；未覆盖的信息可能未被识别。
              </div>
            </div>
          )}

          {tab === 'standard' && <StandardPane hazard={hazard} onOpenReference={onOpenReference} />}
          {tab === 'case' && <CasePane hazard={hazard} />}
          {tab === 'rect' && (
            <div>
              {editingRect ? (
                <div className="edit-zone">
                  {draftRect.map((r, i) => (
                    <div className="row" key={i} style={{ alignItems: 'flex-start', gap: 8 }}>
                      <select
                        className="select"
                        style={{ width: 108, flex: 'none' }}
                        value={r.kind}
                        onChange={(e) => {
                          const next = [...draftRect];
                          next[i] = { ...next[i], kind: e.target.value as RectificationItem['kind'] };
                          setDraftRect(next);
                        }}
                      >
                        {(['immediate', 'corrective', 'preventive'] as const).map((k) => (
                          <option key={k} value={k}>{RECT_KIND_LABEL[k]}</option>
                        ))}
                      </select>
                      <input
                        className="input"
                        value={r.text}
                        onChange={(e) => {
                          const next = [...draftRect];
                          next[i] = { ...next[i], text: e.target.value };
                          setDraftRect(next);
                        }}
                      />
                      <button
                        className="btn btn-danger-soft btn-sm"
                        style={{ flex: 'none' }}
                        onClick={() => setDraftRect(draftRect.filter((_, j) => j !== i))}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="row">
                    <button
                      className="btn btn-primary-soft btn-sm"
                      onClick={() => setDraftRect([...draftRect, { kind: 'corrective', text: '' }])}
                    >
                      <IconPlus size={13} />
                      添加措施
                    </button>
                    <div className="spacer" style={{ flex: 1 }} />
                    <button className="btn btn-primary btn-sm" onClick={saveRect}>保存</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditingRect(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <RectificationList rect={hazard.rectification} />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="hazard-foot">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            定级依据
          </div>
          <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>{hazard.gradeReason}</div>
        </div>
        <div className="hazard-foot-tools">
          <div className="row">
            <span className="chip">严重度 {hazard.severityScore}/5</span>
            <span className="chip">可能性 {hazard.probabilityScore}/5</span>
            <span className="chip" style={{ background: 'var(--primary-050)', color: 'var(--primary-600)' }}>
              风险值 {hazard.riskScore}
            </span>
          </div>
          <div className="hazard-actions">
            {tab !== 'rect' ? (
              <button className="btn btn-primary-soft btn-sm" onClick={startEditRect}>
                <IconPencil size={13} />
                编辑整改建议
              </button>
            ) : (
              <button className="btn btn-primary-soft btn-sm" onClick={startEditRect}>
                <IconPencil size={13} />
                {editingRect ? '编辑中' : '编辑整改建议'}
              </button>
            )}
            {tab === 'desc' && !editingDesc && (
              <button className="btn btn-outline btn-sm" onClick={startEditDesc}>
                <IconPencil size={13} />
                编辑描述
              </button>
            )}
            <button className="btn btn-outline btn-sm hazard-locate" onClick={onSelect} title="在图中定位该隐患">
              <IconInfo size={13} />
              定位到图像
            </button>
            <button className="btn btn-outline btn-sm hazard-download" onClick={onDownloadImage} title="下载仅包含该条隐患标注的 PNG 图片">
              <IconDownload size={13} />
              下载标注图片
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StandardPane({ hazard, onOpenReference }: { hazard: Hazard; onOpenReference: (r: StandardReference) => void }) {
  const groups: Array<{ type: 'general' | 'nuclear' | 'enterprise' }> = [
    { type: 'general' },
    { type: 'nuclear' },
    { type: 'enterprise' },
  ];
  return (
    <div className="entity-groups">
      {groups.map((g) => {
        const items = hazard.standardReferences.filter((r) => r.type === g.type);
        if (!items.length) return null;
        return (
          <div className="entity-group" key={g.type}>
            <div className="group-head">
              <span className={`tag tag-${g.type}`}>{TYPE_TAG_LABEL[g.type]}</span>
              <span className="count">{items.length} 条</span>
            </div>
            {items.map((r, i) => (
              <div className="ref-row" key={i}>
                <div className="ref-top">
                  <span className="ref-doc">《{r.documentName}》</span>
                  <span className="ref-clause">第 {r.clause} 条</span>
                  <span className="chip">相关度 {Math.round(r.relevance * 100)}%</span>
                </div>
                <div className="ref-clause" style={{ color: 'var(--text-2)', fontWeight: 600 }}>
                  {r.clauseTitle}
                </div>
                <div className="ref-content">{r.content}</div>
                <div className="ref-reason">
                  <b>引用原因：</b>
                  {r.reason}
                </div>
                <div className="ref-meta">
                  <button className="btn btn-primary-soft btn-sm" onClick={() => onOpenReference(r)}>
                    查看依据
                    <IconChevronRight size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {(hazard.ruleReferences ?? []).length > 0 && (
        <div className="entity-group">
          <div className="group-head">
            <span className="tag tag-enterprise">领域判定规则</span>
            <span className="count">{hazard.ruleReferences?.length ?? 0} 条</span>
          </div>
          {(hazard.ruleReferences ?? []).map((rule) => (
            <div className="ref-row" key={rule.ruleId}>
              <div className="ref-top">
                <span className="ref-doc">{rule.code} · {rule.levelName}</span>
                {rule.starred && <span className="chip" style={{ color: 'var(--danger)' }}>星标 · 需复核</span>}
                <span className="chip">相关度 {Math.round(rule.relevance * 100)}%</span>
              </div>
              <div className="ref-clause" style={{ color: 'var(--text-2)', fontWeight: 600 }}>{rule.categoryPath || '未分类'}</div>
              <div className="ref-content">{rule.text}</div>
              <div className="ref-reason"><b>匹配原因：</b>{rule.reason}</div>
              <div className="small muted" style={{ marginTop: 6 }}>规则分类 level={rule.level} 不等同于 A/B/C/D 风险等级。</div>
            </div>
          ))}
        </div>
      )}
      {hazard.standardReferences.length === 0 && (hazard.ruleReferences ?? []).length === 0 && (
        <div className="state-block" style={{ padding: '18px 8px' }}>
          <IconAlert size={18} />
          <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            暂未检索到匹配的法规标准。
          </p>
        </div>
      )}
    </div>
  );
}

function CasePane({ hazard }: { hazard: Hazard }) {
  return (
    <div>
      <div className="group-head" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>
        历史相似案例 TOP {hazard.historicalReferences.length || 3}
        <span className="count muted" style={{ fontWeight: 500 }}>（按相似度排序）</span>
      </div>
      {hazard.historicalReferences.map((c, i) => (
        <div className="case-row" key={i}>
          <div className="case-top">
            <span className="case-id">{c.caseId}</span>
            <span className="sim-pill">相似度 {Math.round(c.similarity * 100)}%</span>
            <GradeBadge grade={c.grade} showLabel={false} size="sm" />
          </div>
          <div style={{ height: 6, background: 'var(--primary-100)', borderRadius: 99, overflow: 'hidden', margin: '4px 0 6px' }}>
            <div style={{ height: '100%', width: `${Math.round(c.similarity * 100)}%`, background: 'var(--primary)' }} />
          </div>
          <div className="case-desc">{c.description}</div>
          <div className="case-reason">{c.similarityReason}</div>
          <div className="case-rect">
            <b style={{ color: 'var(--text-2)' }}>历史整改措施：</b>
            {c.ref.rectification}
          </div>
        </div>
      ))}
      {hazard.historicalReferences.length === 0 && (
        <div className="state-block" style={{ padding: '18px 8px' }}>
          <IconAlert size={18} />
          <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>暂无高度相似的历史案例。</p>
        </div>
      )}
    </div>
  );
}

function RectificationList({ rect }: { rect: RectificationItem[] }) {
  let seq = 0;
  const groups: Array<RectificationItem['kind']> = ['immediate', 'corrective', 'preventive'];
  return (
    <div>
      {groups.map((kind) => {
        const items = rect.filter((r) => r.kind === kind);
        if (!items.length) return null;
        return (
          <div className="rec-group" key={kind}>
            <div className="rec-kind">
              <span className="bar" style={{ background: RECT_KIND_COLOR[kind] }} />
              {RECT_KIND_LABEL[kind]}
              <span className="count muted" style={{ fontWeight: 500 }}>{items.length}</span>
            </div>
            {items.map((r) => {
              seq += 1;
              return (
                <div className="rec-item" key={seq}>
                  <span className="idx">{String(seq).padStart(2, '0')}</span>
                  {r.text}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
