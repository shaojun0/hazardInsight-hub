/**
 * 图片隐患分析显式 workflow：preflight -> vision -> retrieval -> rules -> context -> reasoning -> validation -> assemble。
 * 风险等级、引用绑定与输出校验由确定性代码负责，模型不能跳过。
 */
import { createHash } from 'node:crypto';
import type { AnalysisStageBusinessSummary } from '../../../shared/agent-protocol.js';
import type {
  AnalysisResult,
  Hazard,
  HistoricalCase,
  HistoricalReference,
  RectificationItem,
  RuleReference,
  StandardReference,
} from '../../../shared/types.js';
import { applyGradeGuardrail, buildGradeReason, worstGrade } from '../../grading/risk-grading.js';
import { GRADING_POLICY_VERSION } from '../../grading/policy.js';
import { clampBBox, parseReasoningResult, safeParseModelJson, visionResultSchema } from '../../lib/schema.js';
import type { ModelHazard, ReasoningResult, VisionCandidate } from '../../lib/schema.js';
import type { ModelCallResult } from '../../providers/types.js';
import type { ClauseRecord } from '../../retrieval/index.js';
import { RERANK_VERSION } from '../../retrieval/service.js';
import type { MatchedRule } from '../../rules/matcher.js';
import { toRuleReference } from '../../rules/matcher.js';
import { AgentRuntimeError } from '../errors.js';
import type { RuntimeWorkflowContext } from '../runtime-types.js';

export const HAZARD_WORKFLOW_VERSION = 'hazard-analysis-v2';
export const DISCLAIMER = 'AI 结果仅用于辅助识别与分级，最终结论必须由具备权限的专业安全人员结合有效受控文件复核确认。';

export interface HazardWorkflowInput {
  buffer: Buffer;
  mimeType: string;
  scenario?: string;
  /** 已有隐患文本直接进入相同的检索、推理和定级链路，不执行图片识别。 */
  textCandidate?: { description: string; category: string };
  textMaxOutputTokens?: number;
  /** 内部评测保存完整公开正文；流式 UI 仍遵循原有输出长度限制。 */
  onReasoningOutput?: (text: string) => void;
}

interface ContextedHazard {
  ref: string;
  category: string;
  title: string;
  description: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  evidence: string[];
  possibleConsequence: string;
  standards: Array<{ key: string; clause: ClauseRecord; relevance: number }>;
  cases: Array<{ key: string; caseRecord: HistoricalCase; similarity: number }>;
  rules: Array<{ key: string; match: MatchedRule }>;
}

interface VisionState {
  imageSummary: string;
  candidates: VisionCandidate[];
  lowEvidence: boolean;
}

type NormalizedModelHazard = Omit<ModelHazard, 'standardRefs' | 'caseRefs' | 'ruleRefs' | 'manualReviewRequired'> & {
  standardRefs: Array<{ key: string; reason: string }>;
  caseRefs: Array<{ key: string; reason: string }>;
  ruleRefs: Array<{ key: string; reason: string }>;
  manualReviewRequired: boolean;
};

type NormalizedReasoningResult = Omit<ReasoningResult, 'hazards' | 'needManualReview'> & {
  hazards: NormalizedModelHazard[];
  needManualReview: boolean;
};

interface ReasoningState {
  parsed: NormalizedReasoningResult | null;
  fallback: boolean;
  topLevelReview: boolean;
}

interface FinalizedSet {
  hazards: Hazard[];
  fallback: boolean;
  manualReviewRequested: boolean;
}

