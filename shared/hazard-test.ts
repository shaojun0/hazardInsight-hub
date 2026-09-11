import type { AnalysisResult, Grade } from './types.js';

export const TEST_GRADES = ['A', 'B', 'C', 'D'] as const;
export const TEST_REQUIRED_FIELDS = ['隐患描述', '隐患级别'] as const;
export const TEST_MAX_CONCURRENCY = 16;
export const TEST_MIN_OUTPUT_TOKENS = 6400;
export const TEST_MAX_OUTPUT_TOKENS = 32000;
export interface HazardTestOptions {
  concurrency: number;
  maxOutputTokens: number;
}
export const DEFAULT_TEST_OPTIONS: HazardTestOptions = { concurrency: 1, maxOutputTokens: TEST_MIN_OUTPUT_TOKENS };
export interface HazardTestDataset {
  id: string;
  fileName: string;
  total: number;
  headers: string[];
  labeled: number;
  gradeCounts: Record<Grade, number>;
  warnings: string[];
}
export interface HazardTestRow {
  index: number;
  sourceData: Record<string, string>;
  expected: Grade | null;
  actual: Grade | null;
  accuracy: Record<Grade, boolean | null> & { overall: boolean | null };
  differences: Grade[];
  status: 'pending' | 'running' | 'success' | 'failed';
  analysis?: AnalysisResult;
  agentRawOutput: string;
  runId?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface TestAccuracy {
  correct: number;
  valid: number;
  percent: number | null;
}
export interface HazardTestStats {
  total: number;
  completed: number;
  success: number;
  failed: number;
  correct: number;
  incorrect: number;
  unscored: number;
  overall: TestAccuracy;
  /** 对每个等级判断“属于/不属于”是否正确，包含真阴性。 */
  byGrade: Record<Grade, TestAccuracy>;
  /** 标准答案为该等级的样本命中率；无正样本时为 null。 */
  recall: Record<Grade, TestAccuracy>;
}
export interface HazardTestJob {
  id: string;
  options: HazardTestOptions;
  dataset: HazardTestDataset;
  status: 'running' | 'stopping' | 'completed' | 'stopped';
  createdAt: string;
  completedAt?: string;
  rows: HazardTestRow[];
  stats: HazardTestStats;
}
