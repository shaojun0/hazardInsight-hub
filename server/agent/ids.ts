/** Agent/业务 ID 生成；使用 UUID 避免进程重启和多实例碰撞。 */
import { randomUUID } from 'node:crypto';
import type { AgentRunIds } from '../../shared/agent-protocol.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function acceptedOrNew(value: string | undefined, prefix: string): string {
  return value && SAFE_ID.test(value) ? value : `${prefix}_${randomUUID()}`;
}

function analysisId(): string {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `HAZ-${day}-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function createRunIds(input: {
  userId?: string;
  conversationId?: string;
  sessionId?: string;
  taskId?: string;
} = {}): AgentRunIds {
  return {
    userId: acceptedOrNew(input.userId, 'usr'),
    conversationId: acceptedOrNew(input.conversationId, 'conv'),
    sessionId: acceptedOrNew(input.sessionId, 'sess'),
    taskId: acceptedOrNew(input.taskId, 'task'),
    runId: `run_${randomUUID()}`,
    traceId: `trace_${randomUUID()}`,
    analysisId: analysisId(),
  };
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

export function newStepId(): string {
  return `step_${randomUUID()}`;
}

export function newToolCallId(): string {
  return `tool_${randomUUID()}`;
}

export function newLlmCallId(): string {
  return `llm_${randomUUID()}`;
}
