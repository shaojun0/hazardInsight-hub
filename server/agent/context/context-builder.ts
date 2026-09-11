/** Prompt/Context 构建：静态块版本缓存、动态 evidence token 预算与裁剪记录。 */
import { createHash } from 'node:crypto';
import type { ContextItemDraft } from '../../../shared/context-observability.js';
import { VersionedTtlCache } from '../cache/versioned-cache.js';
import {
  REASONING_PROMPT_VERSION,
  PUBLIC_SUMMARY_PROMPT_VERSION,
  VISION_PROMPT_VERSION,
  VISION_SYSTEM_PROMPT,
  buildReasoningSystemPrompt,
  buildReasoningUserPrompt,
  buildPublicSummarySystemPrompt,
  buildPublicSummaryUserPrompt,
  type PublicSummaryInput,
  type ReasoningContext,
} from '../../lib/prompt.js';

export interface PromptBundle {
  system: string;
  user: string;
  estimatedTokens: number;
  dropped: Array<{ kind: 'standard' | 'case' | 'rule'; ref: string; itemId: string; estimatedTokens: number }>;
  contextItems: ContextItemDraft[];
  contextHash: string;
  staticCacheHit: boolean;
}

export class AgentContextBuilder {
  private readonly staticCache = new VersionedTtlCache<string>(100, 24 * 60 * 60 * 1000);

  get visionPromptVersion(): string {
    return VISION_PROMPT_VERSION;
  }

  get reasoningPromptVersion(): string {
    return REASONING_PROMPT_VERSION;
  }

  get publicSummaryPromptVersion(): string {
    return PUBLIC_SUMMARY_PROMPT_VERSION;
  }

  visionPrompt(modelName: string): { text: string; cacheHit: boolean } {
    const key = `${VISION_PROMPT_VERSION}:${modelName}`;
    const cached = this.staticCache.get(key);
    if (cached.hit && cached.value) return { text: cached.value, cacheHit: true };
    this.staticCache.set(key, VISION_SYSTEM_PROMPT, VISION_PROMPT_VERSION);
    return { text: VISION_SYSTEM_PROMPT, cacheHit: false };
  }

  reasoningPrompt(
    input: ReasoningContext,
    options: { modelName: string; ruleSetVersion: string; tokenBudget?: number }
  ): PromptBundle {
    const tokenBudget = options.tokenBudget ?? 24_000;
    const staticKey = `${REASONING_PROMPT_VERSION}:${options.modelName}:${options.ruleSetVersion}`;
    const staticCached = this.staticCache.get(staticKey);
    const system = staticCached.value ?? buildReasoningSystemPrompt();
    if (!staticCached.hit) this.staticCache.set(staticKey, system, REASONING_PROMPT_VERSION);

    const bounded: ReasoningContext = {
      perHazard: input.perHazard.map((item) => ({
        ...item,
        standards: [...item.standards],
        cases: [...item.cases],
        rules: [...item.rules],
      })),
    };
    const dropped: PromptBundle['dropped'] = [];
    let user = buildReasoningUserPrompt(bounded);
    // 从低优先级 evidence 开始裁剪，并在各隐患之间按剩余数量公平选择。
    // 业务规则晚于历史案例/普通知识被移除，但仍可在极端输入下让位于当前图片事实。
    const tiers: Array<{ kind: 'case' | 'standard' | 'rule'; floor: number }> = [
      { kind: 'case', floor: 1 },
      { kind: 'standard', floor: 3 },
      { kind: 'rule', floor: 3 },
      { kind: 'case', floor: 0 },
      { kind: 'standard', floor: 1 },
      { kind: 'rule', floor: 1 },
      { kind: 'standard', floor: 0 },
      { kind: 'rule', floor: 0 },
    ];
    let tierIndex = 0;
    while (estimateTokens(system + user) > tokenBudget && tierIndex < tiers.length) {
      const tier = tiers[tierIndex];
      const candidate = [...bounded.perHazard]
        .filter((item) => collection(item, tier.kind).length > tier.floor)
        .sort((a, b) => collection(b, tier.kind).length - collection(a, tier.kind).length)[0];
      if (!candidate) {
        tierIndex += 1;
        continue;
      }
      const removed = collection(candidate, tier.kind).pop() as { key?: string } | undefined;
      const itemId = injectionItemId(tier.kind, removed?.key ?? `${candidate.ref}:tail`);
      dropped.push({
        kind: tier.kind,
        ref: candidate.ref,
        itemId,
        estimatedTokens: estimateTokens(JSON.stringify(removed ?? null)),
      });
      user = buildReasoningUserPrompt(bounded);
    }
    const combined = `${system}\n${user}`;
    return {
      system,
      user,
      estimatedTokens: estimateTokens(combined),
      dropped,
      contextItems: reasoningContextItems(system, bounded),
      contextHash: createHash('sha256').update(combined).digest('hex').slice(0, 16),
      staticCacheHit: staticCached.hit,
    };
  }