export async function runHazardAnalysisWorkflow(
  input: HazardWorkflowInput,
  ctx: RuntimeWorkflowContext
): Promise<AnalysisResult> {
  const mode = 'ai' as const;
  const modelName = ctx.provider.name;
  // 思考强度：Runtime 已校验并回退默认 'low'，此处仅做兜底。
  const reasoningEffort = ctx.frontendState.reasoningEffort ?? 'low';

  await ctx.step('preflight', 'preflight', async () => {
    if (input.textCandidate) {
      if (!input.textCandidate.description.trim()) throw new AgentRuntimeError('隐患描述为空。', 'INPUT_EMPTY');
      if (input.textCandidate.description.length > 20_000) throw new AgentRuntimeError('隐患描述超过 20000 字符。', 'INPUT_TOO_LARGE');
      return { inputType: 'text', characters: input.textCandidate.description.length };
    }
    if (!input.buffer.length) throw new AgentRuntimeError('图片内容为空。', 'INPUT_EMPTY');
    if (!/^image\/(jpeg|png|webp)$/.test(input.mimeType)) {
      throw new AgentRuntimeError('不支持的图片格式。', 'INPUT_BAD_FORMAT');
    }
    if (input.buffer.length > 35 * 1024 * 1024) {
      throw new AgentRuntimeError('图片大小超过 35MB。', 'INPUT_TOO_LARGE');
    }
    return { bytes: input.buffer.length, mimeType: input.mimeType, source: ctx.frontendState.source };
  });

  const imageBase64 = input.buffer.toString('base64');
  const vision = await ctx.step('vision', 'vision', async () => {
    if (input.textCandidate) {
      const { description, category } = input.textCandidate;
      return {
        imageSummary: description, lowEvidence: false,
        candidates: [{ index: 0, category, title: description.slice(0, 50), description,
          confidence: 0.8, bbox: { x: 0, y: 0, width: 0, height: 0 },
          evidence: [description], possibleConsequence: '待根据事实分析，尚未提供事故后果' }],
      } satisfies VisionState;
    }
    const prompt = ctx.contextBuilder.visionPrompt(modelName);
    ctx.recordCache('static_prompt', prompt.cacheHit, ctx.contextBuilder.visionPromptVersion);
    let call: ModelCallResult;
    const output = beginModelOutput('vision', '图像识别模型输出', modelName, 'vision', ctx, 6_000);
    try {
      const tool = await ctx.tools.execute(
        {
          name: 'model.vision',
          version: ctx.contextBuilder.visionPromptVersion,
          sideEffect: 'none',
          timeoutMs: 130_000,
          maxAttempts: 1,
          uiStage: 'vision',
          llmPhase: 'vision_analysis',
          inputForHash: { imageSha256: sha256(input.buffer), mimeType: input.mimeType, modelName },
        },
        (signal) => ctx.provider.visionStream(prompt.text, { base64: imageBase64, mimeType: input.mimeType }, {
          reasoningEffort,
          signal,
          onTextDelta: output.onTextDelta,
          telemetry: ctx.modelTelemetry({
            phase: 'vision_analysis',
            imageCount: 1,
            contextItems: [{
              id: `system:${ctx.contextBuilder.visionPromptVersion}`,
              category: 'system',
              label: '视觉分析系统指令',
              content: prompt.text,
              sourceType: 'runtime_system_prompt',
              sourceId: ctx.contextBuilder.visionPromptVersion,
            }, {
              id: `user-image:${sha256(input.buffer)}`,
              category: 'user_message',
              label: '用户上传图片',
              content: { mimeType: input.mimeType, sha256: sha256(input.buffer), bytes: input.buffer.length, tokenAttribution: 'unknown' },
              sourceType: 'user_image',
              sourceId: sha256(input.buffer),
              estimateMethod: 'unknown',
            }],
          }),
        })
      );
      call = tool.data;
    } catch (error) {
      output.fail(error);
      throw new AgentRuntimeError(`视觉模型调用失败：${(error as Error).message}`, 'MODEL_VISION_FAILED', false, error);
    }

    const parsed = safeParseModelJson(call.text, visionResultSchema);
    if (!parsed) {
      output.fail(new Error('视觉模型输出未通过结构校验'));
      throw new AgentRuntimeError('视觉模型输出未通过结构校验。', 'MODEL_VISION_OUTPUT_INVALID');
    }
    output.complete(call.text.length);
    return {
      imageSummary: parsed.imageSummary || '工程现场图片',
      candidates: parsed.candidates ?? [],
      lowEvidence: parsed.lowEvidence ?? false,
    } satisfies VisionState;
  }, (value) => ({
    candidateCount: value.candidates.length,
    lowEvidence: value.lowEvidence,
    business: {
      imageSummary: value.imageSummary,
      scenes: [...new Set(value.candidates.map((item) => item.category))].slice(0, 6),
      candidateCount: value.candidates.length,
      maxConfidence: maxConfidence(value.candidates),
    } satisfies AnalysisStageBusinessSummary,
  }));

  const contexts = await ctx.step('retrieve_knowledge', 'retrieval', async () => {
    if (!vision.candidates.length) return [] as ContextedHazard[];
    const output: ContextedHazard[] = [];
    let standards = 0;
    let cases = 0;
    for (let i = 0; i < vision.candidates.length; i += 1) {
      const candidate = vision.candidates[i];
      const ref = `H${i}`;
      const query = queryTextFor(candidate);
      const tool = await ctx.tools.execute(
        {
          name: 'knowledge.retrieve',
          version: `${ctx.knowledge.getVersion()}:${RERANK_VERSION}`,
          sideEffect: 'none',
          timeoutMs: 5_000,
          uiStage: 'retrieval',
          inputForHash: { query, category: candidate.category, standards: 6, cases: 4 },
        },
        async () => ctx.knowledge.retrieve(query, candidate.category, 6, 4)
      );
      const bundle = tool.data;
      ctx.recordCache('retrieval', bundle.cacheHit, sha256Text(`${candidate.category}:${bundle.query}`).slice(0, 16), bundle.cacheAgeMs);
      standards += bundle.standards.length;
      cases += bundle.cases.length;
      output.push({
        ref,
        category: candidate.category,
        title: candidate.title,
        description: candidate.description,
        confidence: candidate.confidence,
        bbox: candidate.bbox,
        evidence: candidate.evidence,
        possibleConsequence: candidate.possibleConsequence,
        standards: bundle.standards.map((hit, index) =>
            ({ key: `${ref}-S${index}`, clause: hit.clause, relevance: hit.relevance })),
        cases: bundle.cases.map((hit, index) =>
            ({ key: `${ref}-C${index}`, caseRecord: hit.caseRecord, similarity: hit.similarity })),
        rules: [],
      });
    }
    ctx.emit('retrieval.completed', { candidateCount: output.length, standards, cases }, 'retrieval');
    return output;
  }, (value) => ({
    skipped: value.length === 0,
    standards: value.reduce((sum, item) => sum + item.standards.length, 0),
    cases: value.reduce((sum, item) => sum + item.cases.length, 0),
  }));

  await ctx.step('match_rules', 'rules', async () => {
    for (const item of contexts) {
      const query = queryTextFor(item);
      item.rules = ctx.rules.match(query, item.category, 5).map((match, index) => ({
        key: `${item.ref}-R${index}`,
        match: { ...match, key: `${item.ref}-R${index}` },
      }));
    }
    return contexts;
  }, (value) => ({
    skipped: value.length === 0,
    matched: value.reduce((sum, item) => sum + item.rules.length, 0),
    starred: value.reduce((sum, item) => sum + item.rules.filter((entry) => entry.match.rule.starred).length, 0),
    ruleSetVersion: ctx.rules.getVersion(),
    business: {
      matchedRules: value.reduce((sum, item) => sum + item.rules.length, 0),
      starredRules: value.reduce((sum, item) => sum + item.rules.filter((entry) => entry.match.rule.starred).length, 0),
    } satisfies AnalysisStageBusinessSummary,
  }));

  if (!vision.candidates.length) {
    // 保持完整状态机：无候选时后续节点以 skipped 方式完成。
    await ctx.step('build_reasoning_context', 'context', async () => ({ skipped: true }));
    await ctx.step('reason', 'reasoning', async () => ({ skipped: true }));
    await ctx.step('validate_output', 'validation', async () => ({ skipped: true }));
    return ctx.step('assemble_result', 'assemble', async () => {
      const result = noHazardResult(
        ctx.ids.analysisId,
        vision.imageSummary,
        mode,
        modelName,
        vision.lowEvidence
      );
      await streamPublicSummary(result, 0, ctx);
      return result;
    }, (value) => ({
      hazards: 0,
      overallRisk: null,
      manualReview: value.needManualReview,
      business: finalBusinessSummary(value, 0),
    }));
  }

  const promptBundle = await ctx.step('build_reasoning_context', 'context', async () => {
    const bundle = ctx.contextBuilder.reasoningPrompt({
      perHazard: contexts.map((item) => ({
        ref: item.ref,
        category: item.category,
        title: item.title,
        description: item.description,
        confidence: item.confidence,
        evidence: item.evidence,
        possibleConsequence: item.possibleConsequence,
        standards: item.standards.map((entry) => ({
          key: entry.key,
          doc: entry.clause.documentName,
          code: entry.clause.documentCode,
          clause: entry.clause.clause,
          title: entry.clause.clauseTitle,
          content: entry.clause.content,
        })),
        cases: item.cases.map((entry) => ({
          key: entry.key,
          caseId: entry.caseRecord.caseId,
          grade: entry.caseRecord.grade,
          description: entry.caseRecord.description,
          keywords: entry.caseRecord.keywords,
          category: entry.caseRecord.category,
        })),
        rules: item.rules.map((entry) => ({
          key: entry.key,
          code: entry.match.rule.code,
          level: entry.match.rule.level,
          levelName: entry.match.rule.levelName,
          categoryPath: entry.match.rule.categoryPath,
          text: entry.match.rule.text,
          starred: entry.match.rule.starred,
        })),
      })),
    }, { modelName, ruleSetVersion: ctx.rules.getVersion() });
    ctx.recordCache('static_prompt', bundle.staticCacheHit, ctx.contextBuilder.reasoningPromptVersion);
    return bundle;
  }, (value) => ({ estimatedTokens: value.estimatedTokens, contextHash: value.contextHash, droppedBlocks: value.dropped.length }));

  const reasoning = await ctx.step('reason', 'reasoning', async () => {
    const output = beginModelOutput('reasoning', '风险推理模型输出', modelName, 'reasoning', ctx, 6_000);
    try {
      const tool = await ctx.tools.execute(
        {
          name: 'model.reason',
          version: ctx.contextBuilder.reasoningPromptVersion,
          sideEffect: 'none',
          timeoutMs: 130_000,
          maxAttempts: 1,
          uiStage: 'reasoning',
          llmPhase: 'reasoning',
          inputForHash: { contextHash: promptBundle.contextHash, modelName },
        },
        (signal) => ctx.provider.chatStream(promptBundle.system, promptBundle.user, {
          // Evidence records require more output than the legacy grade-only response.
          maxTokens: input.textCandidate && Number.isInteger(input.textMaxOutputTokens)
            ? Math.min(32000, Math.max(6400, input.textMaxOutputTokens!))
            : Math.min(32000, 4000 + contexts.length * 2400),
          reasoningEffort,
          signal,
          onTextDelta: output.onTextDelta,
          telemetry: ctx.modelTelemetry({
            phase: 'reasoning',
            contextItems: promptBundle.contextItems,
            pruneEvents: promptBundle.dropped.length ? [{
              reason: 'reasoning_context_token_budget',
              removedItemIds: promptBundle.dropped.map((item) => item.itemId),
              removedEstimatedTokens: promptBundle.dropped.reduce((sum, item) => sum + item.estimatedTokens, 0),
            }] : undefined,
          }),
        })
      );
      input.onReasoningOutput?.(tool.data.text);
      const parsed = parseReasoningResult(tool.data.text);
      if (!parsed) throw new AgentRuntimeError('推理结果未通过结构校验。', 'MODEL_REASONING_OUTPUT_INVALID');
      output.complete(tool.data.text.length);
      const normalized: NormalizedReasoningResult = {
        hazards: (parsed.hazards ?? []).map((item) => ({
          ...item,
          standardRefs: (item.standardRefs ?? []).map((ref) => ({ key: ref.key, reason: ref.reason ?? '该条款与当前隐患相关。' })),
          caseRefs: (item.caseRefs ?? []).map((ref) => ({ key: ref.key, reason: ref.reason ?? '该案例与当前隐患特征相似。' })),
          ruleRefs: (item.ruleRefs ?? []).map((ref) => ({ key: ref.key, reason: ref.reason ?? '该规则与当前隐患特征匹配。' })),
          manualReviewRequired: item.manualReviewRequired ?? false,
        })),
        needManualReview: parsed.needManualReview ?? false,
      };
      return { parsed: normalized, fallback: false, topLevelReview: normalized.needManualReview } satisfies ReasoningState;
    } catch (error) {
      output.fail(error);
      // A provider failure carries no evidence about risk. Preserve the failure and review signal.
      ctx.markFallback(`推理模型不可用或输出无效：${(error as Error).message}`, 'model.reason', 'deterministic.rules');
      return { parsed: null, fallback: true, topLevelReview: true } satisfies ReasoningState;
    }
  }, (value) => ({
    mode,
    fallback: value.fallback,
    hazardDecisions: value.parsed?.hazards.length ?? 0,
    business: {
      predictedGrade: worstGrade(value.parsed?.hazards.map((item) => item.grade) ?? []),
      hazardCount: value.parsed?.hazards.length ?? 0,
      rectificationCount: value.parsed?.hazards.reduce((sum, item) => sum + item.rectification.length, 0) ?? 0,
      requiresReview: value.topLevelReview,
    } satisfies AnalysisStageBusinessSummary,
  }));

  const finalized = await ctx.step('validate_output', 'validation', async () => {
    const value = reasoning.parsed
      ? finalizeFromModel(reasoning.parsed, contexts, reasoning.topLevelReview)
      : finalizeFromRules(contexts, reasoning.fallback);
    if (value.fallback && !reasoning.fallback) ctx.markFallback('推理候选缺失、重复或部分结构校验失败，缺失项须人工复核', 'model.reason', 'deterministic.rules');
    return value;
  }, (value) => ({
    hazards: value.hazards.length,
    fallback: value.fallback,
    manualReviewRequested: value.manualReviewRequested,
    ruleReferences: value.hazards.reduce((sum, item) => sum + (item.ruleReferences?.length ?? 0), 0),
    business: {
      finalGrade: worstGrade(value.hazards.map((item) => item.grade)),
      hazardCount: value.hazards.length,
      maxConfidence: maxConfidence(value.hazards),
      ruleReferences: value.hazards.reduce((sum, item) => sum + (item.ruleReferences?.length ?? 0), 0),
      requiresReview: value.manualReviewRequested || value.hazards.some((item) => item.manualReviewRequired),
    } satisfies AnalysisStageBusinessSummary,
  }));

  const ruleHitCount = contexts.reduce((sum, item) => sum + item.rules.length, 0);
  return ctx.step('assemble_result', 'assemble', async () => {
    const result = assembleResult({
      analysisId: ctx.ids.analysisId,
      imageSummary: vision.imageSummary,
      mode,
      modelName,
      vision,
      finalized,
    });
    await streamPublicSummary(result, ruleHitCount, ctx);
    return result;
  }, (value) => ({
    hazards: value.hazards.length,
    overallRisk: value.overallRisk,
    manualReview: value.needManualReview,
    business: finalBusinessSummary(value, ruleHitCount),
  }));
}

