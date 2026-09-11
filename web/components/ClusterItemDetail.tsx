/**
 * 单个样本的聚类归属详情（抽屉）。
 *
 * 交互与 `HazardTestDetail` 保持一致：Esc 关闭、点遮罩关闭、焦点先落在关闭按钮、
 * Tab 在抽屉内循环，避免键盘用户跑到背景内容上。
 */

import { useEffect, useRef } from 'react';
import type { ClusteringResultItem, ClusteringSummary } from '../../shared/clustering';
import { clusterColor } from '../lib/clusterColor';
import { IconX } from './icons';

interface Props {
  item: ClusteringResultItem;
  summary: ClusteringSummary;
  onClose: () => void;
}

export function ClusterItemDetail({ item, summary, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [onClose]);

  const metadata = Object.entries(item.metadata);

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer cluster-item-detail" role="dialog" aria-modal="true" aria-labelledby="cluster-item-title" ref={dialogRef}>
        <div className="drawer-head">
          <h3 id="cluster-item-title">样本详情 · {item.id}</h3>
          <button ref={closeRef} className="btn btn-outline btn-sm" onClick={onClose}>
            <IconX size={14} />关闭
          </button>
        </div>
        <div className="drawer-body">
          <div className="cluster-item-summary">
            <p>
              <span className="cluster-legend-dot" style={{ background: clusterColor(item.clusterId) }} />
              <strong>所属簇：</strong>
              {item.clusterLabel}
              {item.clusterId < 0 && <span className="tag cluster-noise-tag">噪声点</span>}
            </p>
            <p><strong>置信度：</strong>{item.confidence === null || item.confidence === undefined ? '—' : item.confidence.toFixed(3)}<span className="small muted"> （与簇质心的余弦相似度映射到 0~1）</span></p>
            <p><strong>到质心距离：</strong>{item.distance === null || item.distance === undefined ? '—' : item.distance.toFixed(4)}</p>
            {item.keywords.length > 0 && (
              <p><strong>关键词：</strong>{item.keywords.map((word) => <span key={word} className="chip cluster-keyword">{word}</span>)}</p>
            )}
          </div>

          <h4>参与聚类的文本</h4>
          <p className="cluster-prewrap">{item.text}</p>

          <h4>业务字段</h4>
          {metadata.length ? (
            <table className="table">
              <thead><tr><th>字段</th><th>取值</th></tr></thead>
              <tbody>
                {metadata.map(([key, value]) => (
                  <tr key={key}><td>{key}</td><td>{formatValue(value)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="small muted">该样本没有随附业务字段。</p>}

          <h4>本次运行的归属</h4>
          <p className="small muted">
            运行 ID：{summary.runId}<br />
            算法：{summary.algorithm} · Profile：{summary.profileId}<br />
            向量模型：{summary.modelId}（{summary.embeddingDimension} 维）
          </p>
        </div>
      </div>
    </>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
