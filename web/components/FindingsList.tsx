import { useState } from 'react';
import type { Finding } from '../lib/discovery';
import { GradeBadge } from './GradeBadge';
import { IconChevronDown, IconChevronRight, IconClipboard } from './icons';

interface Props {
  findings: Finding[];
  sourceLabel: string;
  onAddAll: () => void;
  onAddOne: (f: Finding) => void;
  emptyText?: string;
}

export function FindingsList({ findings, sourceLabel, onAddAll, onAddOne, emptyText }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (findings.length === 0) {
    return (
      <div className="state-block" style={{ padding: '26px 16px' }}>
        <h3 style={{ fontSize: 14 }}>{emptyText ?? `${sourceLabel}暂未发现隐患`}</h3>
        <p>可点击「抓拍」或「开始巡检」后重试。</p>
      </div>
    );
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 10 }}>
        <span className="chip">共 {findings.length} 处发现</span>
        <button className="btn btn-primary-soft btn-sm" onClick={onAddAll}>
          <IconClipboard size={13} />
          全部转入隐患台账
        </button>
      </div>
      {findings.map((f, i) => {
        const open = openId === f.id;
        return (
          <div className="card" key={f.id} style={{ marginBottom: 10, borderRadius: 12 }}>
            <div
              className="row"
              style={{ padding: '11px 14px', cursor: 'pointer', gap: 10, flexWrap: 'wrap' }}
              onClick={() => setOpenId(open ? null : f.id)}
            >
              <span
                style={{
                  width: 26, height: 26, borderRadius: 8, background: 'var(--ink-solid)', color: 'var(--on-ink)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flex: 'none',
                }}
              >
                {i + 1}
              </span>
              <GradeBadge grade={f.grade} showLabel={false} />
              <span className="tag tag-general" style={{ background: 'var(--primary-050)', color: 'var(--primary-700)' }}>{f.category}</span>
              <span style={{ flex: 1, minWidth: 180, fontWeight: 600, color: 'var(--navy)' }}>{f.title}</span>
              <span className="conf-chip" style={{ height: 20, fontSize: 11 }}>置信度 {Math.round(f.confidence * 100)}%</span>
              {open ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
            </div>
            {open && (
              <div style={{ padding: '0 14px 12px', borderTop: '1px solid var(--border)' }}>
                <div className="small" style={{ color: 'var(--text-2)', lineHeight: 1.7, marginTop: 10 }}>{f.description}</div>
                {f.possibleConsequence && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    <b>可能后果：</b>{f.possibleConsequence}
                  </div>
                )}
                {f.evidence.length > 0 && (
                  <div className="small" style={{ marginTop: 6, color: 'var(--text-2)' }}>
                    <b>识别依据：</b>{f.evidence.join('；')}
                  </div>
                )}
                {f.rectificationTexts.length > 0 && (
                  <div className="small" style={{ marginTop: 6, color: 'var(--text-2)' }}>
                    <b>整改建议：</b>{f.rectificationTexts.join('；')}
                  </div>
                )}
                <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary-soft btn-sm" onClick={() => onAddOne(f)}>
                    <IconClipboard size={13} />
                    转入台账
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
