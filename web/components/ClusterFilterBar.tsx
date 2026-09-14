/**
 * 簇筛选条：把「图例高亮」升级为**可多选的归属筛选**。
 *
 * 交互约定（两个页面共用，保证行为一致）：
 * - 未选中任何簇 = 不过滤，全部样本展示。
 * - 选中一个或多个簇 = 只保留这些簇的样本，可跨簇多选。
 * - 筛选结果实时反映到样本明细表，不影响后端计算与散点图。
 *
 * 与散点图的高亮（activeClusterId）是两个独立概念：
 * 高亮是「看图时淡化其他点」，筛选是「看表时剔除其他行」。
 *
 * 展示策略（因为某些算法会分出上百个簇，如 chinese_whispers）：
 * - 按**簇内样本数降序**排列，最大的簇排最前，用户最关心的先看到。
 * - 最多渲染 `MAX_VISIBLE` 个，超出部分折叠并给出计数提示。
 * - **已选中的簇始终可见**，即使排在截断线之后 —— 否则用户勾选后它
 *   会从视野里消失，导致无法取消该选择。
 */

import type { ClusteringClusterGroup } from '../../shared/clustering';
import { clusterColor } from '../lib/clusterColor';

/** 筛选条最多渲染多少个簇，超出折叠。 */
export const MAX_VISIBLE = 50;

interface Props {
  clusters: ClusteringClusterGroup[];
  /** 已选中的簇 ID 集合；空集表示不过滤。 */
  selected: number[];
  onChange: (next: number[]) => void;
  /** 过滤后剩余样本数，用于右侧计数展示。 */
  matchCount?: number;
  /** 过滤前样本总数，用于右侧计数展示。 */
  totalCount?: number;
}

/**
 * 排序：噪声点（id 为 -1）恒排最前，其余按 size 降序。
 * 噪声不是「簇」，放在开头当独立类别更符合直觉；
 * size 相同时按 clusterId 升序，保证结果稳定（避免同 size 时顺序抖动）。
 */
export function orderClusters(clusters: ClusteringClusterGroup[]): ClusteringClusterGroup[] {
  return [...clusters].sort((a, b) => {
    const aNoise = a.clusterId === -1 ? 1 : 0;
    const bNoise = b.clusterId === -1 ? 1 : 0;
    if (aNoise !== bNoise) return bNoise - aNoise;
    if (b.size !== a.size) return b.size - a.size;
    return a.clusterId - b.clusterId;
  });
}

export function ClusterFilterBar({ clusters, selected, onChange, matchCount, totalCount }: Props) {
  const chosen = new Set(selected);
  const toggle = (clusterId: number) => {
    onChange(chosen.has(clusterId) ? selected.filter((id) => id !== clusterId) : [...selected, clusterId]);
  };

  const ordered = orderClusters(clusters);
  const capped = ordered.length > MAX_VISIBLE;
  // 截断：前 MAX_VISIBLE 个，外加任何已选中的（保证能被取消）。
  const visible = capped
    ? ordered.filter((cluster, index) => index < MAX_VISIBLE || chosen.has(cluster.clusterId))
    : ordered;
  const hiddenCount = ordered.length - visible.length;

  return (
    <div className="cluster-filter" role="group" aria-label="按所属簇筛选样本">
      <span className="cluster-filter-label">所属簇</span>
      {visible.map((cluster) => {
        const active = chosen.has(cluster.clusterId);
        return (
          <button
            key={cluster.clusterId}
            type="button"
            className={`cluster-filter-item ${active ? 'is-active' : ''}`}
            aria-pressed={active}
            style={active ? { borderColor: clusterColor(cluster.clusterId), color: clusterColor(cluster.clusterId) } : undefined}
            title={cluster.keywords.length ? `关键词：${cluster.keywords.join('、')}` : cluster.label}
            onClick={() => toggle(cluster.clusterId)}
          >
            <span className="cluster-legend-dot" style={{ background: clusterColor(cluster.clusterId) }} />
            <span className="cluster-filter-name">{cluster.label}</span>
            <span className="cluster-legend-size">{cluster.size}</span>
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <span className="cluster-filter-more" title={`另有 ${hiddenCount} 个簇未展示，可继续用关键词搜索定位样本`}>
          还有 {hiddenCount} 个簇未展示
        </span>
      )}
      {selected.length > 0 && (
        <>
          <span className="cluster-filter-count">
            命中 {matchCount ?? 0} / {totalCount ?? 0} 条
          </span>
          <button type="button" className="cluster-legend-clear" onClick={() => onChange([])}>
            清除过滤
          </button>
        </>
      )}
      {selected.length === 0 && clusters.length > 0 && (
        <span className="cluster-filter-hint">按样本数降序，可多选，未选时展示全部样本</span>
      )}
    </div>
  );
}
