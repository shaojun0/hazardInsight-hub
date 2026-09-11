/**
 * Agent Runtime 前后端共享协议。
 * 仅暴露可解释的运行状态与决策摘要，不包含模型隐藏思维链。
 */
import type { AnalysisResult, Grade } from './types.js';
import type { RunTokenUsage } from './token-usage.js';

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_tool'
  | 'fallback'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type AgentUiStage =
  | 'preflight'
  | 'vision'
  | 'retrieval'
  | 'rules'
  | 'context'
  | 'reasoning'
  | 'validation'
  | 'assemble';

/**
 * DeepSeek 推理强度（reasoning effort）。
 * 仅对支持该参数的 DeepSeek 推理模型生效；非 DeepSeek 模型不应透传。
 */
export type ReasoningEffort = 'low' | 'high' | 'max';

/** 合法取值（前端选项、后端校验共用，避免 magic string 散落）。 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'high', 'max'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export type AgentEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'step.started'
  | 'step.progress'
  | 'step.completed'
  | 'step.failed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'llm.call.started'
  | 'llm.call.completed'
  | 'llm.call.failed'
  | 'llm.step.started'
  | 'llm.step.completed'
  | 'llm.step.failed'
  | 'context.pruned'
  | 'context.compressed'
  | 'retrieval.completed'
  | 'cache.hit'
  | 'cache.miss'
  | 'run.fallback'
  | 'run.requires_review'
  | 'analysis.output.started'
  | 'analysis.output.delta'
  | 'analysis.output.completed'
  | 'analysis.output.failed'
  | 'result.completed'
  | 'heartbeat';

/** 仅包含允许向最终用户展示的模型正文；严禁放入 reasoning_content。 */
export type AnalysisOutputChannel = 'vision' | 'reasoning' | 'public_summary';

export interface AnalysisOutputDeltaPayload {
  channel: AnalysisOutputChannel;
  delta: string;
  chunkIndex: number;
}

export interface AnalysisOutputLifecyclePayload {
  channel: AnalysisOutputChannel;
  label?: string;
  model?: string;
  textLength?: number;
  message?: string;
  streamed?: boolean;
}

/** Workflow 阶段完成后对外公开的、已校验业务摘要。 */
export interface AnalysisStageBusinessSummary {
  imageSummary?: string;
  scenes?: string[];
  candidateCount?: number;
  maxConfidence?: number;
  matchedRules?: number;
  starredRules?: number;
  predictedGrade?: Grade | null;
  finalGrade?: Grade | null;
  hazardCount?: number;
  rectificationCount?: number;
  ruleReferences?: number;
  requiresReview?: boolean;
}

export interface AgentRunIds {
  runId: string;
  traceId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  userId: string;
  analysisId: string;
}

export interface AgentStreamEvent<T = unknown> {
  protocolVersion: '1.0';
  eventId: string;
  sequence: number;
  type: AgentEventType;
  timestamp: string;
  traceId: string;
  runId: string;
  taskId: string;
  stepId?: string;
  phase?: string;
  uiStage?: AgentUiStage;
  payload: T;
}

export interface AgentRunMetrics {
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  retrievals: number;
  cacheHits: number;
  cacheMisses: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  totalModelLatencyMs?: number;
}

export interface AgentConfigSnapshot {
  model: string;
  mode: 'ai';
  /** 本次 run 生效的 DeepSeek 推理强度（默认 low，随 run.started/run 快照可见）。 */
  reasoningEffort: ReasoningEffort;
  workflowVersion: string;
  promptVersion: string;
  ruleSetVersion: string;
  knowledgeVersion: string;
  rerankVersion: string;
}

export interface AgentRunSnapshot extends AgentRunIds {
  workflowType: 'image_hazard_analysis' | 'text_hazard_analysis';
  status: AgentRunStatus;
  currentStep?: string;
  config: AgentConfigSnapshot;
  metrics: AgentRunMetrics;
  fallbackUsed: boolean;
  fallbackReason?: string;
  requiresReview: boolean;
  error?: { code: string; message: string };
  result?: AnalysisResult;
  tokenUsage?: RunTokenUsage;
  createdAt: string;
  updatedAt: string;
}

export interface FrontendAgentState {
  source: 'workbench' | 'camera' | 'robot';
  deviceId?: string;
  stationId?: string;
  scenarioId?: string;
  locale?: string;
  /** 思考强度（DeepSeek reasoning effort）；缺失时后端默认 low。 */
  reasoningEffort?: ReasoningEffort;
}

export interface AnalysisAgentMeta {
  runId: string;
  traceId: string;
  taskId: string;
  conversationId: string;
  sessionId: string;
  workflowVersion: string;
  promptVersion: string;
  ruleSetVersion: string;
  knowledgeVersion: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  cache: { hits: number; misses: number };
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    cacheHitRate: number;
    llmCallCount: number;
  };
}

export interface AgentRunResponse {
  ok: boolean;
  mode: 'ai';
  runId: string;
  data: AnalysisResult;
}
