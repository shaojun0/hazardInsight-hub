/**
 * 偏差数据库：聚类语义知识库的查看与生成。
 *
 * 三件事对应页面上的三块：
 * ① 「已有知识库」表格 —— 列出 cluster-engine 中所有可用的库（元信息）；
 * ② 「新建知识库」卡片 —— 上传语料，可选「大模型净化」或「原文直接入库」，
 *    提交后异步生成，页面轮询进度条；
 * ③ 详情抽屉 —— 查看清单元信息与库内条目（历史库没有文本快照时如实说明）。
 *
 * 这里不提供删除：知识库是现场演示资产，误删一次就得重新跑几小时净化。
 * 需要清理时走运维命令，页面上不做一键危险操作。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClusteringKnowledgeBaseDetail,
  ClusteringKnowledgeBaseInfo,
  ClusteringKnowledgeBaseJob,
} from '../../shared/clustering';
import {
  buildKnowledgeBase,
  fetchKnowledgeBaseDetail,
  fetchKnowledgeBaseJob,
  fetchKnowledgeBases,
} from '../api/clustering';
import { IconAlert, IconCheckCircle, IconDatabase, IconFileText, IconRefresh, IconUpload, IconX } from '../components/icons';
// 复用聚类页的工具栏/表格样式（.clustering-toolbar / .clustering-id），避免另起一套
import './Clustering.css';

const MODE_LABEL: Record<string, string> = {
  purified: '大模型净化',
  raw: '原文直接入库',
};

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  purify: '语义净化',
  embed: '向量化',
  index: '写入索引',
  done: '已完成',
  failed: '已失败',
};

const SOURCE_LABEL: Record<string, string> = {
  snapshot: '构建时保留的索引文本快照',
  corpus: '上传语料原文快照',
  source: '按来源指纹匹配到的历史语料',
  unavailable: '无文本快照，仅元信息',
};

function formatBytes(value: number): string {
  if (!value) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function KnowledgeBase() {
  const [items, setItems] = useState<ClusteringKnowledgeBaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [detail, setDetail] = useState<ClusteringKnowledgeBaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'purified' | 'raw'>('purified');
  const [ident, setIdent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [job, setJob] = useState<ClusteringKnowledgeBaseJob | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await fetchKnowledgeBases());
    } catch (cause) {
      setItems([]);
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 生成作业轮询：终态即停；完成后刷新列表，让新库立刻可选。
  useEffect(() => {
    if (!job || job.terminal) return;
    const timer = window.setInterval(() => {
      void fetchKnowledgeBaseJob(job.jobId)
        .then((next) => {
          setJob(next);
          if (next.terminal) void refresh();
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job, refresh]);

  const submit = useCallback(async () => {
    if (!file) {
      setFormError('请先选择语料文件。');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const created = await buildKnowledgeBase(file, {
        name: name.trim() || file.name,
        mode,
        ident: ident.trim() || null,
      });
      setJob(created);
      setFile(null);
      setName('');
      setIdent('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (cause) {
      setFormError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [file, name, mode, ident]);

  const openDetail = useCallback(async (knowledgeBaseId: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchKnowledgeBaseDetail(knowledgeBaseId, 0, 50));
    } catch (cause) {
      setDetail({
        knowledgeBaseId,
        displayName: knowledgeBaseId,
        status: 'unavailable',
        verification: 'unknown',
        processing: 'unknown',
        entryCount: 0,
        dimension: 0,
        metric: '',
        modelFingerprint: '',
        sourceSha256: '',
        sizeBytes: 0,
        hasEntries: false,
        hasCorpus: false,
        entriesSource: 'unavailable',
        entryTotal: 0,
        offset: 0,
        limit: 50,
        entries: [],
        warnings: [(cause as Error).message],
      });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadMoreEntries = useCallback(async () => {
    if (!detail) return;
    try {
      const next = await fetchKnowledgeBaseDetail(detail.knowledgeBaseId, detail.entries.length, 50);
      setDetail({ ...next, entries: [...detail.entries, ...next.entries] });
    } catch (cause) {
      setDetail({ ...detail, warnings: [...detail.warnings, (cause as Error).message] });
    }
  }, [detail]);

  const progress = useMemo(() => {
    if (!job || !job.total) return 0;
    return Math.min(100, Math.round((job.processed / job.total) * 100));
  }, [job]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>偏差数据库</h1>
        <div className="sub">
          检索增强聚类（SPEAR）使用的语义知识库：查看现有库，或上传语料由大模型净化生成新库；
          在「聚类展示」页选择本次使用哪个库。
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="section-label">新建知识库</div>
        <div className="filter-bar" style={{ marginBottom: 8 }}>
          <label className="row" style={{ gap: 8 }}>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.csv,.xlsx,.json"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
            <button className="btn btn-outline btn-sm" onClick={() => fileInput.current?.click()}>
              <IconFileText size={14} />
              选择语料文件
            </button>
            <span className="small muted">{file ? file.name : '支持 TXT（每行一条）/ CSV / XLSX / JSON'}</span>
          </label>
        </div>

        <div className="clustering-toolbar">
          <label>
            知识库名称
            <input
              className="input"
              placeholder="例如：2026Q1 巡检偏差语料"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            生成方式
            <select className="select" value={mode} onChange={(event) => setMode(event.target.value as 'purified' | 'raw')}>
              <option value="purified">大模型净化后入库（推荐）</option>
              <option value="raw">原文直接入库（不调用大模型）</option>
            </select>
          </label>
          <label>
            自定义标识（可选）
            <input
              className="input"
              placeholder="字母/数字/.-_，留空自动生成"
              value={ident}
              onChange={(event) => setIdent(event.target.value)}
            />
          </label>
          <button className="btn btn-primary" disabled={submitting || !file} onClick={() => void submit()}>
            <IconUpload size={15} />
            {submitting ? '提交中…' : '上传并生成'}
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          生成是异步任务：两万条语料的逐条净化可能需要一到三小时，提交后可离开页面，回来仍能查看进度。
          生成期间请勿同时执行聚类。
        </div>
        {formError && (
          <div className="small" style={{ color: 'var(--danger, #d33)', marginTop: 6 }}>
            <IconAlert size={13} /> {formError}
          </div>
        )}
      </div>

      {job && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8 }}>
              {job.status === 'succeeded' ? (
                <IconCheckCircle size={16} style={{ color: 'var(--ok, #2a8)' }} />
              ) : job.status === 'failed' ? (
                <IconAlert size={16} style={{ color: 'var(--danger, #d33)' }} />
              ) : (
                <span className="spinner" />
              )}
              <strong>{job.displayName || job.knowledgeBaseId || '生成任务'}</strong>
              <span className="chip">{STAGE_LABEL[job.stage] ?? job.stage}</span>
              {job.knowledgeBaseId && <span className="mono small muted">{job.knowledgeBaseId}</span>}
            </div>
            <span className="small muted">{job.message}</span>
          </div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${job.terminal && job.status === 'succeeded' ? 100 : progress}%` }} />
          </div>
          <div className="progress-meta">
            {job.stage === 'purify' || job.stage === 'embed' || job.stage === 'index'
              ? `当前阶段进度 ${job.processed}/${job.total}`
              : '—'}
            {job.status === 'failed' && job.error ? ` · 失败原因：${job.error.message}` : ''}
          </div>
          {job.warnings.length > 0 && (
            <div className="small muted" style={{ marginTop: 6 }}>
              {job.warnings.map((warning) => (
                <div key={warning}>· {warning}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card scroll-x">
        <div className="card-pad row" style={{ justifyContent: 'space-between' }}>
          <div className="section-label" style={{ margin: 0 }}>
            已有知识库（{items.length}）
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh size={13} />
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        {error && (
          <div className="card-pad small" style={{ color: 'var(--danger, #d33)' }}>
            <IconAlert size={13} /> {error}
          </div>
        )}
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>标识</th>
              <th>状态</th>
              <th>条目数</th>
              <th>生成方式</th>
              <th>维度</th>
              <th>创建时间</th>
              <th>大小</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.knowledgeBaseId}>
                <td>
                  <strong>{item.displayName}</strong>
                  {item.sourceName && <div className="small muted">{item.sourceName}</div>}
                </td>
                <td className="mono small">{item.knowledgeBaseId}</td>
                <td>
                  <span className="chip" style={{ color: item.status === 'completed' ? 'var(--ok, #2a8)' : 'var(--warn, #b80)' }}>
                    {item.status}
                  </span>
                </td>
                <td>{item.entryCount.toLocaleString('zh-CN')}</td>
                <td>{MODE_LABEL[item.processing] ?? item.processing}</td>
                <td>{item.dimension || '—'}</td>
                <td className="small">{formatTime(item.createdAt)}</td>
                <td className="small">{formatBytes(item.sizeBytes)}</td>
                <td>
                  <button className="btn btn-primary-soft btn-sm" onClick={() => void openDetail(item.knowledgeBaseId)}>
                    查看详情
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '22px 0' }}>
                  <IconDatabase size={18} /> 还没有可用的知识库。上传语料生成一个，或先用运维命令构建。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <KnowledgeBaseDrawer
          detail={detail}
          loading={detailLoading}
          onClose={() => setDetail(null)}
          onLoadMore={() => void loadMoreEntries()}
        />
      )}
    </div>
  );
}

function KnowledgeBaseDrawer({
  detail,
  loading,
  onClose,
  onLoadMore,
}: {
  detail: ClusteringKnowledgeBaseDetail;
  loading: boolean;
  onClose: () => void;
  onLoadMore: () => void;
}) {
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>{detail.displayName}</h3>
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            <IconX size={14} />
            关闭
          </button>
        </div>
        <div className="drawer-body">
          <div className="kv-row"><span className="k">标识</span><span className="mono">{detail.knowledgeBaseId}</span></div>
          <div className="kv-row"><span className="k">状态</span><span>{detail.status} / {detail.verification}</span></div>
          <div className="kv-row"><span className="k">生成方式</span><span>{MODE_LABEL[detail.processing] ?? detail.processing}</span></div>
          <div className="kv-row"><span className="k">向量模型</span><span>{detail.modelId || '—'}</span></div>
          <div className="kv-row"><span className="k">维度</span><span>{detail.dimension || '—'} · 度量 {detail.metric || '—'}</span></div>
          <div className="kv-row"><span className="k">条目数</span><span>{detail.entryCount.toLocaleString('zh-CN')}</span></div>
          <div className="kv-row"><span className="k">来源</span><span>{detail.sourceName || '—'}</span></div>
          <div className="kv-row"><span className="k">创建</span><span>{formatTime(detail.createdAt)}</span></div>
          <div className="kv-row"><span className="k">大小</span><span>{formatBytes(detail.sizeBytes)}</span></div>
          <div className="kv-row">
            <span className="k">指纹</span>
            <span className="mono small">{detail.modelFingerprint ? `${detail.modelFingerprint.slice(0, 16)}…` : '—'}</span>
          </div>

          {detail.warnings.map((warning) => (
            <div key={warning} className="small" style={{ color: 'var(--warn, #b80)', marginTop: 6 }}>
              <IconAlert size={13} /> {warning}
            </div>
          ))}

          <div className="section-label" style={{ marginTop: 16 }}>
            条目内容（{detail.entryTotal.toLocaleString('zh-CN')}） · 来源：{SOURCE_LABEL[detail.entriesSource] ?? detail.entriesSource}
          </div>
          {loading && <div className="muted small">加载中…</div>}
          <div className="stack">
            {detail.entries.map((entry) => (
              <div key={entry.index} className="row" style={{ alignItems: 'flex-start', gap: 10, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <span className="clustering-id" style={{ minWidth: 44 }}>#{entry.index}</span>
                <span className="small" style={{ lineHeight: 1.7 }}>{entry.text}</span>
              </div>
            ))}
            {!loading && detail.entries.length === 0 && (
              <div className="muted small">该知识库没有可展示的条目文本（见上方说明）。</div>
            )}
          </div>
          {detail.entries.length < detail.entryTotal && (
            <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={onLoadMore}>
              加载更多（已显示 {detail.entries.length}/{detail.entryTotal}）
            </button>
          )}
        </div>
      </div>
    </>
  );
}
