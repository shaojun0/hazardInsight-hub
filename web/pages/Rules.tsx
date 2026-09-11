import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Grade, GradingRule } from '../../shared/types';
import { GRADE_DEFINITIONS } from '../../shared/grading-meta';
import { clearRulesApi, fetchRules, importDemoRules, importRulesFile } from '../api/rules';
import { IconFileText, IconInfo, IconRefresh, IconTrash, IconUpload } from '../components/icons';

export function Rules() {
  const [rules, setRules] = useState<GradingRule[]>([]);
  const [level, setLevel] = useState('全部');
  const [q, setQ] = useState('');
  const [feedback, setFeedback] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const r = await fetchRules();
    setRules(r.data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onPickFile = async (file: File | undefined | null) => {
    if (!file) return;
    try {
      const r = await importRulesFile(file);
      setRules(r.data);
      setFeedback(`导入成功（${file.name} · ${r.format?.toUpperCase() ?? ''}）：新增 ${r.added} 条，当前判定规则共 ${r.total} 条。`);
    } catch (e) {
      setFeedback(`导入失败：${(e as Error).message}（TXT：「级别 类目… 编码 判定内容」；CSV：「级别,类目…,编码,判定内容」，支持表头）`);
    }
  };

  const loadDemo = async () => {
    try {
      const r = await importDemoRules();
      setRules(r.data);
      setFeedback(`已载入内置演示示例：新增 ${r.added} 条，当前共 ${r.total} 条。`);
    } catch {
      setFeedback('载入演示示例失败');
    }
  };

  const clearAll = async () => {
    const r = await clearRulesApi();
    setRules(r.data);
    setFeedback('已清空导入的判定规则（分级规则不受影响）。');
  };

  const filtered = useMemo(
    () =>
      rules.filter((r) => {
        if (level !== '全部' && r.level !== level) return false;
        if (q && !`${r.code}${r.text}${r.categoryPath}${r.levelName}`.includes(q)) return false;
        return true;
      }),
    [rules, level, q]
  );

  const stats = useMemo(() => {
    const a = rules.filter((r) => r.level === 'a').length;
    const b = rules.filter((r) => r.level === 'b').length;
    const starred = rules.filter((r) => r.starred).length;
    return { a, b, other: rules.length - a - b, starred };
  }, [rules]);

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>定级规则库</h1>
          <div className="sub">包含内置的 A/B/C/D 分级规则，以及从 TXT 导入的行业判定规则，用于隐患定级与整改依据参考。</div>
        </div>
        <div className="row">
          <button className="btn btn-outline" onClick={() => void loadDemo()}>
            <IconRefresh size={14} />
            载入演示示例
          </button>
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            <IconUpload size={14} />
            导入规则 TXT
          </button>
          <button className="btn btn-danger-soft" onClick={() => void clearAll()}>
            <IconTrash size={14} />
            清空导入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv,application/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onPickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {feedback && (
        <div className="disclaimer-bar" style={{ marginBottom: 16, color: 'var(--text-2)' }}>
          <IconInfo size={13} />
          {feedback}
        </div>
      )}

      {/* 概览 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 16 }}>
        <RuleStat label="内置分级规则" value="4 条" sub="A / B / C / D" tone="var(--primary)" />
        <RuleStat label="已导入判定规则" value={`${rules.length} 条`} sub="来源：TXT 导入" tone="var(--text)" />
        <RuleStat label="基础管理类（a）" value={`${stats.a} 条`} sub={`加星 ${rules.filter((r) => r.level === 'a' && r.starred).length} · 演示`} tone="#d2413e" />
        <RuleStat label="现场作业类（b）" value={`${stats.b} 条`} sub={`加星 ${rules.filter((r) => r.level === 'b' && r.starred).length} · 演示`} tone="#2f6f9f" />
      </div>

      {/* 分级规则 */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="section-label">A/B/C/D 隐患分级规则</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {(['A', 'B', 'C', 'D'] as Grade[]).map((g) => (
            <div key={g} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className={`grade-badge grade-${g}`} style={{ height: 22 }}>
                  <span className="flag" />
                  {g} 级
                </span>
                <b style={{ fontSize: 13, color: 'var(--navy)' }}>{GRADE_DEFINITIONS[g].label}</b>
              </div>
              <div className="small muted" style={{ lineHeight: 1.7 }}>{GRADE_DEFINITIONS[g].rule}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 导入规则 */}
      <div className="card">
        <div className="card-pad filter-bar" style={{ paddingBottom: 12 }}>
          <div className="section-label" style={{ margin: 0, width: '100%' }}>已导入判定规则</div>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="搜索编码 / 类目 / 判定内容" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" style={{ width: 150 }} value={level} onChange={(e) => setLevel(e.target.value)}>
            {['全部', 'a', 'b'].map((l) => (
              <option key={l} value={l}>{l === '全部' ? '全部级别' : l === 'a' ? '基础管理类（a）' : '现场作业类（b）'}</option>
            ))}
          </select>
          <span className="chip">共 {filtered.length} 条</span>
        </div>

        {filtered.length ? (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>类目</th>
                  <th>编码</th>
                  <th>判定内容</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td><span className={`tag tag-${r.level === 'a' ? 'general' : 'nuclear'}`}>{r.levelName}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.categoryPath || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className="mono" style={{ fontWeight: 700, color: r.starred ? 'var(--danger)' : 'var(--text)' }}>
                        {r.code}
                      </span>
                      {r.starred && <span className="chip" style={{ marginLeft: 6, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}>强条 *</span>}
                    </td>
                    <td style={{ maxWidth: 460 }}>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="state-block" style={{ padding: '36px 16px' }}>
            <div className="big-ico"><IconFileText size={26} /></div>
            <h3 style={{ fontSize: 14 }}>尚未导入判定规则</h3>
            <p>
              点击「导入规则 TXT」选择文件，或将演示样本导入体验。格式：<b className="mono">级别 类目… 编码 判定内容</b>，
              例如 <b className="mono">b 现场作业 隧道作业 BSD01*…</b>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RuleStat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
      <span style={{ width: 46, height: 46, borderRadius: 13, background: 'color-mix(in srgb, ' + tone + ' 13%, var(--surface))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: tone, fontSize: 14, textAlign: 'center' }}>
        {value}
      </span>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>{label}</div>
        <div className="small muted">{sub}</div>
      </div>
    </div>
  );
}
