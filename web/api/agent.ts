/** Agent SSE 客户端：multipart POST + fetch ReadableStream 解析真实 workflow 事件。 */
import type { AgentRunResponse, AgentRunSnapshot, AgentStreamEvent, FrontendAgentState } from '../../shared/agent-protocol';
import type { AnalysisResult } from '../../shared/types';
import { createAgentTaskId, getAgentIdentity } from '../agent/session';
import { ApiError } from './client';

export interface AgentAnalyzeOptions extends Partial<FrontendAgentState> {
  taskId?: string;
  scenario?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
}

export async function analyzeImageStream(file: File, options: AgentAnalyzeOptions = {}): Promise<AgentRunResponse> {
  const identity = getAgentIdentity();
  const fd = new FormData();
  fd.append('image', file, file.name);
  fd.append('source', options.source ?? 'workbench');
  fd.append('conversationId', identity.conversationId);
  fd.append('sessionId', identity.sessionId);
  fd.append('taskId', options.taskId ?? createAgentTaskId());
  fd.append('locale', options.locale ?? 'zh-CN');
  if (options.scenario) fd.append('scenario', options.scenario);
  if (options.reasoningEffort) fd.append('reasoningEffort', options.reasoningEffort);
  if (options.deviceId) fd.append('deviceId', options.deviceId);
  if (options.stationId) fd.append('stationId', options.stationId);

  const response = await fetch('/api/agent/runs/stream', { method: 'POST', body: fd, signal: options.signal });
  if (!response.ok) {
    let message = `创建 Agent run 失败（HTTP ${response.status}）`;
    let code = 'HTTP_ERROR';
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      message = body.error ?? message;
      code = body.code ?? code;
    } catch {
      // 非 JSON 错误响应
    }
    throw new ApiError(message, code, response.status);
  }
  if (!response.body) throw new ApiError('浏览器不支持流式响应。', 'STREAM_UNAVAILABLE');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AnalysisResult | null = null;
  let runId = '';
  let mode: 'ai' = 'ai';
  let terminalError: ApiError | null = null;

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = JSON.parse(data) as AgentStreamEvent;
    runId = event.runId || runId;
    options.onEvent?.(event);
    if (event.type === 'result.completed') {
      const payload = event.payload as { data?: AnalysisResult };
      if (payload.data) {
        result = payload.data;
        mode = payload.data.mode;
      }
    } else if (event.type === 'run.failed') {
      const payload = event.payload as { message?: string; code?: string };
      terminalError = new ApiError(payload.message ?? 'Agent 运行失败。', payload.code ?? 'AGENT_RUN_FAILED');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consumeBlock(block);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (terminalError) throw terminalError;
  if (!result) throw new ApiError('Agent 流已结束，但未返回结构化结果。', 'STREAM_NO_RESULT');
  return { ok: true, mode, runId, data: result };
}

/**
 * 按 runId 查询后端 run 快照（页面刷新/切页后恢复任务状态用）。
 * 后端 run store 保留 run 状态与最终 result；404（不存在/已过期）返回 null。
 */
export async function fetchAgentRun(runId: string): Promise<AgentRunSnapshot | null> {
  try {
    const res = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      let message = `查询任务状态失败（HTTP ${res.status}）`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        /* 非 JSON 响应 */
      }
      throw new ApiError(message, 'HTTP_ERROR', res.status);
    }
    const body = (await res.json()) as { data?: AgentRunSnapshot };
    return body.data ?? null;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null; // 网络异常视为不可恢复
  }
}

/** 增量拉取 run 事件（after = 已消费的最大 sequence），用于断流后继续展示进度。 */
export async function fetchRunEvents(runId: string, after = 0): Promise<AgentStreamEvent[]> {
  const res = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/events?after=${after}`);
  if (!res.ok) {
    let message = `拉取任务事件失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new ApiError(message, 'HTTP_ERROR', res.status);
  }
  const body = (await res.json()) as { data?: AgentStreamEvent[] };
  return body.data ?? [];
}
