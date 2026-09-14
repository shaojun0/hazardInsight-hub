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

/**
 * 成员归属状态的中文说明。
 *
 * `semantic-v1` 用这套状态取代了"要么属于某簇、要么是噪声"的二分：
 * 同为未归类，`noise`（不属任何主题）与 `invalid`（规范化后没有有效语义）
 * 是两个完全不同的原因，混在一起会让用户以为是自己数据的问题。
 */
const ASSIGNMENT_LABELS: Record<string, string> = {
  core: '核心成员（同时通过绝对语义门槛与簇半径）',
  borderline: '边界成员（语义达标，但离两个簇都不够远）',
  small_coherent: '小簇成员（数量少但组内自洽，已保留）',
  duplicate_only: '重复文本（多条相同文本构成，语义质量不评分）',
  noise: '未归类（不属任何主题）',
  invalid: '无效文本（规范化后没有可用的语义内容）',
};

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
              {item.clusterId < 0 && <span className="tag cluster-noise-tag">未归类</span>}
            </p>
            {/* assignmentStatus 比 clusterId 更细：同为未归类，噪声与无效文本是两回事 */}
            {item.assignmentStatus && (
              <p>
                <strong>归属状态：</strong>
                {ASSIGNMENT_LABELS[item.assignmentStatus] ?? item.assignmentStatus}
                {item.noiseReason && <span className="small muted"> （原因：{item.noiseReason}）</span>}
              </p>
            )}
            <p><strong>置信度：</strong>{item.confidence === null || item.confidence === undefined ? '—' : item.confidence.toFixed(3)}<span className="small muted"> （与簇质心的{item.distanceMetric === 'cosine' ? '余弦' : ''}相似度映射到 0~1）</span></p>
            <p><strong>到质心距离：</strong>{item.distance === null || item.distance === undefined ? '—' : item.distance.toFixed(4)}<span className="small muted"> （{item.distanceMetric === 'cosine' ? '余弦距离' : '欧氏距离'}）</span></p>
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
