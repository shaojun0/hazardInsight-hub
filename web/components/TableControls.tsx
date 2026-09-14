/**
 * 明细表的表头单元件：可排序表头 + 可筛选表头下拉 + 关键词搜索框。
 *
 * 抽出来的原因：两个页面（聚类展示 / 聚类测试）表列一致，
 * 表头交互必须完全一致，否则会分叉维护。
 *
 * 交互约定：
 * - 排序表头（置信度 / 到质心距离）：点一次降序、再点升序、第三次取消。
 *   用箭头指示当前方向；未排序时不显示箭头，避免视觉噪音。
 * - 筛选表头（所属簇 / 关键词）：点击展开下拉，多选，实时生效；
 *   有选中项时表头显示计数徽标。
 * - 下拉用「点击外部关闭」的轻量实现，不引第三方 popover 依赖。
 */

import { useEffect, useRef, useState } from 'react';
import { clusterColor } from '../lib/clusterColor';
import type { SortDirection, SortKey } from '../lib/useTableQuery';

/** 让「点击外部关闭」的公共逻辑只写一次。 */
function useOutsideClose<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);
  return ref;
}

function Caret({ direction }: { direction: SortDirection | null }) {
  return (
    <span className={`th-caret ${direction ?? 'none'}`} aria-hidden="true">
      <svg width="8" height="12" viewBox="0 0 8 12" fill="none">
        <path d="M4 1.5 7 5.5H1L4 1.5Z" fill="currentColor" opacity={direction === 'asc' ? 1 : 0.28} />
        <path d="M4 10.5 1 6.5h6L4 10.5Z" fill="currentColor" opacity={direction === 'desc' ? 1 : 0.28} />
      </svg>
    </span>
  );
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  direction: SortDirection | null;
  onToggle: (key: SortKey) => void;
  /** 悬停提示，说明排序语义（如「降序 = 置信度高在前」）。 */
  hint?: string;
}

export function SortHeader({ label, sortKey, direction, onToggle, hint }: SortHeaderProps) {
  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  return (
    <th aria-sort={ariaSort} className="th-sortable">
      <button
        type="button"
        className={`th-btn ${direction ? 'is-active' : ''}`}
        title={hint ?? `按${label}排序`}
        onClick={() => onToggle(sortKey)}
      >
        {label}
        <Caret direction={direction} />
      </button>
    </th>
  );
}

interface FilterHeaderProps {
  label: string;
  /** 已选数量，用于徽标。 */
  selectedCount: number;
  /** 下拉里的候选是否已经选满（用于「全选」按钮文案）。 */
  children: (close: () => void) => React.ReactNode;
}

export function FilterHeader({ label, selectedCount, children }: FilterHeaderProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useOutsideClose<HTMLDivElement>(open, close);

  return (
    <th className="th-filterable">
      <div className="th-filter-wrap" ref={ref}>
        <button
          type="button"
          className={`th-btn ${selectedCount ? 'is-active' : ''}`}
          aria-expanded={open}
          aria-haspopup="true"
          title={`筛选${label}`}
          onClick={() => setOpen((value) => !value)}
        >
          {label}
          {selectedCount > 0 && <span className="th-badge">{selectedCount}</span>}
          <span className={`th-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M1.5 3 4.5 6 7.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {open && (
          <div className="th-popover" role="dialog" aria-label={`${label}筛选`}>
            {children(close)}
          </div>
        )}
      </div>
    </th>
  );
}

interface OptionListProps {
  options: { key: string; label: string; count?: number; color?: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
  emptyText: string;
  searchPlaceholder?: string;
}

/** 下拉里的多选候选列表；选项多时内置搜索框（关键词可能有上百个）。 */
export function OptionList({
  options,
  selected,
  onToggle,
  onClear,
  emptyText,
  searchPlaceholder,
}: OptionListProps) {
  const [query, setQuery] = useState('');
  const chosen = new Set(selected);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  return (
    <div className="th-popover-body">
      {searchPlaceholder && options.length > 8 && (
        <input
          className="th-popover-search"
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="th-popover-list">
        {visible.map((option) => {
          const active = chosen.has(option.key);
          return (
            <label key={option.key} className={`th-option ${active ? 'is-active' : ''}`}>
              <input type="checkbox" checked={active} onChange={() => onToggle(option.key)} />
              {option.color && <span className="cluster-legend-dot" style={{ background: option.color }} />}
              <span className="th-option-label" title={option.label}>{option.label}</span>
              {option.count !== undefined && <span className="th-option-count">{option.count}</span>}
            </label>
          );
        })}
        {!visible.length && <p className="th-popover-empty">{emptyText}</p>}
      </div>
      {selected.length > 0 && (
        <button type="button" className="th-popover-clear" onClick={onClear}>
          清除{selected.length}项选择
        </button>
      )}
    </div>
  );
}

interface KeywordSearchProps {
  value: string;
  onChange: (next: string) => void;
  /** 搜索框下方的候选词，点击即填入（避免用户手打错字）。 */
  suggestions?: string[];
  placeholder?: string;
}

/** 关键词搜索输入：带清空按钮与候选词快填。 */
export function KeywordSearch({ value, onChange, suggestions = [], placeholder }: KeywordSearchProps) {
  return (
    <div className="kw-search">
      <div className="kw-search-field">
        <svg className="kw-search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.4" stroke="currentColor" strokeWidth="1.5" />
          <path d="m9.4 9.4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          className="kw-search-input"
          value={value}
          placeholder={placeholder ?? '搜索关键词，如：护栏、脚手架'}
          aria-label="按关键词搜索样本"
          onChange={(event) => onChange(event.target.value)}
        />
        {value && (
          <button type="button" className="kw-search-clear" aria-label="清空关键词搜索" onClick={() => onChange('')}>
            ×
          </button>
        )}
      </div>
      {suggestions.length > 0 && !value && (
        <div className="kw-search-suggest">
          <span className="kw-search-suggest-label">常用：</span>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="kw-search-chip"
              onClick={() => onChange(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 关键词单元格：搜索时把命中的片段高亮，让「为什么这行被选中」一目了然。
 * 只显示前 3 个词，与表格的紧凑排版一致（与导出 CSV 的全量词不同）。
 */
export function KeywordCells({ keywords, search }: { keywords: string[]; search: string }) {
  const shown = keywords.slice(0, 3);
  if (!shown.length) return <>—</>;
  const needle = search.trim().toLowerCase();
  return (
    <>
      {shown.map((keyword, index) => {
        const hit = needle.length > 0 && keyword.toLowerCase().includes(needle);
        return (
          <span key={`${keyword}-${index}`}>
            {index > 0 && '、'}
            {hit ? <mark className="kw-hit">{keyword}</mark> : keyword}
          </span>
        );
      })}
    </>
  );
}

export { clusterColor };
