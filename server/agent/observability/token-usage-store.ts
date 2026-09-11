/**
 * 调用级 Token Ledger 与 Run/Session/Conversation 聚合。
 * Demo 使用有界内存；生产环境可按同一接口替换为 append-only 数据库表。
 */
import type { AgentRunIds } from '../../../shared/agent-protocol.js';
import type {
  ConversationTokenUsage,
  LLMCallPhase,
  LLMCallUsage,
  RunTokenUsage,
  SessionTokenUsage,
  TokenUsageAggregate,
  TokenUsageOverview,
} from '../../../shared/token-usage.js';
import type { ModelTokenUsage } from '../../providers/types.js';
import { newLlmCallId } from '../ids.js';

interface RunIdentity extends AgentRunIds {
  startedAt: string;
  completedAt?: string;
}

export interface StartLlmCallInput {
  toolCallId: string;
  ids: AgentRunIds;
  stepId?: string;
  stepKey?: string;
  provider: string;
  model: string;
  phase: LLMCallPhase;
  startedAt: string;
}

export class TokenUsageStore {
  private readonly calls = new Map<string, LLMCallUsage>();
  private readonly callIdByTool = new Map<string, string>();
  private readonly runIdentities = new Map<string, RunIdentity>();

  constructor(private readonly maxRuns = 200) {}

  registerRun(ids: AgentRunIds, startedAt: string): void {
    this.runIdentities.set(ids.runId, { ...ids, startedAt });
    this.prune();
  }

  completeRun(runId: string, completedAt: string): void {
    const identity = this.runIdentities.get(runId);
    if (identity) identity.completedAt = completedAt;
  }

  start(input: StartLlmCallInput): LLMCallUsage {
    const sequence = [...this.calls.values()].filter((call) => call.runId === input.ids.runId).length + 1;
    const call: LLMCallUsage = {
      callId: newLlmCallId(),
      runId: input.ids.runId,
      traceId: input.ids.traceId,
      taskId: input.ids.taskId,
      conversationId: input.ids.conversationId,
      sessionId: input.ids.sessionId,
      stepId: input.stepId,
      stepKey: input.stepKey,
      sequence,
      provider: input.provider,
      model: input.model,
      phase: input.phase,
      status: 'running',
      usageSource: 'unavailable',
      usageAvailable: false,
      cachedTokensAvailable: false,
      cachedTokensAreInputSubset: true,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      uncachedInputTokens: 0,
      totalTokens: 0,
      cacheHitRate: 0,
      latencyMs: 0,
      providerAttempts: 1,
      startedAt: input.startedAt,
    };
    this.calls.set(call.callId, call);
    this.callIdByTool.set(input.toolCallId, call.callId);
    return { ...call };
  }

  completeByTool(
    toolCallId: string,
    input: { usage?: ModelTokenUsage; latencyMs: number; providerAttempts?: number; completedAt: string }
  ): LLMCallUsage | null {
    const call = this.byTool(toolCallId);
    if (!call) return null;
    const usage = input.usage;
    const inputTokens = whole(usage?.inputTokens);
    const outputTokens = whole(usage?.outputTokens);
    const cachedTokens = Math.min(inputTokens, whole(usage?.cachedTokens));
    Object.assign(call, {
      status: 'completed' as const,
      usageSource: usage?.source ?? 'unavailable',
      usageAvailable: Boolean(usage),
      cachedTokensAvailable: Boolean(usage?.cachedTokensAvailable),
      inputTokens,
      outputTokens,
      cachedTokens,
      uncachedInputTokens: Math.max(0, inputTokens - cachedTokens),
      totalTokens: usage ? whole(usage.totalTokens) : 0,
      cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
      latencyMs: whole(input.latencyMs),
      providerAttempts: Math.max(1, whole(input.providerAttempts) || 1),
      completedAt: input.completedAt,
    });
    return { ...call };
  }

  failByTool(
    toolCallId: string,
    input: { latencyMs: number; providerAttempts?: number; completedAt: string; errorCode?: string }
  ): LLMCallUsage | null {
    const call = this.byTool(toolCallId);
    if (!call) return null;
    Object.assign(call, {
      status: 'failed' as const,
      latencyMs: whole(input.latencyMs),
      providerAttempts: Math.max(1, whole(input.providerAttempts) || 1),
      completedAt: input.completedAt,
      errorCode: input.errorCode,
    });
    return { ...call };
  }