async function streamPublicSummary(
  result: AnalysisResult,
  ruleHitCount: number,
  ctx: RuntimeWorkflowContext
): Promise<void> {
  const prompt = ctx.contextBuilder.publicSummaryPrompt({
    imageSummary: result.imageSummary,
    overallRisk: result.overallRisk,
    needManualReview: result.needManualReview,
    ruleHitCount,
    hazards: result.hazards.map((item) => ({
      category: item.category,
      title: item.title,
      confidence: item.confidence,
      grade: item.grade,
      gradeReason: item.gradeReason.slice(0, 300),
      rectification: item.rectification.map((entry) => entry.text).slice(0, 5),
    })),
  }, result.modelName ?? ctx.provider.name);
  ctx.recordCache('static_prompt', prompt.cacheHit, ctx.contextBuilder.publicSummaryPromptVersion);
  const output = beginModelOutput(
    'public_summary',
    '最终分析摘要',
    result.modelName ?? ctx.provider.name,
    'assemble',
    ctx,
    800
  );
  try {
    const tool = await ctx.tools.execute(
      {
        name: 'model.public_summary',
        version: ctx.contextBuilder.publicSummaryPromptVersion,
        sideEffect: 'none',
        timeoutMs: 30_000,
        maxAttempts: 1,
        uiStage: 'assemble',
        llmPhase: 'final_answer',
        inputForHash: { analysisId: result.analysisId, overallRisk: result.overallRisk, hazards: result.hazards.length },
      },
      (signal) => ctx.provider.chatStream(prompt.system, prompt.user, {
        maxTokens: 384,
        reasoningEffort: 'low',
        signal,
        onTextDelta: output.onTextDelta,
        telemetry: ctx.modelTelemetry({ phase: 'final_answer', contextItems: prompt.contextItems }),
      })
    );
    output.complete(tool.data.text.length);
  } catch (error) {
    output.fail(error);
  }
}