  publicSummaryPrompt(input: PublicSummaryInput, modelName: string): {
    system: string;
    user: string;
    contextItems: ContextItemDraft[];
    cacheHit: boolean;
  } {
    const key = `${PUBLIC_SUMMARY_PROMPT_VERSION}:${modelName}`;
    const cached = this.staticCache.get(key);
    const system = cached.value ?? buildPublicSummarySystemPrompt();
    if (!cached.hit) this.staticCache.set(key, system, PUBLIC_SUMMARY_PROMPT_VERSION);
    const user = buildPublicSummaryUserPrompt(input);
    return {
      system,
      user,
      cacheHit: cached.hit,
      contextItems: [{
        id: `system:${PUBLIC_SUMMARY_PROMPT_VERSION}`,
        category: 'system',
        label: '公开摘要系统提示词',
        content: system,
        sourceType: 'runtime_system_prompt',
        sourceId: PUBLIC_SUMMARY_PROMPT_VERSION,
      }, {
        id: `injection:${PUBLIC_SUMMARY_PROMPT_VERSION}:validated-result`,
        category: 'injected_content',
        label: '已校验分析结果最小投影',
        content: input,
        sourceType: 'validated_analysis_result',
        sourceId: PUBLIC_SUMMARY_PROMPT_VERSION,
      }],
    };
  }
}

function reasoningContextItems(system: string, input: ReasoningContext): ContextItemDraft[] {
  const items: ContextItemDraft[] = [{
    id: `system:${REASONING_PROMPT_VERSION}`,
    category: 'system',
    label: '推理系统提示词',
    content: system,
    sourceType: 'runtime_system_prompt',
    sourceId: REASONING_PROMPT_VERSION,
  }, {
    id: `injection:${REASONING_PROMPT_VERSION}:frame`,
    category: 'injected_content',
    label: '推理上下文结构与输出枚举',
    content: '候选隐患与检索上下文结构；整改建议类型 immediate/corrective/preventive。',
    sourceType: 'runtime_frame',
    sourceId: REASONING_PROMPT_VERSION,
  }];
  for (const hazard of input.perHazard) {
    items.push({
      id: `injection:candidate:${hazard.ref}`,
      category: 'injected_content',
      label: `${hazard.ref} 视觉候选事实`,
      content: {
        ref: hazard.ref,
        category: hazard.category,
        title: hazard.title,
        description: hazard.description,
        confidence: hazard.confidence,
        evidence: hazard.evidence,
        possibleConsequence: hazard.possibleConsequence,
      },
      sourceType: 'vision_candidate',
      sourceId: hazard.ref,
    });
    for (const standard of hazard.standards) items.push({
      id: injectionItemId('standard', standard.key), category: 'injected_content', label: `${standard.key} 法规标准`, content: standard,
      sourceType: 'knowledge_standard', sourceId: standard.key,
    });
    for (const historicalCase of hazard.cases) items.push({
      id: injectionItemId('case', historicalCase.key), category: 'injected_content', label: `${historicalCase.key} 历史案例`, content: historicalCase,
      sourceType: 'knowledge_case', sourceId: historicalCase.key,
    });
    for (const rule of hazard.rules) items.push({
      id: injectionItemId('rule', rule.key), category: 'injected_content', label: `${rule.key} 业务规则`, content: rule,
      sourceType: 'business_rule', sourceId: rule.key,
    });
  }
  return items;
}

function injectionItemId(kind: 'standard' | 'case' | 'rule', key: string): string {
  return `injection:${kind}:${key}`;
}

function collection(
  item: ReasoningContext['perHazard'][number],
  kind: 'case' | 'standard' | 'rule'
): Array<unknown> {
  if (kind === 'case') return item.cases;
  if (kind === 'standard') return item.standards;
  return item.rules;
}

/** 中文为主时使用保守字符估算；Provider 返回真实 usage 后由 trace 覆盖。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}
