/**
 * 明细表的「表头筛选 + 排序 + 关键词搜索」状态与派生逻辑。
 *
 * 两个页面（聚类展示 / 聚类测试）的表列结构一致，逻辑必须共用，
 * 否则同一操作在两页表现不同 —— 这里作为唯一实现，页面只负责渲染。
 *
 * 叠加顺序（重要，决定最终结果的语义）：
 *   1. 所属簇筛选（ClusterFilterBar，多选并集）
 *   2. 关键词搜索（按关键词列的文本做包含匹配）
 *   3. 关键词筛选（表头下拉，多选并集）
 *   4. 表头排序（单列，可升可降可取消）
 *
 * 之所以「搜索」排在「筛选」之前：搜索是自由检索（用户不知道确切有哪些
 * 关键词），筛选是枚举挑选（用户从已有词里选）。先检索后挑选，命中数
 * 与下拉候选都更贴近直觉。
 */

import { useCallback, useMemo, useState } from 'react';
import type { ClusteringResultItem } from '../../shared/clustering';

/** 可排序的数值列。文本列不参与排序（无稳定语义）。 */
export type SortKey = 'confidence' | 'distance';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface TableQueryState {
  /** 关键词自由搜索，空串 = 不过滤。 */
  keywordSearch: string;
  /** 表头「所属簇」下拉选中的簇 ID，空数组 = 不过滤。 */
  clusterColumnFilter: number[];
  /** 表头「关键词」下拉选中的关键词，空数组 = 不过滤。 */
  keywordColumnFilter: string[];
  /** 表头排序，null = 保持后端返回的原始顺序。 */
  sort: SortState | null;
}

export interface TableQueryApi extends TableQueryState {
  /** 行级「所属簇」筛选（上方 ClusterFilterBar 驱动）。 */
  setRowClusterFilter: (next: number[]) => void;
  rowClusterFilter: number[];
  setKeywordSearch: (value: string) => void;
  toggleClusterColumnFilter: (clusterId: number) => void;
  toggleKeywordColumnFilter: (keyword: string) => void;
  clearColumnFilters: () => void;
  /** 点击表头：无排序 → 降序 → 升序 → 取消。 */
  toggleSort: (key: SortKey) => void;
  /** 表头当前排序方向，用于渲染箭头。 */
  sortDirectionOf: (key: SortKey) => SortDirection | null;
  /** 任一列筛选/搜索处于激活状态（用于显示「清除」入口）。 */
  hasColumnFilter: boolean;
  /** 全部关键词候选（按出现次数降序），供表头下拉渲染。 */
  keywordOptions: { value: string; count: number }[];
  /** 全部簇候选（按簇号升序），供表头下拉渲染。 */
  clusterOptions: { clusterId: number; label: string; size: number }[];
  /** 应用全部筛选与排序后的结果。 */
  rows: ClusteringResultItem[];
}

const CONFIDENCE_KEY: SortKey = 'confidence';
const DISTANCE_KEY: SortKey = 'distance';

/** 数值列取不到值时统一排到末尾，避免 null 混进比较。 */
function sortValue(item: ClusteringResultItem, key: SortKey): number | null {
  const raw = key === CONFIDENCE_KEY ? item.confidence : item.distance;
  return raw === null || raw === undefined || Number.isNaN(raw) ? null : raw;
}

/**
 * 把「筛选 + 排序」的纯逻辑抽成独立函数：
 * hook 只负责持有状态，计算全部在这里完成，便于单元测试覆盖
 * （不依赖 React 渲染，也不必启动浏览器）。
 *
 * 顺序：所属簇筛选 → 关键词搜索 → 表头簇筛选 → 表头关键词筛选 → 排序。
 */
