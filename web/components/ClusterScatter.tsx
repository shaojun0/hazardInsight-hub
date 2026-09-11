/**
 * 二维聚类散点图（纯手写 SVG，不引入图表库）。
 *
 * 坐标来自后端 PCA 降维结果，**仅用于可视化**，不参与任何聚类计算。
 * 交互：悬停显示样本摘要，点击点或图例可高亮某个簇（其余淡化）。
 */

import { useMemo, useState } from 'react';
import type {
  ClusteringClusterGroup,
  ClusteringResultItem,
  ClusteringVisualizationPoint,
} from '../../shared/clustering';
import { clusterColor } from '../lib/clusterColor';

interface Props {
  points: ClusteringVisualizationPoint[];
  clusters: ClusteringClusterGroup[];
  items: ClusteringResultItem[];
  /** 当前高亮的簇；`null` 表示全部展示。 */
  activeClusterId: number | null;
  onPickCluster: (clusterId: number | null) => void;
  /** 点击单个样本时回调（用于打开详情）。 */
  onPickPoint?: (pointId: string) => void;
}

const W = 940;
const H = 460;
const PAD = { top: 22, right: 24, bottom: 34, left: 48 };

export function ClusterScatter({ points, clusters, items, activeClusterId, onPickCluster, onPickPoint }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const labelOf = useMemo(() => {
    const map = new Map<number, string>();
    clusters.forEach((cluster) => map.set(cluster.clusterId, cluster.label));
    return map;
  }, [clusters]);

  const itemOf = useMemo(() => {
    const map = new Map<string, ClusteringResultItem>();
    items.forEach((item) => map.set(item.id, item));
    return map;
  }, [items]);

  const scale = useMemo(() => {
    if (!points.length) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // 退化情况（所有点重合）时人为撑开范围，避免除零
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    return {
      x: (value: number) => PAD.left + ((value - minX) / spanX) * innerW,
      y: (value: number) => PAD.top + (1 - (value - minY) / spanY) * innerH,
      spanX: maxX - minX,
      spanY: maxY - minY,
    };
  }, [points]);

  if (!points.length || !scale) {
    return (
      <div className="cluster-scatter-empty">
        本次结果没有二维坐标。可能是样本数或向量维度不足，或该次请求关闭了可视化。
      </div>
    );
  }

  const hovered = hoverId ? itemOf.get(hoverId) : undefined;
  const hoveredPoint = hoverId ? points.find((p) => p.id === hoverId) : undefined;
  const tooltipX = hoveredPoint ? scale.x(hoveredPoint.x) : 0;
  const tooltipY = hoveredPoint ? scale.y(hoveredPoint.y) : 0;
  const tooltipLeft = tooltipX > W * 0.62;

  return (
    <div className="cluster-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="聚类结果二维散点图，可按下方图例高亮某个簇" className="cluster-scatter-svg">
        {/* 背景网格 */}
        <g className="cluster-scatter-grid">
          {Array.from({ length: 5 }, (_, index) => {
            const x = PAD.left + ((W - PAD.left - PAD.right) / 4) * index;
            const y = PAD.top + ((H - PAD.top - PAD.bottom) / 4) * index;
            return (
              <g key={index}>
                <line x1={x} y1={PAD.top} x2={x} y2={H - PAD.bottom} />
                <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} />
              </g>
            );
          })}
        </g>

        {/* 坐标轴 */}
        <g className="cluster-scatter-axis">
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} />
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} />
          <text x={W - PAD.right} y={H - PAD.bottom + 22} textAnchor="end">主成分 1</text>
          <text x={PAD.left - 8} y={PAD.top - 8} textAnchor="start">主成分 2</text>
          {scale.spanX > 0 && (
            <text x={PAD.left} y={H - PAD.bottom + 22} textAnchor="start" className="cluster-scatter-hint">
              跨度 {scale.spanX.toFixed(2)}
            </text>
          )}
          {scale.spanY > 0 && (
            <text x={PAD.left - 40} y={PAD.top + 10} className="cluster-scatter-hint">跨度 {scale.spanY.toFixed(2)}</text>
          )}
        </g>

        {/* 数据点：按簇分层绘制，保证高亮簇永远在最上层 */}
        <g>
          {points.map((point) => {
            const dim = activeClusterId !== null && point.clusterId !== activeClusterId;
            const item = itemOf.get(point.id);
            return (
              <circle
                key={point.id}
                cx={scale.x(point.x)}
                cy={scale.y(point.y)}
                r={point.id === hoverId ? 6.5 : dim ? 3 : 5}
                fill={clusterColor(point.clusterId)}
                opacity={dim ? 0.22 : 0.88}
                className={`cluster-scatter-dot ${point.id === hoverId ? 'is-hover' : ''}`}
                onMouseEnter={() => setHoverId(point.id)}
                onMouseLeave={() => setHoverId((current) => (current === point.id ? null : current))}
                onClick={() => {
                  if (item) onPickPoint?.(item.id);
                  onPickCluster(activeClusterId === point.clusterId ? null : point.clusterId);
                }}
              >
                <title>{`${labelOf.get(point.clusterId) ?? `簇 ${point.clusterId}`} · ${item?.text ?? point.id}`}</title>
              </circle>
            );
          })}
        </g>

        {/* 悬停提示 */}
        {hovered && hoveredPoint && (
          <g
            transform={`translate(${tooltipLeft ? tooltipX - 300 : tooltipX + 14}, ${Math.min(Math.max(tooltipY - 28, PAD.top), H - PAD.bottom - 74)})`}
            pointerEvents="none"
          >
            <rect width={286} height={68} rx={10} className="cluster-scatter-tip-bg" />
            <text x={12} y={22} className="cluster-scatter-tip-title">
              {labelOf.get(hoveredPoint.clusterId) ?? `簇 ${hoveredPoint.clusterId}`}
            </text>
            <text x={12} y={42} className="cluster-scatter-tip-line">
              {clip(hovered.text, 30)}
            </text>
            <text x={12} y={58} className="cluster-scatter-tip-line">
              {hovered.id} · 置信度 {formatConfidence(hovered.confidence)}
            </text>
          </g>
        )}
      </svg>

      <div className="cluster-legend" role="group" aria-label="簇图例">
        {clusters.map((cluster) => (
          <button
            key={cluster.clusterId}
            className={`cluster-legend-item ${activeClusterId === cluster.clusterId ? 'active' : ''}`}
            onClick={() => onPickCluster(activeClusterId === cluster.clusterId ? null : cluster.clusterId)}
            title={cluster.keywords.length ? `关键词：${cluster.keywords.join('、')}` : cluster.label}
          >
            <span className="cluster-legend-dot" style={{ background: clusterColor(cluster.clusterId) }} />
            <span className="cluster-legend-label">{cluster.label}</span>
            <span className="cluster-legend-size">{cluster.size}</span>
          </button>
        ))}
        {activeClusterId !== null && (
          <button className="cluster-legend-clear" onClick={() => onPickCluster(null)}>
            取消高亮
          </button>
        )}
      </div>
    </div>
  );
}

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function formatConfidence(value?: number | null) {
  return value === null || value === undefined ? '—' : value.toFixed(2);
}
