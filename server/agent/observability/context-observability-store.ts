import { createHash, randomUUID } from 'node:crypto';
import type { AgentRunIds } from '../../../shared/agent-protocol.js';
import {
  CONTEXT_CATEGORIES,
  type AgentBranch,
  type AgentContextSummary,
  type AgentTurn,
  type CategoryStats,
  type CompressionEvent,
  type ContextCategory,
  type ContextCategoryDiff,
  type ContextItem,
  type ContextItemDraft,
  type ContextObservabilityOverview,
  type ContextStatistics,
  type LLMStep,
  type ModelCallTelemetry,
  type ModelPricing,
  type ProviderRequestObservation,
  type ProviderResponseObservation,
  type PruneEvent,
} from '../../../shared/context-observability.js';
import type { LLMCallPhase } from '../../../shared/token-usage.js';

interface RunRegistration {
  ids: AgentRunIds;
  agentId: string;
  turn: AgentTurn;
}

interface TelemetryInput {
  ids: AgentRunIds;
  agentId: string;
  turn: AgentTurn;
  workflowStepId?: string;
  workflowStepKey?: string;
  phase: LLMCallPhase;
  contextItems: ContextItemDraft[];
  contextWindow?: number;
  imageCount?: number;
  pruneEvents?: ModelCallTelemetry['pruneEvents'];
  pricing?: ModelPricing;
}

export class ContextObservabilityStore {
  private readonly agents = new Map<string, AgentBranch>();
  private readonly turns = new Map<string, AgentTurn>();
  private readonly runs = new Map<string, RunRegistration>();
  private readonly steps = new Map<string, LLMStep>();
  private readonly stepIdByInvocation = new Map<string, string>();
  private readonly prunes: PruneEvent[] = [];
  private readonly compressions: CompressionEvent[] = [];
  private readonly estimateCache = new Map<string, number>();

  registerRun(
    ids: AgentRunIds,
    startedAt: string,
    agentId = 'master',
    fork?: { parentAgentId: string; forkStepId: string }
  ): AgentTurn {
    const agentKey = `${ids.sessionId}:${agentId}`;
    if (!this.agents.has(agentKey)) {
      this.agents.set(agentKey, { agentId, sessionId: ids.sessionId, name: agentId, createdAt: startedAt, ...fork });
    }
    const turnIndex = [...this.turns.values()].filter((turn) => turn.sessionId === ids.sessionId && turn.agentId === agentId).length + 1;
    const turn: AgentTurn = {
      turnId: `turn_${randomUUID()}`,
      sessionId: ids.sessionId,
      conversationId: ids.conversationId,
      runId: ids.runId,
      agentId,
      turnIndex,
      startedAt,
    };
    this.turns.set(turn.turnId, turn);
    this.runs.set(ids.runId, { ids, agentId, turn });
    return structuredClone(turn);
  }

  completeRun(runId: string, completedAt: string): void {
    const registration = this.runs.get(runId);
    if (registration) registration.turn.completedAt = completedAt;
  }

  recordCompression(event: Omit<CompressionEvent, 'id'>): CompressionEvent {
    const saved: CompressionEvent = { id: `compression_${randomUUID()}`, ...structuredClone(event) };
    this.compressions.push(saved);
    return structuredClone(saved);
  }

  createTelemetry(input: TelemetryInput): ModelCallTelemetry {
    return {
      phase: input.phase,
      contextItems: input.contextItems,
      contextWindow: input.contextWindow,
      imageCount: input.imageCount,
      pruneEvents: input.pruneEvents,
      onRequest: (observation) => this.startRequest(input, observation),
      onResponse: (observation) => this.completeRequest(observation),
    };
  }

  startRequest(input: TelemetryInput, observation: ProviderRequestObservation): LLMStep {
    const existingId = this.stepIdByInvocation.get(observation.invocationId);
    if (existingId) return structuredClone(this.steps.get(existingId)!);
    const agentSteps = this.agentSteps(input.ids.sessionId, input.agentId);
    const stepId = `llmstep_${randomUUID()}`;
    const items = input.contextItems.map((draft) => this.materializeItem(draft, observation.model));
    if (observation.serializedTools?.length) {
      observation.serializedTools.forEach((tool, index) => {
        items.push(this.materializeItem({
          id: `tool-definition:${hash(tool)}`,
          category: 'tool_definition',
          label: toolName(tool, index),
          content: tool,
          sourceType: 'provider_tool_schema',
          sourceId: toolName(tool, index),
        }, observation.model));
      });
    }
    const snapshot = {
      snapshotId: `snapshot_${randomUUID()}`,
      stepId,
      items,
      categories: categoryStats(items),
      estimatedPromptTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
      contextWindow: input.contextWindow,
      imageCount: Math.max(0, input.imageCount ?? 0),
      payloadHash: observation.payloadHash,
    };
    const previous = agentSteps.at(-1);
    const step: LLMStep = {
      stepId,
      invocationId: observation.invocationId,
      sessionId: input.ids.sessionId,
      conversationId: input.ids.conversationId,
      runId: input.ids.runId,
      traceId: input.ids.traceId,
      agentId: input.agentId,
      turnId: input.turn.turnId,
      turnIndex: input.turn.turnIndex,
      stepIndex: agentSteps.length + 1,
      workflowStepId: input.workflowStepId,
      workflowStepKey: input.workflowStepKey,
      attempt: observation.attempt,
      phase: input.phase,
      provider: observation.provider,
      model: observation.model,
      status: 'running',
      snapshot,
      diff: diffSnapshots(previous, items),
      usageSource: 'unavailable',
      cachedTokensAvailable: false,
      pricing: input.pricing,
      startedAt: observation.startedAt,
    };
    this.steps.set(stepId, step);
    this.stepIdByInvocation.set(observation.invocationId, stepId);
    for (const event of input.pruneEvents ?? []) {
      this.prunes.push({
        id: `prune_${randomUUID()}`,
        sessionId: input.ids.sessionId,
        agentId: input.agentId,
        runId: input.ids.runId,
        turnIndex: input.turn.turnIndex,
        stepIndex: step.stepIndex,
        reason: event.reason,
        removedItemIds: [...event.removedItemIds],
        removedEstimatedTokens: Math.max(0, event.removedEstimatedTokens ?? 0),
        timestamp: observation.startedAt,
      });
    }
    return structuredClone(step);
  }