export function applyTableQuery(
  items: ClusteringResultItem[],
  query: Pick<TableQueryState, 'keywordSearch' | 'clusterColumnFilter' | 'keywordColumnFilter' | 'sort'>,
  rowClusterFilter: number[] = [],
): ClusteringResultItem[] {
  let next = items;

  if (rowClusterFilter.length) {
    const chosen = new Set(rowClusterFilter);
    next = next.filter((item) => chosen.has(item.clusterId));
  }

  const trimmed = query.keywordSearch.trim();
  if (trimmed) {
    const needle = trimmed.toLowerCase();
    next = next.filter((item) => item.keywords.some((keyword) => keyword.toLowerCase().includes(needle)));
  }

  if (query.clusterColumnFilter.length) {
    const chosen = new Set(query.clusterColumnFilter);
    next = next.filter((item) => chosen.has(item.clusterId));
  }

  if (query.keywordColumnFilter.length) {
    const chosen = new Set(query.keywordColumnFilter);
    next = next.filter((item) => item.keywords.some((keyword) => chosen.has(keyword)));
  }

  if (query.sort) {
    const { key, direction } = query.sort;
    const factor = direction === 'asc' ? 1 : -1;
    next = [...next].sort((a, b) => {
      const left = sortValue(a, key);
      const right = sortValue(b, key);
      // 缺失值恒沉底，不参与方向翻转。
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (left === right) return 0;
      return left < right ? -factor : factor;
    });
  }

  return next;
}

/** 统计关键词出现频次，用于表头下拉与搜索候选。 */
export function collectKeywordOptions(items: ClusteringResultItem[]): { value: string; count: number }[] {
  const counter = new Map<string, number>();
  for (const item of items) {
    for (const keyword of item.keywords) {
      counter.set(keyword, (counter.get(keyword) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'));
}

export function useTableQuery(
  items: ClusteringResultItem[] | undefined,
  clusters: { clusterId: number; label: string; size: number }[] | undefined,
): TableQueryApi {
  const [rowClusterFilter, setRowClusterFilter] = useState<number[]>([]);
  const [keywordSearch, setKeywordSearchRaw] = useState('');
  const [clusterColumnFilter, setClusterColumnFilter] = useState<number[]>([]);
  const [keywordColumnFilter, setKeywordColumnFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState | null>(null);

  const setKeywordSearch = useCallback((value: string) => {
    setKeywordSearchRaw(value);
  }, []);

  const toggleClusterColumnFilter = useCallback((clusterId: number) => {
    setClusterColumnFilter((previous) =>
      previous.includes(clusterId) ? previous.filter((id) => id !== clusterId) : [...previous, clusterId],
    );
  }, []);

  const toggleKeywordColumnFilter = useCallback((keyword: string) => {
    setKeywordColumnFilter((previous) =>
      previous.includes(keyword) ? previous.filter((item) => item !== keyword) : [...previous, keyword],
    );
  }, []);

  const clearColumnFilters = useCallback(() => {
    setKeywordSearchRaw('');
    setClusterColumnFilter([]);
    setKeywordColumnFilter([]);
  }, []);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((previous) => {
      if (!previous || previous.key !== key) return { key, direction: 'desc' };
      if (previous.direction === 'desc') return { key, direction: 'asc' };
      return null;
    });
  }, []);

  const sortDirectionOf = useCallback(
    (key: SortKey) => (sort?.key === key ? sort.direction : null),
    [sort],
  );

  /** 关键词候选：从全量样本统计词频，出现多的排前面。 */
  const keywordOptions = useMemo(() => collectKeywordOptions(items ?? []), [items]);

  const clusterOptions = useMemo(
    () => (clusters ?? []).map((cluster) => ({ clusterId: cluster.clusterId, label: cluster.label, size: cluster.size })),
    [clusters],
  );

  const rows = useMemo(
    () => applyTableQuery(items ?? [], { keywordSearch, clusterColumnFilter, keywordColumnFilter, sort }, rowClusterFilter),
    [items, rowClusterFilter, keywordSearch, clusterColumnFilter, keywordColumnFilter, sort],
  );

  const hasColumnFilter =
    keywordSearch.trim().length > 0 || clusterColumnFilter.length > 0 || keywordColumnFilter.length > 0;

  return {
    rowClusterFilter,
    setRowClusterFilter,
    keywordSearch,
    setKeywordSearch,
    clusterColumnFilter,
    toggleClusterColumnFilter,
    keywordColumnFilter,
    toggleKeywordColumnFilter,
    clearColumnFilters,
    sort,
    toggleSort,
    sortDirectionOf,
    hasColumnFilter,
    keywordOptions,
    clusterOptions,
    rows,
  };
}

export const SORT_KEYS = { confidence: CONFIDENCE_KEY, distance: DISTANCE_KEY } as const;