function beginModelOutput(
  channel: 'vision' | 'reasoning' | 'public_summary',
  label: string,
  model: string,
  stage: 'vision' | 'reasoning' | 'assemble',
  ctx: RuntimeWorkflowContext,
  maxLength: number
) {
  ctx.emit('analysis.output.started', { channel, label, model, streamed: true }, stage);
  const batcher = new ModelDeltaBatcher((delta, chunkIndex) => {
    ctx.emit('analysis.output.delta', { channel, delta, chunkIndex }, stage);
  }, maxLength);
  let settled = false;
  return {
    onTextDelta: (delta: string) => batcher.push(delta),
    complete(textLength: number) {
      if (settled) return;
      settled = true;
      batcher.finish();
      ctx.emit('analysis.output.completed', { channel, label, model, textLength: Math.min(textLength, maxLength), streamed: true }, stage);
    },
    fail(error: unknown) {
      if (settled) return;
      settled = true;
      batcher.finish();
      ctx.emit('analysis.output.failed', {
        channel,
        label,
        model,
        message: `${label}中断：${(error as Error).message}`,
        streamed: true,
      }, stage);
    },
  };
}

class ModelDeltaBatcher {
  private buffer = '';
  private emittedLength = 0;
  private chunkIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emitDelta: (delta: string, chunkIndex: number) => void,
    private readonly maxLength: number
  ) {}

  push(value: string): void {
    if (this.emittedLength + this.buffer.length >= this.maxLength) return;
    const sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const available = this.maxLength - this.emittedLength - this.buffer.length;
    this.buffer += sanitized.slice(0, available);
    if (this.buffer.length >= 16) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }

  finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer) return;
    const delta = this.buffer;
    this.buffer = '';
    this.emittedLength += delta.length;
    this.emitDelta(delta, this.chunkIndex++);
  }
}

