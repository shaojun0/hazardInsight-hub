/**
 * Agent Runtime：run/step/event 生命周期、工具观测、缓存指标、fallback、结果元数据与 Session 摘要。
 * HTTP 层与领域 workflow 都不直接维护运行状态。
 */
import type {
  AgentConfigSnapshot,
  AgentEventType,
  AgentRunMetrics,
  AgentRunSnapshot,
  AgentStreamEvent,
  AgentUiStage,
  FrontendAgentState,
} from '../../shared/agent-protocol.js';
import { isReasoningEffort } from '../../shared/agent-protocol.js';
import type { AnalysisResult } from '../../shared/types.js';
import type { LLMCallPhase, RunTokenUsage, TokenUsageOverview } from '../../shared/token-usage.js';
import type { MultimodalModelProvider, ModelTokenUsage } from '../providers/types.js';
import { resolveProvider } from '../providers/index.js';
import type { KnowledgeRetriever } from '../retrieval/index.js';
import { KnowledgeRetrievalService, RERANK_VERSION } from '../retrieval/service.js';
import { RuleMatcher } from '../rules/matcher.js';
import { AgentContextBuilder } from './context/context-builder.js';
import { normalizeAgentError } from './errors.js';
import { createRunIds, newEventId, newStepId } from './ids.js';
import { SessionMemoryStore } from './memory/memory-store.js';
import { InMemoryRunStore } from './observability/run-store.js';
import { TokenUsageStore } from './observability/token-usage-store.js';
import { ContextObservabilityStore } from './observability/context-observability-store.js';
import type { RuntimeWorkflowContext } from './runtime-types.js';
import { ToolExecutor } from './tools/executor.js';
import { HAZARD_WORKFLOW_VERSION, runHazardAnalysisWorkflow } from './workflows/hazard-analysis.js';

export interface StartHazardRunInput {
  buffer: Buffer;
  mimeType: string;
  scenario?: string;
  textCandidate?: { description: string; category: string };
  textMaxOutputTokens?: number;
  onReasoningOutput?: (text: string) => void;
  frontendState?: Partial<FrontendAgentState>;
  userId?: string;
  conversationId?: string;
  sessionId?: string;
  taskId?: string;
  providerOverride?: MultimodalModelProvider;
  onEvent?: (event: AgentStreamEvent) => void;
}

export class AgentRuntime {
  private readonly knowledge: KnowledgeRetrievalService;
  private readonly rules = new RuleMatcher();
  private readonly contextBuilder = new AgentContextBuilder();
  private readonly memory = new SessionMemoryStore();
  private readonly store = new InMemoryRunStore();
  private readonly tokenUsage = new TokenUsageStore();
  private readonly contextObservability = new ContextObservabilityStore();

  constructor(retriever: KnowledgeRetriever) {
    this.knowledge = new KnowledgeRetrievalService(retriever);
  }

