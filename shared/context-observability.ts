import type { LLMCallPhase, TokenUsageSource } from './token-usage.js';

export const CONTEXT_CATEGORIES = [
  'system',
  'tool_definition',
  'user_message',
  'injected_content',
  'assistant_message',
  'tool_result',
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export type EstimateMethod = 'tokenizer' | 'heuristic' | 'unknown';

export interface ContextItemDraft {
  id: string;
  category: ContextCategory;
  label: string;
  /** Overview 可省略；Step detail 返回完整内容。 */
  content?: unknown;
  sourceType: string;
  sourceId?: string;
  turnIndex?: number;
  toolName?: string;
  toolCallId?: string;
  estimateMethod?: EstimateMethod;
}

export interface ContextItem extends ContextItemDraft {
  contentHash: string;
  estimatedTokens: number;
  estimateMethod: EstimateMethod;
}

export interface CategoryStats {
  itemCount: number;
  estimatedTokens: number;
  percentage: number;
}

export type ContextCategoryStats = Record<ContextCategory, CategoryStats>;

export interface ContextSnapshot {
  snapshotId: string;
  stepId: string;
  items: ContextItem[];
  categories: ContextCategoryStats;
  estimatedPromptTokens: number;
  contextWindow?: number;
  imageCount: number;
  payloadHash: string;
}

export interface ContextCategoryDiff {
  itemCountDelta: number;
  tokenDelta: number;
  addedItemIds: string[];
  removedItemIds: string[];
  modifiedItemIds: string[];
}

export interface ContextStepDiff {
  previousStepId?: string;
  categories: Record<ContextCategory, ContextCategoryDiff>;
}

export interface AgentBranch {
  agentId: string;
  sessionId: string;
  name: string;
  parentAgentId?: string;
  forkStepId?: string;
  createdAt: string;
}

export interface AgentTurn {
  turnId: string;
  sessionId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  turnIndex: number;
  startedAt: string;
  completedAt?: string;
}

export interface LLMStep {
  stepId: string;
  invocationId: string;
  requestId?: string;
  sessionId: string;
  conversationId: string;
  runId: string;
  traceId: string;
  agentId: string;
  turnId: string;
  turnIndex: number;
  stepIndex: number;
  workflowStepId?: string;
  workflowStepKey?: string;
  attempt: number;
  phase: LLMCallPhase;
  provider: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  snapshot: ContextSnapshot;
  diff: ContextStepDiff;
  usageSource: TokenUsageSource;
  actualPromptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cachedTokensAvailable: boolean;
  latencyMs?: number;
  usageRaw?: unknown;
  errorCode?: string;
  startedAt: string;
  completedAt?: string;
  estimatedCost?: number;
  costCurrency?: string;
  pricing?: ModelPricing;
}

export interface ModelPricing {
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface PruneEvent {
  id: string;
  sessionId: string;
  agentId: string;
  runId: string;
  turnIndex: number;
  stepIndex?: number;
  reason: string;
  removedItemIds: string[];
  removedEstimatedTokens: number;
  timestamp: string;
}

export interface CompressionEvent {
  id: string;
  sessionId: string;
  agentId: string;
  runId: string;
  turnIndex: number;
  stepIndex?: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  removedItemIds: string[];
  addedItemIds: string[];
  timestamp: string;
}

export interface ContextStatistics {
  turnCount: number;
  stepCount: number;
  injectionCount: number;
  compressionCount: number;
  pruningCount: number;
  imageCount: number;
  cacheHitRate?: number;
  estimatedCost?: number;
  costCurrency?: string;
  cumulativePromptTokens: number;
  cumulativeCompletionTokens: number;
}

export interface AgentContextSummary extends AgentBranch {
  stats: ContextStatistics;
  turns: AgentTurn[];
  steps: LLMStep[];
  currentStepId?: string;
}

export interface ContextObservabilityOverview {
  conversationId: string;
  sessionId: string;
  generatedAt: string;
  agents: AgentContextSummary[];
  sessionStats: ContextStatistics;
}

export interface ProviderRequestObservation {
  invocationId: string;
  attempt: number;
  provider: string;
  model: string;
  startedAt: string;
  payloadHash: string;
  serializedTools?: unknown[];
}

export interface ProviderResponseObservation {
  invocationId: string;
  requestId?: string;
  status: 'completed' | 'failed';
  completedAt: string;
  latencyMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens?: number;
    totalTokens: number;
    cachedTokensAvailable: boolean;
    source: 'provider';
  };
  usageRaw?: unknown;
  errorCode?: string;
}

export interface ModelCallTelemetry {
  phase: LLMCallPhase;
  contextItems: ContextItemDraft[];
  contextWindow?: number;
  imageCount?: number;
  pruneEvents?: Array<{ reason: string; removedItemIds: string[]; removedEstimatedTokens?: number }>;
  onRequest(observation: ProviderRequestObservation): void;
  onResponse(observation: ProviderResponseObservation): void;
}

export const CONTEXT_CATEGORY_META: Record<ContextCategory, { label: string; color: string }> = {
  system: { label: '系统提示词', color: '#7c3aed' },
  tool_definition: { label: '工具定义', color: '#f59e0b' },
  user_message: { label: '用户消息', color: '#22c55e' },
  injected_content: { label: '注入内容', color: '#ec4899' },
  assistant_message: { label: '助手消息', color: '#3b82f6' },
  tool_result: { label: '工具结果', color: '#14b8a6' },
};
