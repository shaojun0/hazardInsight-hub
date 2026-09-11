/**
 * localStorage 持久化：最近一次分析结果 + 已保存的隐患记录 + 工作台设置（思考强度）。
 */
import type { AnalysisResult } from '../../shared/types';
import { isReasoningEffort, type ReasoningEffort } from '../../shared/agent-protocol';

export interface SavedImage {
  dataUrl: string;
  name: string;
}

export interface SavedRecord {
  id: string;
  analysisId: string;
  title: string;
  savedAt: string;
  mode: 'ai';
  overallRisk: string | null;
  hazardCount: number;
  image?: SavedImage;
  analysis: AnalysisResult;
}

const LAST_RESULT_KEY = 'hazard.lastResult.v1';
const RECORDS_KEY = 'hazard.records.v1';
const DRAFT_KEY = 'hazard.draft.v1';
const REASONING_EFFORT_KEY = 'hazard.reasoningEffort.v1';

/**
 * 思考强度（DeepSeek reasoning effort）持久化。
 * 用户从未配置（或旧配置缺少该字段）时返回 null，由调用方回退默认值 low。
 */
export function loadReasoningEffort(): ReasoningEffort | null {
  try {
    const raw = localStorage.getItem(REASONING_EFFORT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isReasoningEffort(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveReasoningEffort(effort: ReasoningEffort): void {
  try {
    localStorage.setItem(REASONING_EFFORT_KEY, JSON.stringify(effort));
  } catch {
    // 存储满时静默失败，不影响本次内存态使用
  }
}

/**
 * 工作台草稿：上传图片后立即持久化，页面刷新/切换后仍可恢复。
 * phase=ready 表示图片已就绪尚未识别；phase=analyzing 记录 runId 以便从后端重新附着。
 */
export interface WorkbenchDraft {
  phase: 'ready' | 'analyzing';
  image: SavedImage | null;
  scenario?: string | null;
  taskId?: string;
  runId?: string;
  updatedAt: string;
}

interface PersistedResult {
  analysis: AnalysisResult;
  image: SavedImage | null;
  scenario?: string | null;
  savedAt: string;
}

export function loadLastResult(): PersistedResult | null {
  try {
    const raw = localStorage.getItem(LAST_RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedResult;
    if (!parsed.analysis?.analysisId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLastResult(analysis: AnalysisResult, image: SavedImage | null, scenario?: string | null): void {
  try {
    localStorage.setItem(
      LAST_RESULT_KEY,
      JSON.stringify({ analysis, image, scenario: scenario ?? null, savedAt: new Date().toISOString() })
    );
  } catch {
    // 存储满时静默失败，不影响使用
  }
}

export function clearLastResult(): void {
  try {
    localStorage.removeItem(LAST_RESULT_KEY);
  } catch {
    /* noop */
  }
}

export function loadDraft(): WorkbenchDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkbenchDraft;
    if (!parsed.phase || !parsed.image) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(draft: Omit<WorkbenchDraft, 'updatedAt'>): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }));
  } catch {
    // 存储满时静默失败，不影响使用
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* noop */
  }
}

export function loadRecords(): SavedRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecord(record: SavedRecord): SavedRecord[] {
  const records = [record, ...loadRecords()].slice(0, 30);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    /* noop */
  }
  return records;
}

export function removeRecord(id: string): SavedRecord[] {
  const records = loadRecords().filter((r) => r.id !== id);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    /* noop */
  }
  return records;
}

export function addOrMergeLastRecord(analysis: AnalysisResult, image: SavedImage | null): SavedRecord[] {
  const existing = loadRecords().find((r) => r.analysisId === analysis.analysisId);
  const record: SavedRecord = {
    id: existing?.id ?? `rec-${Date.now()}`,
    analysisId: analysis.analysisId,
    title: `分析 ${analysis.analysisId} · ${new Date(analysis.createdAt).toLocaleString('zh-CN')}`,
    savedAt: new Date().toISOString(),
    mode: analysis.mode,
    overallRisk: analysis.overallRisk ? `${analysis.overallRisk} 级` : null,
    hazardCount: analysis.hazards.length,
    image: image ?? undefined,
    analysis,
  };
  const records = [record, ...loadRecords().filter((r) => r.id !== record.id)].slice(0, 30);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    /* noop */
  }
  return records;
}
