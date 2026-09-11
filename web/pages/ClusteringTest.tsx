/**
 * 聚类测试（工程验证视角）。
 *
 * 与「聚类展示」的分工：展示页关注结果呈现，本页关注**引擎本身是否工作正常**——
 * 服务就绪状态、算法/profile 可用性、单次运行的逐条归属，以及同一批数据在不同
 * 算法下的横向对比（簇数、噪声、耗时、是否命中向量缓存）。
 *
 * 所有计算同样全部委托给 Python 聚类服务，前端不做任何算法近似。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClusteringData,
  ClusteringDatasetItem,
  ClusteringResultItem,
} from '../../shared/clustering';
import { fetchClusteringSample, runClustering, uploadClusteringDataset } from '../api/clustering';
import { ClusterItemDetail } from '../components/ClusterItemDetail';
import { IconDownload, IconPlay, IconRefresh, IconUpload } from '../components/icons';
import { clusterColor, clusterTint } from '../lib/clusterColor';
import { useClusterEngine } from '../lib/useClusterEngine';
import './Clustering.css';

type Mode = 'single' | 'compare';

/** 一行一个样本，便于手工粘贴小批量文本做冒烟测试。 */
function parsePastedText(raw: string): ClusteringDatasetItem[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ id: `line-${index + 1}`, text: line, metadata: {} }));
}

interface ComparisonRow {
  algorithm: string;
  ok: boolean;
  clusterCount?: number;
  noiseCount?: number;
  elapsedMs?: number;
  gatewayMs?: number;
  cacheHit?: boolean;
  profileId?: string;
  message?: string;
}