function maxConfidence(items: Array<{ confidence: number }>): number | undefined {
  return items.length ? Math.max(...items.map((item) => item.confidence)) : undefined;
}

function finalBusinessSummary(result: AnalysisResult, ruleHitCount: number): AnalysisStageBusinessSummary {
  return {
    imageSummary: result.imageSummary,
    scenes: [...new Set(result.hazards.map((item) => item.category))].slice(0, 6),
    finalGrade: result.overallRisk,
    hazardCount: result.hazards.length,
    maxConfidence: maxConfidence(result.hazards),
    matchedRules: ruleHitCount,
    ruleReferences: result.hazards.reduce((sum, item) => sum + (item.ruleReferences?.length ?? 0), 0),
    requiresReview: result.needManualReview,
  };
}

function queryTextFor(candidate: { category: string; title: string; description: string; evidence: string[] }): string {
  return [candidate.category, candidate.title, candidate.description, ...(candidate.evidence ?? [])].filter(Boolean).join('，');
}

function toStandardReference(entry: ContextedHazard['standards'][number], reason: string): StandardReference {
  const clause = entry.clause;
  return {
    type: clause.type,
    documentName: clause.documentName,
    documentCode: clause.documentCode,
    version: clause.version,
    clause: clause.clause,
    clauseTitle: clause.clauseTitle,
    content: clause.content,
    category: clause.category,
    relevance: entry.relevance,
    reason,
  };
}

