/**
 * 历史测试记录（点击就地展开）。
 *
 * 数据来源是**异步作业历史**（`GET /api/clustering/jobs`）：每次「提交后台作业」
 * 都会在服务端留下一条记录，这是唯一真正带时间线、能列出"过去跑过哪些测试"的来源。
 * 离线基准归档是单份论文复现数据、没有历史，仍由「离线基准结果」卡片单独展示。
 *
 * 交互上刻意**不用抽屉、不跳页**：点一行就在列表内展开该作业的结果摘要、簇概览与
 * 分页明细，再点一次收起。作业状态是历史的一部分，失败 / 取消 / 仍在执行都必须
 * 就地给出可读原因，而不是打开后发现空白。
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  ClusteringJobInfo,
  ClusteringJobItemsPage,
  ClusteringJobResultData,
} from '../../shared/clustering';
import {
  fetchClusteringJobItems,
  fetchClusteringJobResult,
  fetchClusteringJobs,
} from '../api/clustering';
import { clusterColor, clusterTint } from '../lib/clusterColor';
import {
  HISTORY_ITEMS_PAGE_SIZE,
  HISTORY_LIST_LIMIT,
  clampPage,
  clusterOverview,
  countActiveJobs,
  describeJobOutcome,
  formatJobDuration,
  formatJobTime,
  historyExpandKind,
  historyStatusClass,
  historyStatusLabel,
  jobItemsPageCount,
  jobRunLabel,
  sortJobsNewestFirst,
  summarizeJobResult,
  toggleExpandedJob,
} from '../lib/clusteringJobHistory';
import { IconChevronDown, IconChevronRight, IconHistory, IconRefresh } from './icons';

export function ClusteringJobHistory() {
  const [jobs, setJobs] = useState<ClusteringJobInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 同一时刻只展开一条：历史列表可能很长，多条同时展开会让页面失去焦点。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setJobs(sortJobsNewestFirst(await fetchClusteringJobs(HISTORY_LIST_LIMIT)));
    } catch (cause) {
      // 取数失败要给出可读错误，而不是让卡片停在"加载中"或显示空白
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const toggle = useCallback((jobId: string) => {
    setExpandedId((current) => toggleExpandedJob(current, jobId));
  }, []);

  const activeCount = countActiveJobs(jobs);

  return (
    <section className="card card-pad" aria-label="历史测试记录">
      <div className="clustering-section-head">
        <h2><IconHistory size={15} /> 历史测试记录</h2>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void loadJobs()}>
          <IconRefresh size={14} />{busy ? '加载中…' : '刷新'}
        </button>
      </div>
      <p className="small muted">
        这里列出服务端保存的历史聚类作业（新→旧，最多 {HISTORY_LIST_LIMIT} 条），点击任意一条
        <strong>就地展开</strong>结果摘要与明细，再点一次收起。与离线基准归档不同，这些是真实跑过的作业记录。
      </p>

      {error && <p className="clustering-notice is-error">历史记录加载失败：{error}</p>}
      {activeCount > 0 && (
        <p className="clustering-notice">
          有 {activeCount} 个作业尚未完成；它们可能仍在服务端执行，点「刷新」查看最新进度。
        </p>
      )}
      {!busy && !error && jobs.length === 0 && (
        <p className="small muted">
          还没有历史测试记录。在页面上方的「提交后台作业」跑一次后，这里就会出现可回看的记录。
        </p>
      )}

      {jobs.length > 0 && (
        <div className="clustering-history-scroll">
          <div className="clustering-history clustering-history-head" aria-hidden="true">
            <span />
            <span>时间</span>
            <span>状态</span>
            <span>Profile · 算法</span>
            <span>样本</span>
            <span>耗时</span>
            <span>Run ID</span>
            <span>备注</span>
          </div>
          <ul className="clustering-history-list">
            {jobs.map((job) => {
              const open = job.jobId === expandedId;
              return (
                <li key={job.jobId} className={`clustering-history-item ${open ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="clustering-history clustering-history-row"
                    aria-expanded={open}
                    onClick={() => toggle(job.jobId)}
                  >
                    <span className="clustering-history-caret" aria-hidden="true">
                      {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    </span>
                    <span>{formatJobTime(job.createdAt)}</span>
                    <span>
                      <span className={`clustering-status ${historyStatusClass(job)}`}>
                        {historyStatusLabel(job)}
                      </span>
                    </span>
                    <span className="clustering-history-profile">
                      {job.profileId ?? '—'}
                      {job.algorithm ? `（${job.algorithm}）` : ''}
                    </span>
                    <span>{job.itemCount} 条</span>
                    <span>{formatJobDuration(job)}</span>
                    <span className="mono clustering-history-run" title={job.jobId}>{jobRunLabel(job)}</span>
                    <span className="clustering-history-flag">
                      {job.error ? `有错误：${job.error.message}` : job.warnings.length ? `${job.warnings.length} 条提示` : ''}
                    </span>
                  </button>
                  {open && <JobHistoryDetail job={job} onRefresh={loadJobs} refreshing={busy} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** 单条历史记录的展开区：按状态决定是读结果、给原因，还是提示刷新。 */
