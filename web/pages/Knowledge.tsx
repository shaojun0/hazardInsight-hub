import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistoricalCase, StandardClause, StandardDocument, StandardType } from '../../shared/types';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { GradeBadge } from '../components/GradeBadge';
import { IconBook, IconChevronRight, IconDatabase, IconSearch } from '../components/icons';
import { fetchCases, fetchStandards } from '../api/knowledge';
import { CATEGORY_OPTIONS, STANDARD_TYPE_LABEL, TYPE_TAG_LABEL } from '../lib/constants';

interface DocsResponseDoc extends StandardDocument {
  clauses: StandardClause[];
}

const TYPE_ORDER: Array<'all' | StandardType> = ['all', 'general', 'nuclear', 'enterprise'];

export function Knowledge({ initialTab }: { initialTab: 'standard' | 'case' }) {
  const [tab, setTab] = useState<'standard' | 'case'>(initialTab);
  const [type, setType] = useState<'all' | StandardType>('all');
  const [allDocs, setAllDocs] = useState<DocsResponseDoc[]>([]);
  const [docDrawer, setDocDrawer] = useState<DocsResponseDoc | null>(null);

  const [cases, setCases] = useState<HistoricalCase[]>([]);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('全部');
  const [grade, setGrade] = useState('全部');

  useEffect(() => {
    void fetchStandards('all')
      .then((res) => {
        setAllDocs(res.data as DocsResponseDoc[]);
      })
      .catch(() => undefined);
  }, []);

  const docs = useMemo<DocsResponseDoc[]>(() => (type === 'all' ? allDocs : allDocs.filter((d) => d.type === type)), [allDocs, type]);

  const loadCases = useCallback(async (filters: { q: string; category: string; grade: string }) => {
    const res = await fetchCases(filters);
    setCases(res.data);
  }, []);

  useEffect(() => {
    void loadCases({ q, category, grade });
  }, [q, category, grade, loadCases]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = { all: allDocs.length };
    for (const t of ['general', 'nuclear', 'enterprise'] as const) c[t] = allDocs.filter((d) => d.type === t).length;
    return c;
  }, [allDocs]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>安全知识库</h1>
        <div className="sub">通用标准 · 核电专用标准 · 企业受控文件 · 历史隐患案例</div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="tabs" style={{ padding: '0 18px' }}>
          <button className={`tab ${tab === 'standard' ? 'active' : ''}`} onClick={() => setTab('standard')}>
            <IconBook size={15} />
            标准法规
          </button>
          <button className={`tab ${tab === 'case' ? 'active' : ''}`} onClick={() => setTab('case')}>
            <IconDatabase size={15} />
            历史案例
          </button>
        </div>
      </div>

      {tab === 'standard' && (
        <div className="kb-layout">
          <div className="card kb-filters">
            <div className="section-label">文件分类</div>
            {TYPE_ORDER.map((t) => (
              <div key={t} className={`kb-nav-item ${type === t ? 'active' : ''}`} onClick={() => setType(t)}>
                <span>{t === 'all' ? '全部' : STANDARD_TYPE_LABEL[t]}</span>
                <span className="cnt">{typeCounts[t] ?? 0}</span>
              </div>
            ))}
          </div>

          <div className="card scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>文件名称</th>
                  <th>文件类型</th>
                  <th>文件编号</th>
                  <th>版本</th>
                  <th>状态</th>
                  <th>条款数量</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="link" onClick={() => setDocDrawer(d)}>《{d.documentName}》</td>
                    <td>
                      <span className={`tag tag-${d.type}`}>{STANDARD_TYPE_LABEL[d.type]}</span>
                    </td>
                    <td className="mono">{d.documentCode}</td>
                    <td>{d.version}</td>
                    <td><span className="chip">{d.status}</span></td>
                    <td>{d.clauseCount}</td>
                    <td>{d.updatedAt}</td>
                    <td>
                      <button className="btn btn-primary-soft btn-sm" onClick={() => setDocDrawer(d)}>
                        查看详情
                        <IconChevronRight size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'case' && (
        <>
          <div className="card card-pad filter-bar" style={{ padding: '12px 16px' }}>
            <div className="grow" style={{ position: 'relative' }}>
              <IconSearch size={15} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} />
              <input
                className="input"
                style={{ paddingLeft: 32 }}
                placeholder="搜索：案例编号 / 项目 / 隐患描述 / 关键词"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select className="select" style={{ width: 160 }} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{c === '全部' ? '全部类型' : c}</option>
              ))}
            </select>
            <select className="select" style={{ width: 140 }} value={grade} onChange={(e) => setGrade(e.target.value)}>
              {['全部', 'A', 'B', 'C', 'D'].map((g) => (
                <option key={g} value={g}>{g === '全部' ? '全部等级' : `${g} 级`}</option>
              ))}
            </select>
            <span className="chip">共 {cases.length} 条案例</span>
          </div>

          <div className="card scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>案例编号</th>
                  <th>项目</th>
                  <th>隐患类型</th>
                  <th>隐患描述</th>
                  <th>隐患等级</th>
                  <th>整改结果</th>
                  <th>相似关键词</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.caseId}>
                    <td className="mono" style={{ fontWeight: 600 }}>{c.caseId}</td>
                    <td>{c.project}</td>
                    <td>{c.category}</td>
                    <td style={{ maxWidth: 380 }}>{c.description}</td>
                    <td><GradeBadge grade={c.grade} /></td>
                    <td>
                      <span className="chip" style={{ color: c.result === '已整改' ? 'var(--ok)' : 'var(--warn)' }}>
                        {c.result}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 220 }}>
                        {c.keywords.map((k) => (
                          <span className="chip" key={k} style={{ fontSize: 11, height: 18 }}>{k}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {docDrawer && <DocDrawer doc={docDrawer} onClose={() => setDocDrawer(null)} />}
    </div>
  );
}

function DocDrawer({ doc, onClose }: { doc: DocsResponseDoc; onClose: () => void }) {
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>标准文件详情</h3>
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            <IconXsmall />
            关闭
          </button>
        </div>
        <div className="drawer-body">
          <div className="doc-hero">
            <div className="doc-code">{doc.documentCode} · v{doc.version}</div>
            <div className="doc-name">《{doc.documentName}》</div>
            <div className="doc-meta">
              类型：{STANDARD_TYPE_LABEL[doc.type]} · 分类：{doc.category} · 状态：{doc.status} · 更新：{doc.updatedAt}
            </div>
          </div>
          <div className="section-label">条款目录（{doc.clauses.length} 条）</div>
          {doc.clauses.map((c) => (
            <div className="clause-block" key={c.id} style={{ borderLeft: '3px solid var(--primary)' }}>
              <div className="clause-title">
                <span className="tag tag-general" style={{ marginRight: 8, background: 'var(--primary-050)', color: 'var(--primary-600)' }}>
                  {c.clause}
                </span>
                {c.clauseTitle}
              </div>
              <div className="clause-content" style={{ marginTop: 6 }}>{c.content}</div>
              <div style={{ marginTop: 6 }}>
                {c.keywords.map((k) => (
                  <span className="chip" key={k} style={{ marginRight: 4, fontSize: 11, height: 18 }}>{k}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function IconXsmall() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