function toHistoricalReference(entry: ContextedHazard['cases'][number], reason: string): HistoricalReference {
  const record = entry.caseRecord;
  return {
    caseId: record.caseId,
    similarity: entry.similarity,
    description: record.description,
    grade: record.grade,
    ref: record,
    similarityReason: reason,
  };
}

function deterministicReferences(ctx: ContextedHazard): {
  standardRefs: StandardReference[];
  caseRefs: HistoricalReference[];
  ruleRefs: RuleReference[];
} {
  return {
    standardRefs: ctx.standards.slice(0, 4).map((entry) =>
      toStandardReference(entry, `系统检索到条款「${entry.clause.clauseTitle}」与隐患「${ctx.title}」相关，需由专业人员复核适用性。`)
    ),
    caseRefs: ctx.cases.slice(0, 3).map((entry) =>
      toHistoricalReference(entry, `案例 ${entry.caseRecord.caseId} 与当前可见特征相似，历史定级仅供辅助参考。`)
    ),
    ruleRefs: ctx.rules.slice(0, 3).map((entry) =>
      toRuleReference(entry.match, `判定规则 ${entry.match.rule.code} 的类目或内容与当前隐患特征匹配。`)
    ),
  };
}

function buildHazard(
  ctx: ContextedHazard,
  index: number,
  extras: {
    standardRefs: StandardReference[];
    caseRefs: HistoricalReference[];
    ruleRefs: RuleReference[];
    rectification: RectificationItem[];
    grade: Hazard['grade'];
    gradeReason: string;
    severityScore: number;
    probabilityScore: number;
    riskScore: number;
    gradingTrace?: Hazard['gradingTrace'];
    manualReviewRequired: boolean;
  }
): Hazard {
  return {
    id: `H${String(index + 1).padStart(3, '0')}`,
    index: index + 1,
    title: ctx.title,
    category: ctx.category,
    description: ctx.description,
    confidence: Math.min(1, Math.max(0, ctx.confidence)),
    bbox: clampBBox(ctx.bbox),
    evidence: ctx.evidence,
    possibleConsequence: ctx.possibleConsequence,
    grade: extras.grade,
    gradeReason: extras.gradeReason,
    severityScore: extras.severityScore,
    probabilityScore: extras.probabilityScore,
    riskScore: extras.riskScore,
    gradingTrace: extras.gradingTrace,
    standardReferences: extras.standardRefs,
    historicalReferences: extras.caseRefs,
    ruleReferences: extras.ruleRefs,
    rectification: extras.rectification,
    manualReviewRequired: extras.manualReviewRequired,
  };
}