  completeRequest(observation: ProviderResponseObservation): LLMStep | null {
    const stepId = this.stepIdByInvocation.get(observation.invocationId);
    const step = stepId ? this.steps.get(stepId) : undefined;
    if (!step) return null;
    // invocationId is the idempotency key. A duplicated finish event must not create or add usage.
    if (step.status !== 'running') return structuredClone(step);
    step.status = observation.status;
    step.requestId = observation.requestId;
    step.completedAt = observation.completedAt;
    step.latencyMs = Math.max(0, Math.round(observation.latencyMs));
    step.errorCode = observation.errorCode;
    step.usageRaw = observation.usageRaw === undefined ? undefined : structuredClone(observation.usageRaw);
    if (observation.usage?.source === 'provider') {
      step.usageSource = 'provider';
      step.actualPromptTokens = whole(observation.usage.inputTokens);
      step.completionTokens = whole(observation.usage.outputTokens);
      step.cacheReadTokens = whole(observation.usage.cachedTokens);
      step.cacheWriteTokens = whole(observation.usage.cacheWriteTokens);
      step.totalTokens = whole(observation.usage.totalTokens);
      step.cachedTokensAvailable = observation.usage.cachedTokensAvailable;
      if (step.pricing) {
        const uncached = Math.max(0, step.actualPromptTokens - step.cacheReadTokens);
        const readPrice = step.pricing.cacheReadPerMillion ?? step.pricing.inputPerMillion;
        const writePrice = step.pricing.cacheWritePerMillion ?? step.pricing.inputPerMillion;
        step.estimatedCost = (uncached * step.pricing.inputPerMillion + step.cacheReadTokens * readPrice + (step.cacheWriteTokens ?? 0) * writePrice + step.completionTokens * step.pricing.outputPerMillion) / 1_000_000;
        step.costCurrency = step.pricing.currency;
      }
    }
    return structuredClone(step);
  }

  getStep(stepId: string): LLMStep | null {
    const step = this.steps.get(stepId);
    return step ? structuredClone(step) : null;
  }

  getOverview(conversationId: string, sessionId: string): ContextObservabilityOverview {
    const agents = [...this.agents.values()]
      .filter((agent) => agent.sessionId === sessionId)
      .map((agent) => this.agentSummary(agent, conversationId));
    return {
      conversationId,
      sessionId,
      generatedAt: new Date().toISOString(),
      agents,
      sessionStats: aggregateStats(agents.flatMap((agent) => agent.steps), agents.flatMap((agent) => agent.turns), this.prunes.filter((event) => event.sessionId === sessionId), this.compressions.filter((event) => event.sessionId === sessionId)),
    };
  }

  exportSession(sessionId: string): object {
    const turns = [...this.turns.values()].filter((turn) => turn.sessionId === sessionId);
    const conversationId = turns[0]?.conversationId ?? '';
    return { schemaVersion: '1.0', exportedAt: new Date().toISOString(), ...this.getOverview(conversationId, sessionId), steps: this.agentSteps(sessionId) };
  }

  private agentSummary(agent: AgentBranch, conversationId: string): AgentContextSummary {
    const turns = [...this.turns.values()].filter((turn) => turn.sessionId === agent.sessionId && turn.agentId === agent.agentId && turn.conversationId === conversationId);
    const runIds = new Set(turns.map((turn) => turn.runId));
    const steps = this.agentSteps(agent.sessionId, agent.agentId).filter((step) => runIds.has(step.runId)).map(withoutItemContent);
    const prunes = this.prunes.filter((event) => event.sessionId === agent.sessionId && event.agentId === agent.agentId && runIds.has(event.runId));
    const compressions = this.compressions.filter((event) => event.sessionId === agent.sessionId && event.agentId === agent.agentId && runIds.has(event.runId));
    return {
      ...structuredClone(agent),
      turns: structuredClone(turns),
      steps,
      currentStepId: steps.at(-1)?.stepId,
      stats: aggregateStats(steps, turns, prunes, compressions),
    };
  }

