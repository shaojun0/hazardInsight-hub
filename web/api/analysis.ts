/**
 * 分析领域 API：图片隐患识别与报告导出。
 */
import type { AnalysisResult } from '../../shared/types';
import { ApiError, parseRes } from './client';
import type { FrontendAgentState } from '../../shared/agent-protocol';
import { createAgentTaskId, getAgentIdentity } from '../agent/session';

export interface AnalyzeResponse {
  ok: boolean;
  mode: 'ai';
  runId?: string;
  data: AnalysisResult;
}

export async function analyzeImage(
  file: File,
  scenario?: string,
  context: Partial<FrontendAgentState> & { taskId?: string } = {}
): Promise<AnalyzeResponse> {
  const identity = getAgentIdentity();
  const fd = new FormData();
  fd.append('image', file, file.name);
  if (scenario) fd.append('scenario', scenario);
  fd.append('source', context.source ?? 'workbench');
  fd.append('conversationId', identity.conversationId);
  fd.append('sessionId', identity.sessionId);
  fd.append('taskId', context.taskId ?? createAgentTaskId());
  if (context.deviceId) fd.append('deviceId', context.deviceId);
  if (context.stationId) fd.append('stationId', context.stationId);
  if (context.reasoningEffort) fd.append('reasoningEffort', context.reasoningEffort);
  const res = await fetch('/api/analyze', { method: 'POST', body: fd });
  const body = await parseRes<AnalyzeResponse & { error?: string }>(res);
  return body as AnalyzeResponse;
}

export interface HTMLResponse {
  html: string;
}

export async function postExportReport(analysis: AnalysisResult, download = false): Promise<HTMLResponse> {
  const res = await fetch(`/api/export${download ? '?download=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis }),
  });
  if (!res.ok) throw new ApiError('导出报告失败', 'EXPORT_ERROR', res.status);
  return { html: await res.text() };
}