function finalizeFromModel(parsed: NormalizedReasoningResult, contexts: ContextedHazard[], topLevelReview: boolean): FinalizedSet {
  const decisions = new Map<string, NormalizedModelHazard>();
  const invalidRefs = new Set<string>();
  for (const item of parsed.hazards) {
    if (decisions.has(item.ref) || !contexts.some(c => c.ref===item.ref)) invalidRefs.add(item.ref);
    else decisions.set(item.ref, item);
  }
  topLevelReview ||= invalidRefs.size>0;
  const hazards: Hazard[] = [];
  let fallback = false;
  for (const ctx of contexts) {
    const decision = decisions.get(ctx.ref);
    if (!decision || invalidRefs.has(ctx.ref)) {
      hazards.push(finalizeOneFromRules(ctx, hazards.length, true));
      fallback = true;
      continue;
    }
    let unknownCitation = false;
    const standardRefs = (decision.standardRefs ?? []).flatMap((ref) => {
      const entry = ctx.standards.find((candidate) => candidate.key === ref.key);
      if (!entry) {
        unknownCitation = true;
        return [];
      }
      return [toStandardReference(entry, ref.reason || entry.clause.clauseTitle)];
    });
    const caseRefs = (decision.caseRefs ?? []).flatMap((ref) => {
      const entry = ctx.cases.find((candidate) => candidate.key === ref.key);
      if (!entry) {
        unknownCitation = true;
        return [];
      }
      return [toHistoricalReference(entry, ref.reason || '历史案例特征与当前隐患相似。')];
    });
    const ruleRefs = (decision.ruleRefs ?? []).flatMap((ref) => {
      const entry = ctx.rules.find((candidate) => candidate.key === ref.key);
      if (!entry) {
        unknownCitation = true;
        return [];
      }
      return [toRuleReference(entry.match, ref.reason || '该判定规则与当前隐患特征相匹配。')];
    });
    const guard = applyGradeGuardrail({
      grade: decision.grade,
      gradeReason: decision.gradeReason,
      severityScore: decision.severityScore,
      probabilityScore: decision.probabilityScore,
      historicalGrades: caseRefs.map((entry) => entry.grade),
      assessment: decision.riskAssessment,
      sourceTexts: [ctx.description, ...ctx.evidence],
    });
    const starredRule = ruleRefs.some((entry) => entry.starred);
    hazards.push(buildHazard(ctx, hazards.length, {
      standardRefs,
      caseRefs,
      ruleRefs,
      rectification: decision.rectification,
      grade: guard.grade,
      gradeReason: guard.gradeReason,
      severityScore: guard.severityScore,
      probabilityScore: guard.probabilityScore,
      riskScore: guard.riskScore,
      gradingTrace: guard.gradingTrace,
      manualReviewRequired:
        guard.manualReviewRequired || ctx.confidence < 0.6 || Boolean(decision.manualReviewRequired) || topLevelReview || unknownCitation || starredRule || standardRefs.length === 0,
    }));
  }
  return { hazards, fallback, manualReviewRequested: topLevelReview || fallback };
}

