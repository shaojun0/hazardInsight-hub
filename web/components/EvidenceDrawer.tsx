import type { StandardReference } from '../../shared/types';
import { STANDARD_TYPE_LABEL } from '../lib/constants';
import { IconX } from './icons';

interface Props {
  open: boolean;
  reference: StandardReference | null;
  onClose: () => void;
}

export function EvidenceDrawer({ open, reference, onClose }: Props) {
  if (!open || !reference) return null;
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>法规依据详情</h3>
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            <IconX size={14} />
            关闭
          </button>
        </div>
        <div className="drawer-body">
          <div className="doc-hero">
            <div className="doc-code">{reference.documentCode} · v{reference.version}</div>
            <div className="doc-name">《{reference.documentName}》</div>
            <div className="doc-meta">来源类型：{STANDARD_TYPE_LABEL[reference.type]} · 分类：{reference.category}</div>
          </div>

          <div className="clause-block">
            <div className="clause-title">
              <span className="tag tag-general" style={{ marginRight: 8, background: 'var(--primary-050)', color: 'var(--primary-600)' }}>
                条款
              </span>
              第 {reference.clause} 条 · {reference.clauseTitle}
            </div>
            <div className="clause-content" style={{ marginTop: 8 }}>
              {reference.content}
            </div>
          </div>

          <div className="clause-block">
            <div className="clause-title">为什么引用该条款</div>
            <div className="clause-content" style={{ marginTop: 8, color: 'var(--text-2)' }}>
              {reference.reason}
            </div>
          </div>

          <div className="clause-block">
            <div className="clause-title">相关度</div>
            <div style={{ marginTop: 10 }}>
              <div style={{ height: 8, background: 'var(--primary-100)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round(reference.relevance * 100)}%`, background: 'var(--primary)' }} />
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                相关度 {Math.round(reference.relevance * 100)}%
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