  async runHazardAnalysis(input: StartHazardRunInput): Promise<AnalysisResult> {
    const ids = createRunIds({
      userId: input.userId ?? 'anonymous-demo',
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      taskId: input.taskId,
    });
    const provider = input.providerOverride ?? resolveProvider().provider;
    const frontendState: FrontendAgentState = {
      source: input.frontendState?.source ?? 'workbench',
      deviceId: input.frontendState?.deviceId,
      stationId: input.frontendState?.stationId,
      scenarioId: input.frontendState?.scenarioId ?? input.scenario,
      locale: input.frontendState?.locale ?? 'zh-CN',
      // 思考强度：缺失/非法一律回退默认 low（兼容旧版前端与异常请求）。
      reasoningEffort: isReasoningEffort(input.frontendState?.reasoningEffort) ? input.frontendState.reasoningEffort : 'low',
    };
    const startedAt = new Date().toISOString();
    const metrics: AgentRunMetrics = {
      startedAt,
      durationMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      retrievals: 0,
      cacheHits: 0,
      cacheMisses: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const config: AgentConfigSnapshot = {
      model: provider.name,
      mode: 'ai',
      reasoningEffort: frontendState.reasoningEffort ?? 'low',
      workflowVersion: HAZARD_WORKFLOW_VERSION,
      promptVersion: `${this.contextBuilder.visionPromptVersion}+${this.contextBuilder.reasoningPromptVersion}+${this.contextBuilder.publicSummaryPromptVersion}`,
      ruleSetVersion: this.rules.getVersion(),
      knowledgeVersion: this.knowledge.getVersion(),
      rerankVersion: RERANK_VERSION,
    };
    const now = new Date().toISOString();
    const initial: AgentRunSnapshot = {
      ...ids,
      workflowType: input.textCandidate ? 'text_hazard_analysis' : 'image_hazard_analysis',
      status: 'pending',
      config,
      metrics,
      fallbackUsed: false,
      requiresReview: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(initial);
    this.tokenUsage.registerRun(ids, startedAt);
    const agentId = 'master';
    const turn = this.contextObservability.registerRun(ids, startedAt, agentId);

    let sequence = 0;
    let fallbackUsed = false;
    let fallbackReason: string | undefined;
    const emit = (
      type: AgentEventType,
      payload: unknown,
      options: { uiStage?: AgentUiStage; phase?: string; stepId?: string } = {}
    ): AgentStreamEvent => {
      const event: AgentStreamEvent = {
        protocolVersion: '1.0',
        eventId: newEventId(),
        sequence: ++sequence,
        type,
        timestamp: new Date().toISOString(),
        traceId: ids.traceId,
        runId: ids.runId,
        taskId: ids.taskId,
        stepId: options.stepId,
        phase: options.phase,
        uiStage: options.uiStage,
        payload,
      };
      this.store.append(event);
      try {
        input.onEvent?.(event);
      } catch {
        // 客户端流断开不应中断后端 run。
      }
      return event;
    };

    let activeStep: { stepId: string; key: string } | null = null;
    const syncTokenMetrics = () => {
      const usage = this.tokenUsage.getRun(ids.runId);
      if (!usage) return;
      metrics.modelCalls = usage.llmCallCount;
      metrics.inputTokens = usage.inputTokens;
      metrics.outputTokens = usage.outputTokens;
      metrics.cachedTokens = usage.cachedTokens;
      metrics.totalTokens = usage.totalTokens;
      metrics.totalModelLatencyMs = usage.totalModelLatencyMs;
    };

    const toolExecutor = new ToolExecutor((type, payload, uiStage) => {
      const tool = String(payload.tool ?? payload.name ?? '');
      if (type === 'tool.started') {
        metrics.toolCalls += 1;
        if (tool.startsWith('model.')) metrics.modelCalls += 1;
        if (tool === 'knowledge.retrieve') metrics.retrievals += 1;
        this.store.update(ids.runId, { status: 'waiting_tool', metrics: { ...metrics } });
      } else {
        this.store.update(ids.runId, { status: 'running', metrics: { ...metrics } });
      }
      const toolEvent = emit(type, payload, {
        uiStage,
        phase: tool,
        stepId: activeStep?.stepId,
      });
      if (!tool.startsWith('model.')) return;

      if (type === 'tool.started') {
        const call = this.tokenUsage.start({
          toolCallId: String(payload.toolCallId),
          ids,
          stepId: activeStep?.stepId,
          stepKey: activeStep?.key,
          provider: provider.providerId,
          model: provider.name,
          phase: llmPhase(payload.llmPhase),
          startedAt: toolEvent.timestamp,
        });
        syncTokenMetrics();
        this.store.update(ids.runId, { metrics: { ...metrics } });
        emit('llm.call.started', { call }, {
          uiStage,
          phase: call.phase,
          stepId: activeStep?.stepId,
        });
      } else if (type === 'tool.completed') {
        const call = this.tokenUsage.completeByTool(String(payload.toolCallId), {
          usage: usageFromToolPayload(payload.usage),
          latencyMs: numberValue(payload.latencyMs),
          providerAttempts: numberValue(payload.providerAttempts),
          completedAt: toolEvent.timestamp,
        });
        syncTokenMetrics();
        this.store.update(ids.runId, { metrics: { ...metrics } });
        if (call) emit('llm.call.completed', { call }, {
          uiStage,
          phase: call.phase,
          stepId: call.stepId,
        });
      } else {
        const call = this.tokenUsage.failByTool(String(payload.toolCallId), {
          latencyMs: numberValue(payload.latencyMs),
          providerAttempts: numberValue(payload.attempts),
          completedAt: toolEvent.timestamp,
          errorCode: typeof payload.code === 'string' ? payload.code : undefined,
        });
        syncTokenMetrics();
        this.store.update(ids.runId, { metrics: { ...metrics } });
        if (call) emit('llm.call.failed', { call }, {
          uiStage,
          phase: call.phase,
          stepId: call.stepId,
        });
      }
    });

    const runtimeContext: RuntimeWorkflowContext = {
      ids,
      provider,
      frontendState,
      knowledge: this.knowledge,
      rules: this.rules,
      contextBuilder: this.contextBuilder,
      tools: toolExecutor,
      modelTelemetry: (telemetryInput) => ({
        phase: telemetryInput.phase,
        contextItems: telemetryInput.contextItems,
        contextWindow: provider.contextWindow,
        imageCount: telemetryInput.imageCount,
        pruneEvents: telemetryInput.pruneEvents,
        onRequest: (observation) => {
          const step = this.contextObservability.startRequest({
            ids,
            agentId,
            turn,
            workflowStepId: activeStep?.stepId,
            workflowStepKey: activeStep?.key,
            phase: telemetryInput.phase,
            contextItems: telemetryInput.contextItems,
            contextWindow: provider.contextWindow,
            imageCount: telemetryInput.imageCount,
            pruneEvents: telemetryInput.pruneEvents,
            pricing: provider.pricing,
          }, observation);
          emit('llm.step.started', { stepId: step.stepId, invocationId: step.invocationId, turnIndex: step.turnIndex, stepIndex: step.stepIndex }, {
            uiStage: activeStep?.key === 'vision' ? 'vision' : 'reasoning', phase: telemetryInput.phase, stepId: activeStep?.stepId,
          });
          for (const prune of telemetryInput.pruneEvents ?? []) {
            emit('context.pruned', prune, { phase: telemetryInput.phase, stepId: activeStep?.stepId });
          }
        },
        onResponse: (observation) => {
          const step = this.contextObservability.completeRequest(observation);
          if (!step) return;
          emit(observation.status === 'completed' ? 'llm.step.completed' : 'llm.step.failed', {
            stepId: step.stepId,
            invocationId: step.invocationId,
            actualPromptTokens: step.actualPromptTokens,
            completionTokens: step.completionTokens,
            cacheReadTokens: step.cacheReadTokens,
            latencyMs: step.latencyMs,
          }, { phase: step.phase, stepId: step.workflowStepId });
        },
      }),
      step: async <T>(
        key: string,
        uiStage: AgentUiStage,
        execute: () => Promise<T>,
        summarize?: (value: T) => Record<string, unknown>
      ): Promise<T> => {
        const stepId = newStepId();
        const stepStarted = Date.now();
        const parentStep = activeStep;
        activeStep = { stepId, key };
        this.store.update(ids.runId, { status: 'running', currentStep: key, metrics: { ...metrics } });
        emit('step.started', { step: key }, { uiStage, phase: key, stepId });
        try {
          const value = await execute();
          emit('step.completed', {
            step: key,
            durationMs: Date.now() - stepStarted,
            ...(summarize ? summarize(value) : {}),
          }, { uiStage, phase: key, stepId });
          return value;
        } catch (error) {
          const normalized = normalizeAgentError(error);
          emit('step.failed', {
            step: key,
            durationMs: Date.now() - stepStarted,
            code: normalized.code,
            message: normalized.message,
          }, { uiStage, phase: key, stepId });
          throw normalized;
        } finally {
          activeStep = parentStep;
        }
      },
      emit: (type, payload, uiStage) => emit(type, payload, { uiStage }),
      markFallback: (reason, from, to) => {
        fallbackUsed = true;
        fallbackReason = reason;
        this.store.update(ids.runId, { status: 'fallback', fallbackUsed: true, fallbackReason: reason });
        emit('run.fallback', { reason, from, to }, { uiStage: 'reasoning', phase: from });
      },
      recordCache: (cacheName, hit, keyHint, ageMs) => {
        if (hit) metrics.cacheHits += 1;
        else metrics.cacheMisses += 1;
        emit(hit ? 'cache.hit' : 'cache.miss', { cache: cacheName, keyHint, ageMs }, { phase: cacheName });
      },
    };

    const priorTaskSummaries = this.memory.selectForTask(ids.conversationId, ids.taskId).length;
    this.store.update(ids.runId, { status: 'running' });
    emit('run.started', {
      ids,
      workflowType: input.textCandidate ? 'text_hazard_analysis' : 'image_hazard_analysis',
      config,
      frontendState,
      priorTaskSummaries,
      securityMode: 'demo-anonymous',
    });

    const startedMs = Date.now();
    try {
      const result = await runHazardAnalysisWorkflow({
        buffer: input.buffer,
        mimeType: input.mimeType,
        scenario: input.scenario,
        textCandidate: input.textCandidate,
        textMaxOutputTokens: input.textMaxOutputTokens,
        onReasoningOutput: input.onReasoningOutput,
      }, runtimeContext);
      const completedAt = new Date().toISOString();
      this.tokenUsage.completeRun(ids.runId, completedAt);
      this.contextObservability.completeRun(ids.runId, completedAt);
      syncTokenMetrics();
      const runTokenUsage = this.tokenUsage.getRun(ids.runId) ?? undefined;
      metrics.completedAt = completedAt;
      metrics.durationMs = Date.now() - startedMs;
      result.agentMeta = {
        runId: ids.runId,
        traceId: ids.traceId,
        taskId: ids.taskId,
        conversationId: ids.conversationId,
        sessionId: ids.sessionId,
        workflowVersion: config.workflowVersion,
        promptVersion: config.promptVersion,
        ruleSetVersion: config.ruleSetVersion,
        knowledgeVersion: config.knowledgeVersion,
        fallbackUsed,
        fallbackReason,
        cache: { hits: metrics.cacheHits, misses: metrics.cacheMisses },
        modelCalls: metrics.modelCalls,
        toolCalls: metrics.toolCalls,
        durationMs: metrics.durationMs,
        tokenUsage: runTokenUsage ? {
          inputTokens: runTokenUsage.inputTokens,
          outputTokens: runTokenUsage.outputTokens,
          cachedTokens: runTokenUsage.cachedTokens,
          totalTokens: runTokenUsage.totalTokens,
          cacheHitRate: runTokenUsage.cacheHitRate,
          llmCallCount: runTokenUsage.llmCallCount,
        } : undefined,
      };

      if (result.needManualReview) {
        emit('run.requires_review', {
          reason: fallbackUsed ? 'fallback_or_rule_review' : 'evidence_or_rule_review',
          hazardIds: result.hazards.filter((item) => item.manualReviewRequired).map((item) => item.id),
        }, { uiStage: 'validation' });
      }
      emit('result.completed', { data: result }, { uiStage: 'assemble' });
      this.store.update(ids.runId, {
        status: 'completed',
        currentStep: undefined,
        result,
        tokenUsage: runTokenUsage,
        metrics: { ...metrics },
        fallbackUsed,
        fallbackReason,
        requiresReview: result.needManualReview,
      });
      this.memory.record(ids.conversationId, {
        runId: ids.runId,
        taskId: ids.taskId,
        analysisId: result.analysisId,
        hazardCount: result.hazards.length,
        overallRisk: result.overallRisk,
        fallbackUsed,
        requiresReview: result.needManualReview,
        createdAt: completedAt,
      });
      emit('run.completed', { status: 'completed', metrics, fallbackUsed, requiresReview: result.needManualReview });
      return result;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      metrics.completedAt = new Date().toISOString();
      this.tokenUsage.completeRun(ids.runId, metrics.completedAt);
      this.contextObservability.completeRun(ids.runId, metrics.completedAt);
      syncTokenMetrics();
      const runTokenUsage = this.tokenUsage.getRun(ids.runId) ?? undefined;
      metrics.durationMs = Date.now() - startedMs;
      this.store.update(ids.runId, {
        status: 'failed',
        currentStep: undefined,
        metrics: { ...metrics },
        fallbackUsed,
        fallbackReason,
        error: { code: normalized.code, message: normalized.message },
        tokenUsage: runTokenUsage,
      });
      emit('run.failed', {
        status: 'failed',
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        metrics,
      });
      throw normalized;
    }
  }

  getRun(runId: string): AgentRunSnapshot | null {
    return this.store.getRun(runId);
  }

  getEvents(runId: string, after = 0): AgentStreamEvent[] {
    return this.store.getEvents(runId, after);
  }

  getTrace(traceId: string): { run: AgentRunSnapshot; events: AgentStreamEvent[]; tokenUsage: RunTokenUsage | null } | null {
    const run = this.store.getByTraceId(traceId);
    return run ? {
      run,
      events: this.store.getEvents(run.runId),
      tokenUsage: this.tokenUsage.getRun(run.runId),
    } : null;
  }

  getRunTokenUsage(runId: string) {
    return this.tokenUsage.getRun(runId);
  }

  getSessionTokenUsage(sessionId: string) {
    return this.tokenUsage.getSession(sessionId);
  }

  getConversationTokenUsage(conversationId: string) {
    return this.tokenUsage.getConversation(conversationId);
  }

  getTokenUsageOverview(conversationId: string, sessionId: string): TokenUsageOverview {
    return this.tokenUsage.getOverview(conversationId, sessionId);
  }

  getContextObservability(conversationId: string, sessionId: string) {
    return this.contextObservability.getOverview(conversationId, sessionId);
  }

  getContextStep(stepId: string) {
    return this.contextObservability.getStep(stepId);
  }

  exportContextSession(sessionId: string) {
    return this.contextObservability.exportSession(sessionId);
  }
}

function llmPhase(value: unknown): LLMCallPhase {
  const phases: LLMCallPhase[] = [
    'planning', 'vision_analysis', 'reasoning', 'tool_selection', 'tool_result_processing',
    'knowledge_retrieval_processing', 'final_answer', 'other',
  ];
  return typeof value === 'string' && phases.includes(value as LLMCallPhase) ? value as LLMCallPhase : 'other';
}

function usageFromToolPayload(value: unknown): ModelTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Partial<ModelTokenUsage>;
  if (usage.source !== 'provider') return undefined;
  return {
    inputTokens: numberValue(usage.inputTokens),
    outputTokens: numberValue(usage.outputTokens),
    cachedTokens: numberValue(usage.cachedTokens),
    totalTokens: numberValue(usage.totalTokens),
    cachedTokensAvailable: usage.cachedTokensAvailable === true,
    cachedTokensAreInputSubset: true,
    source: usage.source,
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function createAgentRuntime(retriever: KnowledgeRetriever): AgentRuntime {
  return new AgentRuntime(retriever);
}
