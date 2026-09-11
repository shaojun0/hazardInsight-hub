/** Agent Runtime 与领域 workflow 之间的窄接口，workflow 不依赖 HTTP/存储实现。 */
import type { AgentEventType, AgentRunIds, AgentUiStage, FrontendAgentState } from '../../shared/agent-protocol.js';
import type { MultimodalModelProvider } from '../providers/types.js';
import type { AgentContextBuilder } from './context/context-builder.js';
import type { ToolExecutor } from './tools/executor.js';
import type { KnowledgeRetrievalService } from '../retrieval/service.js';
import type { RuleMatcher } from '../rules/matcher.js';
import type { ContextItemDraft, ModelCallTelemetry } from '../../shared/context-observability.js';
import type { LLMCallPhase } from '../../shared/token-usage.js';

export interface RuntimeModelTelemetryInput {
  phase: LLMCallPhase;
  contextItems: ContextItemDraft[];
  imageCount?: number;
  pruneEvents?: Array<{ reason: string; removedItemIds: string[]; removedEstimatedTokens?: number }>;
}

export interface RuntimeWorkflowContext {
  ids: AgentRunIds;
  provider: MultimodalModelProvider;
  frontendState: FrontendAgentState;
  knowledge: KnowledgeRetrievalService;
  rules: RuleMatcher;
  contextBuilder: AgentContextBuilder;
  tools: ToolExecutor;
  modelTelemetry(input: RuntimeModelTelemetryInput): ModelCallTelemetry;
  step<T>(
    key: string,
    uiStage: AgentUiStage,
    execute: () => Promise<T>,
    summarize?: (value: T) => Record<string, unknown>
  ): Promise<T>;
  emit(type: AgentEventType, payload: Record<string, unknown>, uiStage: AgentUiStage): void;
  markFallback(reason: string, from: string, to: string): void;
  recordCache(cacheName: string, hit: boolean, keyHint: string, ageMs?: number): void;
}
