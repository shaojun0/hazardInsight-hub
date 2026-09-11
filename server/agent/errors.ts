/** Runtime 统一错误；HTTP 层只返回安全 message/code，详细 cause 留在服务端 trace。 */
export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export function normalizeAgentError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  const e = error as Error & { code?: string };
  return new AgentRuntimeError(e?.message || 'Agent 运行异常', e?.code || 'INTERNAL', false, error);
}