export function ClusteringTest() {
  const engine = useClusterEngine();
  const [mode, setMode] = useState<Mode>('single');
  const [items, setItems] = useState<ClusteringDatasetItem[]>([]);
  const [sourceName, setSourceName] = useState('');
  const [pasted, setPasted] = useState('');
  const [algorithm, setAlgorithm] = useState('');
  const [profileId, setProfileId] = useState('');
  const [selectedAlgorithms, setSelectedAlgorithms] = useState<string[]>([]);
  const [result, setResult] = useState<ClusteringData | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSample = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const sample = await fetchClusteringSample();
      setItems(sample.items);
      setSourceName(sample.sourceName);
      setPasted('');
      setResult(null);
      setComparison([]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadSample();
  }, [loadSample]);

  const availableAlgorithms = useMemo(
    () => engine.algorithms.filter((item) => item.available).map((item) => item.algorithm),
    [engine.algorithms],
  );

  const selectableProfiles = useMemo(
    () => engine.profiles.filter((profile) => profile.available && (!algorithm || profile.algorithm === algorithm)),
    [engine.profiles, algorithm],
  );

  useEffect(() => {
    if (profileId && !selectableProfiles.some((profile) => profile.profileId === profileId)) {
      setProfileId('');
    }
  }, [profileId, selectableProfiles]);

  const upload = useCallback(async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const preview = await uploadClusteringDataset(file);
      setItems(preview.items);
      setSourceName(`${preview.sourceName}（上传）`);
      setPasted('');
      setResult(null);
      setComparison([]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const applyPasted = useCallback(() => {
    const parsed = parsePastedText(pasted);
    if (parsed.length < 2) {
      setError('手工输入至少需要 2 行文本才能聚类。');
      return;
    }
    setItems(parsed);
    setSourceName(`手工输入（${parsed.length} 条）`);
    setResult(null);
    setComparison([]);
    setError('');
  }, [pasted]);

  const startSingle = useCallback(async () => {
    setRunning(true);
    setError('');
    setProgress('');
    try {
      const next = await runClustering(items, {
        algorithm: algorithm || undefined,
        profileId: profileId || undefined,
        visualize: false,
      });
      setResult(next);
      setComparison([]);
      setSelectedId(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRunning(false);
    }
  }, [items, algorithm, profileId]);

  const startCompare = useCallback(async () => {
    if (selectedAlgorithms.length < 2) {
      setError('多算法对比至少选择 2 个算法。');
      return;
    }
    setRunning(true);
    setError('');
    setResult(null);
    setComparison([]);
    const rows: ComparisonRow[] = [];
    for (let index = 0; index < selectedAlgorithms.length; index += 1) {
      const name = selectedAlgorithms[index];
      setProgress(`正在运行 ${name}（${index + 1}/${selectedAlgorithms.length}）…`);
      try {
        const data = await runClustering(items, { algorithm: name, visualize: false });
        rows.push({
          algorithm: name,
          ok: true,
          clusterCount: data.summary.clusterCount,
          noiseCount: data.summary.noiseCount,
          elapsedMs: data.summary.elapsedMs,
          gatewayMs: data.summary.gatewayMs,
          cacheHit: data.summary.cacheHit,
          profileId: data.summary.profileId,
        });
      } catch (cause) {
        rows.push({ algorithm: name, ok: false, message: (cause as Error).message });
      }
      setComparison([...rows]);
    }
    setRunning(false);
    setProgress('');
    if (!rows.some((row) => row.ok)) setError('全部算法均执行失败，请查看上方失败原因。');
  }, [items, selectedAlgorithms]);

  const selected = result?.items.find((item) => item.id === selectedId) ?? null;

  const exportCsv = useCallback(() => {
    if (!result) return;
    const header = ['id', 'cluster_id', 'cluster_label', 'confidence', 'distance', 'keywords', 'text'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      header.join(','),
      ...result.items.map((item) => [
        item.id,
        item.clusterId,
        item.clusterLabel,
        item.confidence ?? '',
        item.distance ?? '',
        item.keywords.join(' '),
        item.text,
      ].map(escape).join(',')),
    ];
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clustering-${result.summary.runId}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [result]);

  const toggleAlgorithm = (name: string) => {
    setSelectedAlgorithms((previous) =>
      previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name],
    );
  };

  const engineStatus = engine.health?.engine;

  return (
    <div className="page clustering-page">
      <div className="page-head">
        <h1>聚类分析 · 聚类测试</h1>
        <div className="sub">
          检查 Python 聚类服务的就绪状态、算法与配置档可用性，并对同一批数据做单次运行或多算法横向对比。
        </div>
      </div>

      {engine.error && (
        <div className="card card-pad clustering-banner is-error" role="alert">
          <strong>无法连接聚类服务</strong>
          <p className="small">{engine.error}</p>
          <p className="small muted">请在项目根目录执行 <code>npm run dev:py</code> 启动服务后重新检查。</p>
        </div>
      )}

      {error && (
        <div className="card card-pad clustering-banner is-error" role="alert">
          <strong>测试失败</strong>
          <p className="small">{error}</p>
        </div>
      )}

      <section className="card card-pad">
        <div className="clustering-section-head">
          <h2>服务与引擎状态</h2>
          <div className="clustering-head-actions">
            <span className={`clustering-status ${engine.ready ? 'is-ok' : 'is-bad'}`}>
              {engine.loading ? '检查中' : engine.ready ? '就绪' : '不可用'}
            </span>
            <button className="btn btn-outline btn-sm" disabled={engine.loading} onClick={() => void engine.refresh()}>
              <IconRefresh size={14} />重新校验
            </button>
          </div>
        </div>
        {engine.health ? (
          <div className="clustering-kv-grid">
            <div><span>服务</span><strong>{engine.health.service}</strong></div>
            <div><span>版本</span><strong>{engine.health.version}</strong></div>
            <div><span>健康状态</span><strong>{engine.health.status}</strong></div>
            <div><span>引擎已加载</span><strong>{engineStatus?.loaded ? '是' : '否'}</strong></div>
            <div><span>配置文件</span><strong>{engineStatus?.configFile ?? '—'}</strong></div>
            <div><span>可用 profile</span><strong>{engineStatus?.profilesAvailable ?? 0} / {engineStatus?.profilesTotal ?? 0}</strong></div>
            <div><span>向量模型</span><strong>{engineStatus?.modelId ?? '—'}</strong></div>
            <div><span>模型维度</span><strong>{engineStatus?.modelDimension ?? '—'}</strong></div>
            <div><span>模型提供方</span><strong>{engineStatus?.modelProvider ?? '—'}</strong></div>
          </div>
        ) : (
          <p className="small muted">尚未获取到服务状态。</p>
        )}
        {engineStatus?.message && <p className="clustering-notice">{engineStatus.message}</p>}
        {engineStatus && engineStatus.algorithmsAvailable.length > 0 && (
          <p className="small muted">
            当前可执行算法 {engineStatus.algorithmsAvailable.length} 种：{engineStatus.algorithmsAvailable.join('、')}
          </p>
        )}
      </section>

      <section className="card card-pad">
        <div className="clustering-section-head"><h2>算法与配置档可用性</h2></div>
        <div className="clustering-table-scroll">
          <table className="table clustering-table">
            <thead>
              <tr><th>算法</th><th>可执行</th><th>后端</th><th>样本上限</th><th>说明</th></tr>
            </thead>
            <tbody>
              {engine.algorithms.map((item) => (
                <tr key={item.algorithm}>
                  <td>{item.algorithm}</td>
                  <td>{item.available ? <span className="clustering-status is-ok">可用</span> : <span className="clustering-status is-bad">不可用</span>}</td>
                  <td>{item.backend}</td>
                  <td>{item.maxSamples}</td>
                  <td className="clustering-note">{item.warnings.join(' ') || '—'}</td>
                </tr>
              ))}
              {!engine.algorithms.length && <tr><td colSpan={5} className="clustering-empty">尚未获取到算法清单。</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="clustering-table-scroll clustering-mt">
          <table className="table clustering-table">
            <thead>
              <tr><th>Profile</th><th>算法</th><th>模型</th><th>检索增强</th><th>样本上限</th><th>状态</th></tr>
            </thead>
            <tbody>
              {engine.profiles.map((profile) => (
                <tr key={profile.profileId}>
                  <td className="clustering-id">{profile.profileId}</td>
                  <td>{profile.algorithm}</td>
                  <td>{profile.modelId}</td>
                  <td>{Number(profile.features.n_results ?? 0) > 0 ? `top-${String(profile.features.n_results)}` : '否'}</td>
                  <td>{profile.maxSamples}</td>
                  <td>
                    {profile.available
                      ? <span className="clustering-status is-ok">可执行</span>
                      : <span className="clustering-status is-bad" title={profile.unavailableReason ?? ''}>{profile.unavailableReason ?? '不可用'}</span>}
                  </td>
                </tr>
              ))}
              {!engine.profiles.length && <tr><td colSpan={6} className="clustering-empty">尚未获取到 profile 清单。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card card-pad">
        <div className="clustering-section-head">
          <h2>测试数据</h2>
          <div className="clustering-head-actions">
            <button className="btn btn-outline btn-sm" disabled={busy || running} onClick={() => void loadSample()}>载入示例数据</button>
            <label className={`btn btn-outline btn-sm clustering-upload ${busy || running ? 'is-disabled' : ''}`}>
              <IconUpload size={14} />上传文件
              <input
                aria-label="上传测试数据文件"
                type="file"
                accept=".csv,.json,.xlsx,.txt"
                disabled={busy || running}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void upload(file);
                }}
              />
            </label>
          </div>
        </div>
        <p className="small muted">当前数据：<strong>{sourceName || '—'}</strong> · 共 {items.length} 条样本</p>
        <label className="clustering-paste">
          手工输入（每行一条，至少 2 行）
          <textarea
            className="textarea"
            rows={4}
            value={pasted}
            disabled={running}
            placeholder={'现场作业区域未设置警戒围栏\n脚手架搭设缺少连墙件\n配电箱未上锁且无警示标识'}
            onChange={(event) => setPasted(event.target.value)}
          />
        </label>
        <button className="btn btn-outline btn-sm" disabled={running || !pasted.trim()} onClick={applyPasted}>使用手工输入</button>
      </section>

      <section className="card card-pad">
        <div className="clustering-section-head">
          <h2>执行测试</h2>
          <div className="clustering-mode-switch">
            <button className={mode === 'single' ? 'active' : ''} disabled={running} onClick={() => setMode('single')}>单次运行</button>
            <button className={mode === 'compare' ? 'active' : ''} disabled={running} onClick={() => setMode('compare')}>多算法对比</button>
          </div>
        </div>

        {mode === 'single' ? (
          <div className="clustering-toolbar">
            <label>
              算法
              <select className="select" value={algorithm} disabled={running || !engine.ready} onChange={(event) => setAlgorithm(event.target.value)}>
                <option value="">自动选择（推荐）</option>
                {availableAlgorithms.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label>
              配置档 Profile
              <select className="select" value={profileId} disabled={running || !engine.ready} onChange={(event) => setProfileId(event.target.value)}>
                <option value="">自动选择</option>
                {selectableProfiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>{profile.profileId}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" disabled={running || !engine.ready || items.length < 2} onClick={() => void startSingle()}>
              <IconPlay size={15} />{running ? '执行中…' : '执行聚类'}
            </button>
          </div>
        ) : (
          <>
            <div className="clustering-check-grid">
              {engine.algorithms.map((item) => (
                <label key={item.algorithm} className={`clustering-check-card ${!item.available ? 'is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={!item.available || running}
                    checked={selectedAlgorithms.includes(item.algorithm)}
                    onChange={() => toggleAlgorithm(item.algorithm)}
                  />
                  {item.algorithm}
                </label>
              ))}
            </div>
            <div className="clustering-toolbar">
              <button className="btn btn-primary" disabled={running || !engine.ready || items.length < 2 || selectedAlgorithms.length < 2} onClick={() => void startCompare()}>
                <IconPlay size={15} />{running ? '执行中…' : `对比运行（已选 ${selectedAlgorithms.length} 个）`}
              </button>
              {progress && <span className="small muted" role="status">{progress}</span>}
            </div>
          </>
        )}
      </section>

      {comparison.length > 0 && (
        <section className="card">
          <div className="clustering-toolbar card-pad">
            <h2 className="clustering-table-title">算法对比结果</h2>
            <span className="small muted">同一批数据、同一向量模型，仅算法不同。</span>
          </div>
          <div className="clustering-table-scroll">
            <table className="table clustering-table">
              <thead>
                <tr><th>算法</th><th>Profile</th><th>簇数量</th><th>噪声点</th><th>引擎耗时</th><th>网关耗时</th><th>向量缓存</th><th>状态</th></tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.algorithm}>
                    <td>{row.algorithm}</td>
                    <td className="clustering-id">{row.profileId ?? '—'}</td>
                    <td>{row.clusterCount ?? '—'}</td>
                    <td>{row.noiseCount ?? '—'}</td>
                    <td>{row.elapsedMs === undefined ? '—' : `${row.elapsedMs} ms`}</td>
                    <td>{row.gatewayMs === undefined ? '—' : `${row.gatewayMs} ms`}</td>
                    <td>{row.cacheHit === undefined ? '—' : row.cacheHit ? '命中' : '未命中'}</td>
                    <td>
                      {row.ok
                        ? <span className="clustering-status is-ok">成功</span>
                        : <span className="clustering-status is-bad" title={row.message}>{row.message ?? '失败'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result && (
        <>
          <section className="card clustering-stat-grid" aria-label="本次运行统计">
            {[
              ['样本总数', String(result.summary.totalSamples)],
              ['簇数量', String(result.summary.clusterCount)],
              ['噪声点', String(result.summary.noiseCount)],
              ['算法', result.summary.algorithm],
              ['引擎耗时', `${result.summary.elapsedMs} ms`],
              ['网关耗时', `${result.summary.gatewayMs} ms`],
            ].map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </section>

          <section className="card">
            <div className="clustering-toolbar card-pad">
              <h2 className="clustering-table-title">逐条归属结果</h2>
              <span className="small muted">运行 ID：{result.summary.runId} · Profile：{result.summary.profileId}</span>
              <button className="btn btn-outline btn-sm clustering-export" onClick={exportCsv}>
                <IconDownload size={14} />导出 CSV
              </button>
            </div>
            <div className="clustering-table-scroll">
              <table className="table clustering-table">
                <thead>
                  <tr><th>ID</th><th>文本</th><th>所属簇</th><th>置信度</th><th>到质心距离</th><th>关键词</th></tr>
                </thead>
                <tbody>
                  {result.items.map((item) => (
                    <tr key={item.id} onClick={() => setSelectedId(item.id)}>
                      <td className="clustering-id">{item.id}</td>
                      <td><div className="clustering-text" title={item.text}>{item.text}</div></td>
                      <td>
                        <ClusterPill item={item} />
                      </td>
                      <td>{item.confidence === null || item.confidence === undefined ? '—' : item.confidence.toFixed(3)}</td>
                      <td>{item.distance === null || item.distance === undefined ? '—' : item.distance.toFixed(3)}</td>
                      <td className="clustering-keywords">{item.keywords.slice(0, 3).join('、') || '—'}</td>
                    </tr>
                  ))}
                  {!result.items.length && <tr><td colSpan={6} className="clustering-empty">本次运行没有返回样本归属。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {selected && result && (
        <ClusterItemDetail item={selected} summary={result.summary} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function ClusterPill({ item }: { item: ClusteringResultItem }) {
  return (
    <span className="cluster-pill" style={{ background: clusterTint(item.clusterId, 0.14), color: clusterColor(item.clusterId) }}>
      <span className="cluster-legend-dot" style={{ background: clusterColor(item.clusterId) }} />
      {item.clusterLabel}
    </span>
  );
}
