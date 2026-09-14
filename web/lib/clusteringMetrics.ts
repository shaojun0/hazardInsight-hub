/**
 * 外部指标（ARI / VM / FMS / AMI / HS / CS）在界面上的纯逻辑。
 *
 * 这些指标必须有真实类别标签才能算，因此界面既要能展示"算出来的指标"，
 * 也要能区分"没算（数据集没标签）"与"归档回退（历史作业用论文数据）"两种情况——
 * 把三种来源混在一起显示，等于让观众无法判断屏幕上这行数字到底从哪来。
 */

import type {
  ClusteringBaselineMetrics,
  ClusteringDatasetItem,
  ClusteringGroundTruth,
  ClusteringJobInfo,
  ClusteringOfflineBaseline,
  ClusteringSummary,
} from '../../shared/clustering';

/** 真值列候选（与后端 `cluster_evaluation.GROUND_TRUTH_FIELDS` 保持一致）。 */
export const GROUND_TRUTH_LABEL_FIELDS: readonly string[] = [
  'category',
  'label',
  'true_label',
  'target',
  'class',
  '类别',
  '标签',
];

/** 界面展示顺序：6 项外部指标。 */
export const METRIC_DEFINITIONS: ReadonlyArray<{ key: keyof ClusteringBaselineMetrics; label: string }> = [
  { key: 'ari', label: 'ARI' },
  { key: 'vm', label: 'VM' },
  { key: 'fms', label: 'FMS' },
  { key: 'ami', label: 'AMI' },
  { key: 'hs', label: 'HS' },
  { key: 'cs', label: 'CS' },
];

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * 找出数据集里可作为真值的列。
 *
 * 与后端同口径：必须**每条样本**都带同一个非空标签才算，只标注了一部分就返回
 * null——否则指标会偏向被标注的那部分，看起来更"准"却更危险。
 */
export function detectLabelField(items: ClusteringDatasetItem[]): string | null {
  if (!items.length) return null;
  const actualByLower = new Map<string, string>();
  for (const item of items) {
    for (const key of Object.keys(item.metadata ?? {})) {
      const lower = key.trim().toLowerCase();
      if (!actualByLower.has(lower)) actualByLower.set(lower, key);
    }
  }
  for (const field of GROUND_TRUTH_LABEL_FIELDS) {
    const actual = actualByLower.get(field);
    if (!actual) continue;
    if (items.every((item) => hasValue(item.metadata?.[actual]))) return actual;
  }
  return null;
}

/** 指标取值的展示文本：缺失显示占位，绝不把 null 当成 0。 */
export function formatMetricValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

/** 差值展示：ARI 相对增益按百分比，其余按三位小数并带正负号。 */
export function formatDelta(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (key === 'ariRelative') return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
  if (key === 'nClusters') return `${value >= 0 ? '+' : ''}${value}`;
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

export interface MetricRow {
  key: string;
  label: string;
  value: number | null | undefined;
  display: string;
}

/** 主运行 / 对照运行的 6 项指标行。 */
export function metricRows(values: ClusteringBaselineMetrics | null | undefined): MetricRow[] {
  return METRIC_DEFINITIONS.map(({ key, label }) => {
    const value = values?.[key] ?? null;
    return { key: String(key), label, value, display: formatMetricValue(value ?? undefined) };
  });
}

/** 差值行：6 项指标 + ARI 相对增益。 */
export function comparisonRows(comparison: Record<string, number> | null | undefined): MetricRow[] {
  const rows: MetricRow[] = METRIC_DEFINITIONS.map(({ key, label }) => {
    const value = comparison?.[String(key)] ?? null;
    return { key: String(key), label, value, display: formatDelta(String(key), value) };
  });
  if (comparison && 'ariRelative' in comparison) {
    const value = comparison.ariRelative;
    rows.push({ key: 'ariRelative', label: 'ARI 相对增益', value, display: formatDelta('ariRelative', value) });
  }
  return rows;
}

/** 本次运行是否真的算出了外部指标。 */
export function hasComputedMetrics(summary: ClusteringSummary | null | undefined): boolean {
  return Boolean(summary?.metrics);
}

/** 是否有「净化关」对照运行的结果。 */
export function hasControlMetrics(summary: ClusteringSummary | null | undefined): boolean {
  return Boolean(summary?.metrics && summary?.controlMetrics);
}

/** 真值来源说明：`标注列 category · 20,198 / 20,198 条`。 */
export function describeGroundTruth(groundTruth: ClusteringGroundTruth | null | undefined): string {
  if (!groundTruth) return '';
  return `标注列 ${groundTruth.field} · ${groundTruth.labeled} / ${groundTruth.total} 条`;
}

/**
 * 这条历史作业是否该回退到论文归档。
 *
 * 判据是"作业样本数与归档的全量口径一致"：只有整份测试集的运行才与归档可比，
 * 抽样运行拿归档数字去对比会得出错误结论。
 */
export function shouldUseArchivedBenchmark(
  job: ClusteringJobInfo,
  baseline: ClusteringOfflineBaseline | null,
  summary: ClusteringSummary | null | undefined,
): boolean {
  if (!baseline?.fullRun) return false;
  const fullCount = baseline.fullRunItemCount;
  if (!fullCount || fullCount <= 0) return false;
  if (hasComputedMetrics(summary)) return false;
  return job.itemCount === fullCount;
}

/** 归档对比的列（基线 / 目标 / 论文报告），缺行则整列省略。 */
export function archivedBenchmarkColumns(
  baseline: ClusteringOfflineBaseline,
): Array<{ key: string; row: ClusteringBaselineMetrics }> {
  const candidates = [baseline.baselineKey, baseline.targetKey, 'paper_report'];
  const columns: Array<{ key: string; row: ClusteringBaselineMetrics }> = [];
  for (const key of candidates) {
    if (!key) continue;
    const row = baseline.rows[key];
    if (row) columns.push({ key, row });
  }
  return columns;
}

/** 归档行的中文列名：把 `nr0_legacy` 这类键翻译成人话，找不到映射就回显键名。 */
export function archivedColumnLabel(key: string): string {
  const known: Record<string, string> = {
    nr0_legacy: '基线 nr0',
    nr1_legacy_purification_off: 'nr1（净化关）',
    spear_purified_purification_on: 'spear_purified（净化开）',
    spear_purified_retrieval_purification_on: '完整框架（净化开）',
    paper_report: '论文报告值',
  };
  return known[key] ?? key;
}