function JobHistoryDetail({
  job,
  onRefresh,
  refreshing,
}: {
  job: ClusteringJobInfo;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const kind = historyExpandKind(job);
  const [result, setResult] = useState<ClusteringJobResultData | null>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const [resultError, setResultError] = useState('');
  /** 结果读取失败后的重试计数：只改它就能重新触发下面两个取数 effect。 */
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<ClusteringJobItemsPage | null>(null);
  const [itemsBusy, setItemsBusy] = useState(false);
  const [itemsError, setItemsError] = useState('');

  // 失败 / 取消 / 执行中的作业没有结果可读，直接打接口只会拿到注定失败的响应，
  // 因此这里只在成功作业上取摘要。
  useEffect(() => {
    if (kind !== 'result') return;
    let cancelled = false;
    setResultBusy(true);
    setResultError('');
    void fetchClusteringJobResult(job.jobId)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((cause) => {
        if (!cancelled) setResultError((cause as Error).message);
      })
      .finally(() => {
        if (!cancelled) setResultBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [job.jobId, kind, retry]);

  // 明细走服务端分页：展开时取第一页，翻页只换偏移量，不把全量拉进浏览器。
  useEffect(() => {
    if (kind !== 'result') return;
    let cancelled = false;
    setItemsBusy(true);
    setItemsError('');
    void fetchClusteringJobItems(job.jobId, {
      offset: page * HISTORY_ITEMS_PAGE_SIZE,
      limit: HISTORY_ITEMS_PAGE_SIZE,
    })
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((cause) => {
        if (!cancelled) setItemsError((cause as Error).message);
      })
      .finally(() => {
        if (!cancelled) setItemsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [job.jobId, kind, page, retry]);

  if (kind !== 'result') {
    return (
      <div className="clustering-history-detail">
        <p className={`clustering-notice ${kind === 'failed' ? 'is-error' : ''}`}>
          {describeJobOutcome(job)}
        </p>
        {kind === 'running' && (
          <button className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => void onRefresh()}>
            <IconRefresh size={14} />{refreshing ? '刷新中…' : '刷新状态'}
          </button>
        )}
        {job.warnings.map((warning) => (
          <p key={warning} className="clustering-notice">{warning}</p>
        ))}
      </div>
    );
  }

  const total = items?.total ?? result?.detail.itemCount ?? job.itemCount;
  const pageCount = jobItemsPageCount(total);
  const currentPage = clampPage(page, pageCount);
  const clusterRows = result ? clusterOverview(result.clusters) : [];

  return (
    <div className="clustering-history-detail">
      {resultBusy && <p className="small muted">正在读取结果摘要…</p>}
      {resultError && (
        <>
          <p className="clustering-notice is-error">结果摘要读取失败：{resultError}</p>
          <button className="btn btn-outline btn-sm" onClick={() => setRetry((value) => value + 1)}>
            <IconRefresh size={14} />重试
          </button>
        </>
      )}

      {result && (
        <>
          <div className="clustering-stat-grid clustering-history-stats" aria-label="历史作业结果统计">
            {summarizeJobResult(result).map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          {result.summary.warnings.map((warning) => (
            <p key={warning} className="clustering-notice">{warning}</p>
          ))}
          {result.warnings.map((warning) => (
            <p key={warning} className="clustering-notice">{warning}</p>
          ))}

          <div className="clustering-history-clusters">
            <span className="small muted">簇概览</span>
            {clusterRows.length === 0 ? (
              <span className="small muted">本次结果没有返回任何簇。</span>
            ) : (
              clusterRows.map((cluster) => (
                <span
                  key={cluster.clusterId}
                  className="cluster-pill"
                  style={{
                    background: clusterTint(cluster.clusterId, 0.14),
                    color: clusterColor(cluster.clusterId),
                  }}
                >
                  <span className="cluster-legend-dot" style={{ background: clusterColor(cluster.clusterId) }} />
                  {cluster.clusterId < 0 ? '未归类' : cluster.label}（{cluster.size}）
                </span>
              ))
            )}
            {result.clusters.length > clusterRows.length && (
              <span className="small muted">还有 {result.clusters.length - clusterRows.length} 个簇未列出</span>
            )}
          </div>

          {itemsError && <p className="clustering-notice is-error">明细读取失败：{itemsError}</p>}
          {items?.truncated && (
            <p className="clustering-notice">明细结果被服务端截断，仅展示已扫描到的部分。</p>
          )}

          {items && items.items.length === 0 ? (
            <p className="small muted">本次作业没有可展示的明细条目。</p>
          ) : (
            <ul className="clustering-job-items">
              {(items?.items ?? []).map((item) => (
                <li key={item.id}>
                  <span
                    className="clustering-job-dot"
                    style={{ background: clusterColor(item.clusterId) }}
                    aria-hidden="true"
                  />
                  <span className="clustering-job-cluster">
                    {item.clusterId < 0 ? '未归类' : item.clusterLabel}
                  </span>
                  <span className="clustering-job-text">{item.text}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="clustering-pager">
            <button
              className="btn btn-outline btn-sm"
              disabled={itemsBusy || currentPage <= 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <span className="small muted">
              第 {currentPage + 1} / {pageCount} 页 · 共 {total} 条
              {itemsBusy ? ' · 加载中…' : ''}
            </span>
            <button
              className="btn btn-outline btn-sm"
              disabled={itemsBusy || currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
