/** 统一工具执行：事件、timeout、latency、attempt 与 normalized error。 */
import { createHash } from 'node:crypto';
import type { AgentUiStage } from '../../../shared/agent-protocol.js';
import type { LLMCallPhase } from '../../../shared/token-usage.js';
import { AgentRuntimeError, normalizeAgentError } from '../errors.js';
import { newToolCallId } from '../ids.js';

export interface ToolExecutionSpec {
  name: string;
  version: string;
  sideEffect: 'none' | 'idempotent' | 'non_idempotent';
  timeoutMs: number;
  maxAttempts?: number;
  uiStage: AgentUiStage;
  inputForHash?: unknown;
  llmPhase?: LLMCallPhase;
}

export interface ToolExecutionMeta {
  toolCallId: string;
  name: string;
  version: string;
  attempts: number;
  latencyMs: number;
  inputHash: string;
}

export type ToolEventWriter = (
  type: 'tool.started' | 'tool.completed' | 'tool.failed',
  payload: Record<string, unknown>,
  uiStage: AgentUiStage
) => void;

function hashInput(input: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

export class ToolExecutor {
  constructor(private readonly writeEvent: ToolEventWriter) {}

  async execute<T>(
    spec: ToolExecutionSpec,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<{ data: T; meta: ToolExecutionMeta }> {
    const toolCallId = newToolCallId();
    const inputHash = hashInput(spec.inputForHash);
    const maxAttempts = Math.max(1, spec.maxAttempts ?? 1);
    const started = Date.now();
    this.writeEvent('tool.started', {
      toolCallId,
      tool: spec.name,
      version: spec.version,
      sideEffect: spec.sideEffect,
      inputHash,
      llmPhase: spec.llmPhase,
    }, spec.uiStage);

    let lastError: AgentRuntimeError | null = null;
    let executedAttempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      executedAttempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
      try {
        const data = await execute(controller.signal);
        clearTimeout(timer);
        const meta = {
          toolCallId,
          name: spec.name,
          version: spec.version,
          attempts: attempt,
          latencyMs: Date.now() - started,
          inputHash,
        };
        this.writeEvent('tool.completed', { ...meta, ...modelOutputMeta(data) }, spec.uiStage);
        return { data, meta };
      } catch (error) {
        clearTimeout(timer);
        lastError = controller.signal.aborted
          ? new AgentRuntimeError(`${spec.name} 执行超时`, 'TOOL_TIMEOUT', true, error)
          : normalizeAgentError(error);
        if (!lastError.retryable || attempt >= maxAttempts) break;
      }
    }
    const finalError = lastError ?? new AgentRuntimeError(`${spec.name} 执行失败`, 'TOOL_FAILED');
    this.writeEvent('tool.failed', {
      toolCallId,
      tool: spec.name,
      version: spec.version,
      code: finalError.code,
      message: finalError.message,
      latencyMs: Date.now() - started,
      attempts: executedAttempts,
    }, spec.uiStage);
    throw finalError;
  }
}

/**
 * Only expose provider diagnostics that are safe and useful for tracing.  The
 * model response body itself can contain user data and must never be copied to
 * an event payload.
 */
function modelOutputMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as {
    attempts?: unknown;
    requestId?: unknown;
    finishReason?: unknown;
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cachedTokens?: unknown;
      totalTokens?: unknown;
      cachedTokensAvailable?: unknown;
      cachedTokensAreInputSubset?: unknown;
      source?: unknown;
    };
  };
  if (
    candidate.attempts === undefined
    && candidate.requestId === undefined
    && candidate.finishReason === undefined
    && candidate.usage === undefined
  ) return {};

  const usage = candidate.usage && typeof candidate.usage === 'object'
    ? {
        inputTokens: typeof candidate.usage.inputTokens === 'number' ? candidate.usage.inputTokens : undefined,
        outputTokens: typeof candidate.usage.outputTokens === 'number' ? candidate.usage.outputTokens : undefined,
        cachedTokens: typeof candidate.usage.cachedTokens === 'number' ? candidate.usage.cachedTokens : undefined,
        totalTokens: typeof candidate.usage.totalTokens === 'number' ? candidate.usage.totalTokens : undefined,
        cachedTokensAvailable: typeof candidate.usage.cachedTokensAvailable === 'boolean' ? candidate.usage.cachedTokensAvailable : undefined,
        cachedTokensAreInputSubset: candidate.usage.cachedTokensAreInputSubset === true ? true : undefined,
        source: candidate.usage.source === 'provider' ? candidate.usage.source : undefined,
      }
    : undefined;

  return {
    providerAttempts: typeof candidate.attempts === 'number' ? candidate.attempts : undefined,
    requestId: typeof candidate.requestId === 'string' ? candidate.requestId : undefined,
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined,
    usage,
  };
}
