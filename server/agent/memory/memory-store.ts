/**
 * Demo Session Memory：仅保存结构化 run 摘要，不保存图片/base64，也不默认注入无关历史图片结论。
 * 生产环境可用同一接口替换为数据库与检索索引。
 */
import type { Grade } from '../../../shared/types.js';

export interface RunMemorySummary {
  runId: string;
  taskId: string;
  analysisId: string;
  hazardCount: number;
  overallRisk: Grade | null;
  fallbackUsed: boolean;
  requiresReview: boolean;
  createdAt: string;
}

export class SessionMemoryStore {
  private readonly summaries = new Map<string, RunMemorySummary[]>();

  record(conversationId: string, summary: RunMemorySummary): void {
    const list = this.summaries.get(conversationId) ?? [];
    const next = [summary, ...list.filter((item) => item.runId !== summary.runId)].slice(0, 20);
    this.summaries.set(conversationId, next);
  }

  /** 当前图片工作流只允许读取同 task 摘要，避免不同现场图片相互污染。 */
  selectForTask(conversationId: string, taskId: string, limit = 3): RunMemorySummary[] {
    return (this.summaries.get(conversationId) ?? []).filter((item) => item.taskId === taskId).slice(0, limit);
  }
}