function finalizeFromRules(contexts: ContextedHazard[], fallback: boolean): FinalizedSet {
  return {
    hazards: contexts.map((ctx, index) => finalizeOneFromRules(ctx, index, fallback)),
    fallback,
    manualReviewRequested: fallback,
  };
}

function finalizeOneFromRules(ctx: ContextedHazard, index: number, fallback: boolean): Hazard {
  const refs = deterministicReferences(ctx);
  const severityScore = 3;
  const probabilityScore = 2;
  const graded = buildGradeReason({ severityScore, probabilityScore }, refs.caseRefs.map((entry) => entry.grade));
  return buildHazard(ctx, index, {
    standardRefs: refs.standardRefs,
    caseRefs: refs.caseRefs,
    ruleRefs: refs.ruleRefs,
    rectification: fallbackRectification(ctx.category),
    grade: graded.grade,
    gradeReason: `推理结果缺失，无法完成事实定级。仅为兼容旧接口暂填C级和辅助分数，必须人工复核，不代表已确认风险可控。${graded.reason}`,
    severityScore,
    probabilityScore,
    riskScore: severityScore * probabilityScore,
    manualReviewRequired: true,
    gradingTrace: {
      policyVersion: GRADING_POLICY_VERSION, candidateLevel: 'C', finalLevel: 'C', status: 'provisional',
      matchedRules: [], conflictingRules: [], reviewReasons: ['模型失败或候选漏项；缺少风险分析证据'],
    },
  });
}

function assembleResult(input: {
  analysisId: string;
  imageSummary: string;
  mode: 'ai';
  modelName: string;
  vision: VisionState;
  finalized: FinalizedSet;
}): AnalysisResult {
  const hazards = input.finalized.hazards;
  const standardsCited = new Set(hazards.flatMap((item) => item.standardReferences.map((ref) => `${ref.documentCode}:${ref.clause}`))).size;
  const casesCited = new Set(hazards.flatMap((item) => item.historicalReferences.map((ref) => ref.caseId))).size;
  return {
    analysisId: input.analysisId,
    imageSummary: input.imageSummary,
    overallRisk: worstGrade(hazards.map((item) => item.grade)),
    needManualReview:
      input.vision.lowEvidence || input.finalized.manualReviewRequested || input.finalized.fallback || hazards.some((item) => item.manualReviewRequired),
    hazards,
    stats: { standardsCited, casesCited },
    mode: input.mode,
    modelName: input.modelName,
    disclaimer: DISCLAIMER,
    createdAt: new Date().toISOString(),
  };
}

function noHazardResult(
  analysisId: string,
  imageSummary: string,
  mode: 'ai',
  modelName: string,
  needManualReview: boolean
): AnalysisResult {
  return {
    analysisId,
    imageSummary: imageSummary || '未识别到明确安全隐患。',
    overallRisk: null,
    needManualReview,
    hazards: [],
    stats: { standardsCited: 0, casesCited: 0 },
    mode,
    modelName,
    disclaimer: DISCLAIMER,
    createdAt: new Date().toISOString(),
  };
}

function fallbackRectification(category: string): RectificationItem[] {
  return [
    { kind: 'immediate', text: `立即对「${category || '相关'}」风险区域设置警戒并隔离人员。` },
    { kind: 'corrective', text: '组织专业人员核实现场状况，落实整改责任人并限期整改。' },
    { kind: 'preventive', text: '将该类风险纳入日常巡检与班前交底清单。' },
  ];
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
