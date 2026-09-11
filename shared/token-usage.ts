/**
 * LLM Token 可观测协议。
 * 所有 Provider 必须先把原始 usage 归一化为「cachedTokens 是 inputTokens 子集」的统一语义。
 */

export type LLMCallPhase =
  | 'planning'
  | 'vision_analysis'
  | 'reasoning'
  | 'tool_selection'
  | 'tool_result_processing'
  | 'knowledge_retrieval_processing'
  | 'final_answer'
  | 'other';

export type TokenUsageSource = 'provider' | 'unavailable';

export interface LLMCallUsage {
  callId: string;
  runId: string;
  traceId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  stepId?: string;
  stepKey?: string;
  sequence: number;
  provider: string;
  model: string;
  phase: LLMCallPhase;
  status: 'running' | 'completed' | 'failed';
  usageSource: TokenUsageSource;
  usageAvailable: boolean;
  cachedTokensAvailable: boolean;
  /** 统一语义：inputTokens 已包含 cachedTokens。 */
  cachedTokensAreInputSubset: true;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  uncachedInputTokens: number;
  /** 优先采用 Provider total；缺失时才按归一化 input + output 计算。 */
  totalTokens: number;
  cacheHitRate: number;
  latencyMs: number;
  providerAttempts: number;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
}

export interface TokenUsageAggregate {
  llmCallCount: number;
  completedCallCount: number;
  failedCallCount: number;
  usageAvailableCallCount: number;
  cachedMetricsAvailableCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  uncachedInputTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  /** 仅当所有有 usage 的调用都返回 cached 明细时为 true。 */
  cacheHitRateAvailable: boolean;
  totalModelLatencyMs: number;
  averageTokensPerCall: number;
}

export interface RunTokenUsage extends TokenUsageAggregate {
  scope: 'run';
  runId: string;
  traceId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  calls: LLMCallUsage[];
}

export interface SessionTokenUsage extends TokenUsageAggregate {
  scope: 'session';
  sessionId: string;
  conversationId: string;
  startedAt?: string;
  completedAt?: string;
  runs: RunTokenUsage[];
}

export interface ConversationTokenUsage extends TokenUsageAggregate {
  scope: 'conversation';
  conversationId: string;
  startedAt?: string;
  completedAt?: string;
  runs: RunTokenUsage[];
}

export interface TokenUsageOverview {
  conversation: ConversationTokenUsage;
  session: SessionTokenUsage;
  latestRun: RunTokenUsage | null;
}
