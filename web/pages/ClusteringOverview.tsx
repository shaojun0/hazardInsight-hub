/**
 * 聚类展示（演示/汇报视角）。
 *
 * 目标：一键跑通真实聚类，并把结果以「散点图 + 簇卡片 + 明细表」三层结构呈现。
 * 计算全部由 Python 聚类服务完成（算法来自 cluster-engine），本页只负责
 * 取数、渲染与交互，不在前端复现任何聚类逻辑。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClusteringClusterGroup,
  ClusteringData,
  ClusteringDatasetItem,
  ClusteringResultItem,
} from '../../shared/clustering';
import { fetchClusteringSample, runClustering, uploadClusteringDataset } from '../api/clustering';
import { ClusterItemDetail } from '../components/ClusterItemDetail';
import { ClusterScatter } from '../components/ClusterScatter';
import { IconLayers, IconPlay, IconRefresh, IconUpload } from '../components/icons';
import { clusterColor, clusterTint } from '../lib/clusterColor';
import { useClusterEngine } from '../lib/useClusterEngine';
import './Clustering.css';

const PAGE_SIZE = 20;

interface LoadedDataset {
  name: string;
  items: ClusteringDatasetItem[];
  warnings: string[];
}

export function ClusteringOverview() {
  const engine = useClusterEngine();
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [datasetError, setDatasetError] = useState('');
  const [algorithm, setAlgorithm] = useState('');
  const [profileId, setProfileId] = useState('');
  const [visualize, setVisualize] = useState(true);
  const [result, setResult] = useState<ClusteringData | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [activeClusterId, setActiveClusterId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // 首次进入直接带上内置示例数据，保证页面「打开即可点开始」。
  const loadSample = useCallback(async () => {
    setDatasetBusy(true);
    setDatasetError('');
    try {
      const sample = await fetchClusteringSample();
      setDataset({ name: sample.sourceName, items: sample.items, warnings: [] });
      setResult(null);
      setActiveClusterId(null);
      setSelectedId(null);
      setPage(1);
    } catch (cause) {
      setDatasetError((cause as Error).message);
    } finally {
      setDatasetBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadSample();
  }, [loadSample]);

  const availableAlgorithms = useMemo(
    () => engine.algorithms.filter((item) => item.available),
    [engine.algorithms],
  );

  /** 当前算法下的可用 profile；未选算法时列出全部可用 profile。 */
  const selectableProfiles = useMemo(
    () => engine.profiles.filter((profile) => profile.available && (!algorithm || profile.algorithm === algorithm)),
    [engine.profiles, algorithm],
  );

  // 切换算法时，若已选 profile 不属于该算法则清空，交给后端自动挑选。
  useEffect(() => {
    if (profileId && !selectableProfiles.some((profile) => profile.profileId === profileId)) {
      setProfileId('');
    }
  }, [profileId, selectableProfiles]);

  const upload = useCallback(async (file: File) => {
    setDatasetBusy(true);
    setDatasetError('');
    try {
      const preview = await uploadClusteringDataset(file);
      setDataset({ name: preview.sourceName, items: preview.items, warnings: preview.warnings });
      setResult(null);
      setActiveClusterId(null);
      setSelectedId(null);
      setPage(1);
    } catch (cause) {
      setDatasetError((cause as Error).message);
    } finally {
      setDatasetBusy(false);
    }
  }, []);

  const canRun = Boolean(dataset && dataset.items.length >= 2) && !running && !datasetBusy;

  const start = useCallback(async () => {
    if (!dataset || dataset.items.length < 2) {
      setRunError('至少需要 2 条样本才能聚类。');
      return;
    }
    setRunning(true);
    setRunError('');
    try {
      const next = await runClustering(dataset.items, {
        algorithm: algorithm || undefined,
        profileId: profileId || undefined,
        visualize,
        reduceMethod: visualize ? 'pca' : 'none',
      });
      setResult(next);
      setActiveClusterId(null);
      setSelectedId(null);
      setPage(1);
    } catch (cause) {
      setRunError((cause as Error).message);
    } finally {
      setRunning(false);
    }
  }, [dataset, algorithm, profileId, visualize]);

  const filteredItems = useMemo(() => {
    const items = result?.items ?? [];
    if (activeClusterId === null) return items;
    return items.filter((item) => item.clusterId === activeClusterId);
  }, [result, activeClusterId]);

  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleItems = filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = result?.items.find((item) => item.id === selectedId) ?? null;
  const highlighted = activeClusterId === null
    ? null
    : result?.clusters.find((cluster) => cluster.clusterId === activeClusterId) ?? null;

  const summary = result?.summary;

  return (
    <div className="page clustering-page">
      <div className="page-head">
        <h1>聚类分析 · 聚类展示</h1>
        <div className="sub">
          对核电工程隐患文本执行无监督聚类，查看簇结构、代表样本与关键词。算法由本地 Python 聚类服务提供。
        </div>
      </div>

      {!engine.loading && !engine.ready && (
        <div className="card card-pad clustering-banner" role="alert">
          <strong>聚类服务未就绪</strong>
          <p className="small">
            {engine.error
              ? engine.error
              : engine.health?.engine.message ?? '聚类引擎尚未加载完成。'}
          </p>
          <p className="small muted">
            请在项目根目录执行 <code>npm run dev:py</code> 启动 Python 聚类服务；首次启动需要校验本地向量模型，约需数十秒。
          </p>
          <button className="btn btn-outline btn-sm" onClick={() => void engine.refresh()}>
            <IconRefresh size={14} />重新检查
          </button>
        </div>
      )}

      {(datasetError || runError) && (
        <div className="card card-pad clustering-banner is-error" role="alert">
          <strong>执行失败</strong>
          <p className="small">{datasetError || runError}</p>
        </div>
      )}

      <section className="card card-pad">
        <div className="clustering-toolbar">
          <div className="clustering-dataset">
            <strong>{dataset?.name ?? (datasetBusy ? '正在加载示例数据…' : '尚未选择数据')}</strong>
            {dataset && <div className="small muted">共 {dataset.items.length} 条样本</div>}
          </div>
          <button className="btn btn-outline" disabled={datasetBusy || running} onClick={() => void loadSample()}>
            使用示例数据
          </button>
          <label className={`btn btn-outline clustering-upload ${datasetBusy || running ? 'is-disabled' : ''}`}>
            <IconUpload size={15} />上传文件
            <input
              aria-label="上传聚类数据文件"
              type="file"
              accept=".csv,.json,.xlsx,.txt"
              disabled={datasetBusy || running}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
          <button className="btn btn-primary" disabled={!canRun || !engine.ready} onClick={() => void start()}>
            <IconPlay size={15} />{running ? '聚类进行中…' : '开始聚类'}
          </button>
        </div>

        <div className="clustering-toolbar clustering-options">
          <label>
            算法
            <select
              className="select"
              value={algorithm}
              disabled={running || !engine.ready}
              onChange={(event) => setAlgorithm(event.target.value)}
            >
              <option value="">自动选择（推荐）</option>
              {availableAlgorithms.map((item) => (
                <option key={item.algorithm} value={item.algorithm}>{item.algorithm}</option>
              ))}
            </select>
          </label>
          <label>
            配置档 Profile
            <select
              className="select"
              value={profileId}
              disabled={running || !engine.ready}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="">自动选择</option>
              {selectableProfiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.profileId}（{profile.algorithm}{Number(profile.features.n_results ?? 0) > 0 ? ' · 检索增强' : ''}）
                </option>
              ))}
            </select>
          </label>
          <label className="clustering-check">
            <input type="checkbox" checked={visualize} disabled={running} onChange={(event) => setVisualize(event.target.checked)} />
            计算二维散点坐标（PCA，仅用于展示）
          </label>
          <span className="small muted">
            {engine.health
              ? `引擎已加载 ${engine.health.engine.profilesTotal} 个 profile，其中 ${engine.health.engine.profilesAvailable} 个可执行`
              : engine.loading ? '正在检查聚类服务…' : '聚类服务不可用'}
          </span>
        </div>

        {dataset?.warnings.map((warning) => (
          <p key={warning} className="clustering-notice">{warning}</p>
        ))}
        <p className="small muted">
          支持 CSV / XLSX / JSON / TXT，自动识别文本列；最多 500 条、10 MB。文本会做规范化清洗（全角转半角、去控制字符、合并空白）。
        </p>
      </section>

      {summary && (
        <>
          <section className="card clustering-stat-grid" aria-label="聚类统计">
            {[
              ['样本总数', String(summary.totalSamples)],
              ['簇数量', String(summary.clusterCount)],
              ['噪声点', String(summary.noiseCount)],
              ['最大簇', String(summary.largestClusterSize)],
              ['最小簇', String(summary.smallestClusterSize)],
              ['平均簇大小', summary.avgClusterSize.toFixed(2)],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>

          <section className="card card-pad clustering-run-meta">
            <p className="small muted">
              运行 ID：{summary.runId} · 算法：<strong>{summary.algorithm}</strong> · Profile：{summary.profileId} ·
              向量模型：{summary.modelId}（{summary.embeddingDimension} 维）·
              引擎耗时 {summary.elapsedMs} ms · 网关总耗时 {summary.gatewayMs} ms
              {summary.cacheHit ? ' · 命中向量缓存' : ''}
            </p>
            {summary.warnings.map((warning) => (
              <p key={warning} className="clustering-notice">{warning}</p>
            ))}
            {(summary.clusterCount <= 1 || summary.noiseCount === summary.totalSamples) && (
              <p className="clustering-notice">
                {summary.noiseCount === summary.totalSamples
                  ? '本次所有样本都被判定为噪声，说明密度类算法在当前数据上的阈值过严。'
                  : '本次只得到 1 个簇，说明当前算法的默认参数把这批文本并成了一类。'}
                不同算法对同一批数据的粒度差异很大，建议在「算法」下拉里换一个再试（例如 leader / birch / canopy），
                或到「聚类测试」页做多算法横向对比。
              </p>
            )}
          </section>

          <section className="card card-pad">
            <div className="clustering-section-head">
              <h2>二维分布</h2>
              <span className="small muted">点击图例或散点可高亮某个簇，右侧明细会同步过滤。</span>
            </div>
            <ClusterScatter
              points={result?.visualization ?? []}
              clusters={result?.clusters ?? []}
              items={result?.items ?? []}
              activeClusterId={activeClusterId}
              onPickCluster={(clusterId) => {
                setActiveClusterId(clusterId);
                setPage(1);
              }}
              onPickPoint={(pointId) => setSelectedId(pointId)}
            />
          </section>

          <section className="clustering-cluster-grid">
            {(result?.clusters ?? []).map((cluster) => (
              <ClusterCard
                key={cluster.clusterId}
                cluster={cluster}
                active={activeClusterId === cluster.clusterId}
                onToggle={() => {
                  setActiveClusterId(activeClusterId === cluster.clusterId ? null : cluster.clusterId);
                  setPage(1);
                }}
                onPickItem={(id) => setSelectedId(id)}
              />
            ))}
          </section>

          <section className="card">
            <div className="clustering-toolbar card-pad">
              <h2 className="clustering-table-title">样本归属明细</h2>
              <span className="small muted">
                共 {filteredItems.length} 条{highlighted ? `（已过滤：${highlighted.label}）` : ''}
              </span>
              {activeClusterId !== null && (
                <button className="btn btn-outline btn-sm" onClick={() => { setActiveClusterId(null); setPage(1); }}>
                  清除过滤
                </button>
              )}
            </div>
            <div className="clustering-table-scroll">
              <table className="table clustering-table">
                <thead>
                  <tr>
                    <th>ID</th><th>文本</th><th>所属簇</th><th>置信度</th><th>到质心距离</th><th>关键词</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={item.id} onClick={() => setSelectedId(item.id)}>
                      <td className="clustering-id">{item.id}</td>
                      <td><div className="clustering-text" title={item.text}>{item.text}</div></td>
                      <td>
                        <span className="cluster-pill" style={{ background: clusterTint(item.clusterId, 0.14), color: clusterColor(item.clusterId) }}>
                          <span className="cluster-legend-dot" style={{ background: clusterColor(item.clusterId) }} />
                          {item.clusterLabel}
                        </span>
                      </td>
                      <td>{item.confidence === null || item.confidence === undefined ? '—' : item.confidence.toFixed(3)}</td>
                      <td>{item.distance === null || item.distance === undefined ? '—' : item.distance.toFixed(3)}</td>
                      <td className="clustering-keywords">{item.keywords.slice(0, 3).join('、') || '—'}</td>
                      <td>
                        <button className="btn btn-outline btn-sm" onClick={(event) => { event.stopPropagation(); setSelectedId(item.id); }}>
                          详情
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!visibleItems.length && (
                    <tr><td colSpan={7} className="clustering-empty">没有符合当前过滤条件的样本。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="clustering-pagination">
              <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
              <span>{currentPage} / {pageCount}</span>
              <button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
            </div>
          </section>
        </>
      )}

      {!summary && dataset && engine.ready && (
        <section className="card clustering-placeholder">
          <IconLayers size={26} />
          <p>数据已就绪（{dataset.items.length} 条样本），点击「开始聚类」查看簇结构与二维分布。</p>
        </section>
      )}

      {selected && summary && (
        <ClusterItemDetail item={selected} summary={summary} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

/** 单个簇的摘要卡片：关键词 + 元数据分布 + 代表样本。 */
function ClusterCard({
  cluster,
  active,
  onToggle,
  onPickItem,
}: {
  cluster: ClusteringClusterGroup;
  active: boolean;
  onToggle: () => void;
  onPickItem: (id: string) => void;
}) {
  const isNoise = cluster.clusterId < 0;
  const distributions = Object.entries(cluster.metadataDistribution).slice(0, 3);
  return (
    <article
      className={`card card-pad cluster-card ${active ? 'is-active' : ''}`}
      style={{ borderColor: active ? clusterColor(cluster.clusterId) : undefined }}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${active ? '取消高亮' : '高亮'} ${cluster.label}（${cluster.size} 条）`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <header className="cluster-card-head">
        <span className="cluster-legend-dot" style={{ background: clusterColor(cluster.clusterId) }} />
        <h3>{cluster.label}</h3>
        <span className="cluster-card-size">{cluster.size} 条</span>
      </header>
      {isNoise && <p className="small muted">该组为算法判定为噪声/离群的样本（未归入任何簇）。</p>}
      {cluster.cohesion !== null && cluster.cohesion !== undefined && (
        <p className="small muted">簇内平均余弦相似度：{cluster.cohesion.toFixed(3)}</p>
      )}
      {cluster.keywords.length > 0 && (
        <div className="cluster-card-keywords">
          {cluster.keywords.map((word) => <span key={word} className="chip cluster-keyword">{word}</span>)}
        </div>
      )}
      {distributions.length > 0 && (
        <div className="cluster-card-meta">
          {distributions.map(([key, counts]) => (
            <p key={key} className="small">
              <span className="muted">{key}：</span>
              {counts.slice(0, 3).map((entry) => `${entry.value}(${entry.count})`).join(' · ')}
            </p>
          ))}
        </div>
      )}
      {cluster.representativeSamples.length > 0 && (
        <div className="cluster-card-samples">
          <span className="small muted">代表样本</span>
          {cluster.representativeSamples.slice(0, 3).map((sample) => (
            <button
              key={sample.id}
              className="cluster-sample"
              onClick={(event) => { event.stopPropagation(); onPickItem(sample.id); }}
              title={sample.text}
            >
              {sample.text}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