  private agentSteps(sessionId: string, agentId?: string): LLMStep[] {
    return [...this.steps.values()]
      .filter((step) => step.sessionId === sessionId && (!agentId || step.agentId === agentId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private materializeItem(draft: ContextItemDraft, model: string): ContextItem {
    const contentHash = hash(draft.content);
    const key = `${model}:${contentHash}`;
    const estimateMethod = draft.estimateMethod ?? (typeof draft.content === 'string' ? 'heuristic' : 'heuristic');
    let estimatedTokens = this.estimateCache.get(key);
    if (estimatedTokens === undefined) {
      const serialized = typeof draft.content === 'string' ? draft.content : JSON.stringify(draft.content ?? null);
      estimatedTokens = estimateMethod === 'unknown' ? 0 : Math.ceil(serialized.length / 2.5);
      this.estimateCache.set(key, estimatedTokens);
    }
    return { ...structuredClone(draft), contentHash, estimatedTokens, estimateMethod };
  }
}

function categoryStats(items: ContextItem[]): Record<ContextCategory, CategoryStats> {
  const total = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  return Object.fromEntries(CONTEXT_CATEGORIES.map((category) => {
    const selected = items.filter((item) => item.category === category);
    const estimatedTokens = selected.reduce((sum, item) => sum + item.estimatedTokens, 0);
    return [category, { itemCount: selected.length, estimatedTokens, percentage: total > 0 ? estimatedTokens / total : 0 }];
  })) as Record<ContextCategory, CategoryStats>;
}

function diffSnapshots(previous: LLMStep | undefined, current: ContextItem[]): LLMStep['diff'] {
  const previousItems = previous?.snapshot.items ?? [];
  const categories = Object.fromEntries(CONTEXT_CATEGORIES.map((category) => {
    const before = new Map(previousItems.filter((item) => item.category === category).map((item) => [item.id, item]));
    const after = new Map(current.filter((item) => item.category === category).map((item) => [item.id, item]));
    const addedItemIds = [...after.keys()].filter((id) => !before.has(id));
    const removedItemIds = [...before.keys()].filter((id) => !after.has(id));
    const modifiedItemIds = [...after.keys()].filter((id) => before.has(id) && before.get(id)?.contentHash !== after.get(id)?.contentHash);
    const beforeTokens = [...before.values()].reduce((sum, item) => sum + item.estimatedTokens, 0);
    const afterTokens = [...after.values()].reduce((sum, item) => sum + item.estimatedTokens, 0);
    const value: ContextCategoryDiff = { itemCountDelta: after.size - before.size, tokenDelta: afterTokens - beforeTokens, addedItemIds, removedItemIds, modifiedItemIds };
    return [category, value];
  })) as Record<ContextCategory, ContextCategoryDiff>;
  return { previousStepId: previous?.stepId, categories };
}

function aggregateStats(steps: LLMStep[], turns: AgentTurn[], prunes: PruneEvent[], compressions: CompressionEvent[]): ContextStatistics {
  const withActual = steps.filter((step) => step.usageSource === 'provider' && step.actualPromptTokens !== undefined);
  const cacheComparable = withActual.filter((step) => step.cachedTokensAvailable);
  const prompt = withActual.reduce((sum, step) => sum + (step.actualPromptTokens ?? 0), 0);
  const cachedPrompt = cacheComparable.reduce((sum, step) => sum + (step.actualPromptTokens ?? 0), 0);
  const cached = cacheComparable.reduce((sum, step) => sum + (step.cacheReadTokens ?? 0), 0);
  return {
    turnCount: turns.length,
    stepCount: steps.length,
    injectionCount: steps.reduce((sum, step) => sum + step.snapshot.categories.injected_content.itemCount, 0),
    compressionCount: compressions.length,
    pruningCount: prunes.length,
    imageCount: steps.reduce((sum, step) => sum + step.snapshot.imageCount, 0),
    cacheHitRate: withActual.length > 0 && cacheComparable.length === withActual.length && cachedPrompt > 0 ? cached / cachedPrompt : undefined,
    estimatedCost: withActual.length > 0 && withActual.every((step) => step.estimatedCost !== undefined) ? withActual.reduce((sum, step) => sum + (step.estimatedCost ?? 0), 0) : undefined,
    costCurrency: withActual.length > 0 && withActual.every((step) => step.costCurrency === withActual[0].costCurrency) ? withActual[0].costCurrency : undefined,
    cumulativePromptTokens: prompt,
    cumulativeCompletionTokens: withActual.reduce((sum, step) => sum + (step.completionTokens ?? 0), 0),
  };
}

function withoutItemContent(step: LLMStep): LLMStep {
  const cloned = structuredClone(step);
  cloned.snapshot.items = cloned.snapshot.items.map(({ content: _content, ...item }) => item);
  return cloned;
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
}

function toolName(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; function?: { name?: unknown } };
    if (typeof record.name === 'string') return record.name;
    if (typeof record.function?.name === 'string') return record.function.name;
  }
  return `tool-${index + 1}`;
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