  getRun(runId: string): RunTokenUsage | null {
    const identity = this.runIdentities.get(runId);
    if (!identity) return null;
    const calls = [...this.calls.values()]
      .filter((call) => call.runId === runId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((call) => ({ ...call }));
    return {
      scope: 'run',
      runId,
      traceId: identity.traceId,
      taskId: identity.taskId,
      conversationId: identity.conversationId,
      sessionId: identity.sessionId,
      startedAt: identity.startedAt,
      completedAt: identity.completedAt,
      calls,
      ...aggregateCalls(calls),
    };
  }

  getSession(sessionId: string): SessionTokenUsage {
    const runs = this.runsWhere((run) => run.sessionId === sessionId);
    return {
      scope: 'session',
      sessionId,
      conversationId: runs[0]?.conversationId ?? '',
      startedAt: firstTimestamp(runs),
      completedAt: lastTimestamp(runs),
      runs,
      ...aggregateCalls(runs.flatMap((run) => run.calls)),
    };
  }

  getConversation(conversationId: string): ConversationTokenUsage {
    const runs = this.runsWhere((run) => run.conversationId === conversationId);
    return {
      scope: 'conversation',
      conversationId,
      startedAt: firstTimestamp(runs),
      completedAt: lastTimestamp(runs),
      runs,
      ...aggregateCalls(runs.flatMap((run) => run.calls)),
    };
  }

  getOverview(conversationId: string, sessionId: string): TokenUsageOverview {
    const conversation = this.getConversation(conversationId);
    const session = this.getSession(sessionId);
    const latestRun = [...session.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    return { conversation, session, latestRun };
  }

  private byTool(toolCallId: string): LLMCallUsage | null {
    const callId = this.callIdByTool.get(toolCallId);
    return callId ? this.calls.get(callId) ?? null : null;
  }

  private runsWhere(predicate: (run: RunTokenUsage) => boolean): RunTokenUsage[] {
    return [...this.runIdentities.keys()]
      .map((runId) => this.getRun(runId))
      .filter((run): run is RunTokenUsage => Boolean(run) && predicate(run as RunTokenUsage))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private prune(): void {
    while (this.runIdentities.size > this.maxRuns) {
      const oldestRunId = this.runIdentities.keys().next().value as string | undefined;
      if (!oldestRunId) break;
      this.runIdentities.delete(oldestRunId);
      for (const [callId, call] of this.calls) {
        if (call.runId !== oldestRunId) continue;
        this.calls.delete(callId);
        for (const [toolId, mappedCallId] of this.callIdByTool) {
          if (mappedCallId === callId) this.callIdByTool.delete(toolId);
        }
      }
    }
  }
}

export function aggregateCalls(calls: LLMCallUsage[]): TokenUsageAggregate {
  const available = calls.filter((call) => call.usageAvailable);
  const inputTokens = sum(available, (call) => call.inputTokens);
  const outputTokens = sum(available, (call) => call.outputTokens);
  const cachedTokens = sum(available, (call) => call.cachedTokens);
  const totalTokens = sum(available, (call) => call.totalTokens);
  const cacheHitRateAvailable = available.length > 0 && available.every((call) => call.cachedTokensAvailable);
  return {
    llmCallCount: calls.length,
    completedCallCount: calls.filter((call) => call.status === 'completed').length,
    failedCallCount: calls.filter((call) => call.status === 'failed').length,
    usageAvailableCallCount: available.length,
    cachedMetricsAvailableCallCount: calls.filter((call) => call.cachedTokensAvailable).length,
    inputTokens,
    outputTokens,
    cachedTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedTokens),
    totalTokens,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    cacheHitRateAvailable,
    totalModelLatencyMs: sum(calls, (call) => call.latencyMs),
    averageTokensPerCall: available.length > 0 ? Math.round(totalTokens / available.length) : 0,
  };
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function firstTimestamp(runs: RunTokenUsage[]): string | undefined {
  return [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.startedAt;
}

function lastTimestamp(runs: RunTokenUsage[]): string | undefined {
  return runs.map((run) => run.completedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
}
