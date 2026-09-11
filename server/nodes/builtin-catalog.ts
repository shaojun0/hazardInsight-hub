/**
 * 首期 Node Catalog。
 * 这些定义先用于 DSL 强校验和 LLM authoring；逐节点适配完成后再挂接 execute。
 */
import { z } from 'zod';
import { jsonValueSchema } from '../../shared/workflow-schema.js';
import type { NodeCapabilities, NodeDefinition } from '../../shared/node-protocol.js';
import { NodeRegistry } from './registry.js';

const registryRef = z.string().regex(/^[a-z][a-z0-9-]*:\/\/[A-Za-z0-9][A-Za-z0-9._\-/:]*(?:@[0-9A-Za-z.+-]+)?$/);
const jsonObject = z.record(jsonValueSchema);

function capabilities(input: Partial<NodeCapabilities>): NodeCapabilities {
  return {
    executionMode: 'sync',
    sideEffect: 'none',
    sensitivity: 'internal',
    agentCallable: false,
    supportsRetry: false,
    supportsDryRun: true,
    emitsEvidence: false,
    ...input,
  };
}

function catalogOnly<C>(input: {
  type: string;
  description: string;
  configSchema: z.ZodType<C>;
  capabilities?: Partial<NodeCapabilities>;
}): NodeDefinition<Record<string, unknown>, Record<string, unknown>, C> {
  return {
    type: input.type,
    version: '1.0.0',
    description: input.description,
    inputSchema: jsonObject,
    outputSchema: jsonObject,
    configSchema: input.configSchema,
    capabilities: capabilities(input.capabilities ?? {}),
  };
}

export function createBuiltinNodeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();

  registry.register(catalogOnly({
    type: 'input.preflight',
    description: '输入格式、大小和权限预检。',
    configSchema: z.object({
      acceptedMediaTypes: z.array(z.string().min(1)).min(1).max(20),
      maxBytes: z.number().int().positive(),
      requiredScope: z.string().min(1),
    }).strict(),
  }));

  registry.register(catalogOnly({
    type: 'llm.vision',
    description: '多模态视觉理解和候选隐患抽取。',
    configSchema: z.object({
      modelProfileRef: registryRef,
      promptRef: registryRef,
      outputSchemaRef: registryRef,
      maxCandidates: z.number().int().min(0).max(100),
    }).strict(),
    capabilities: { agentCallable: true, supportsRetry: true, emitsEvidence: true },
  }));

  registry.register(catalogOnly({
    type: 'knowledge_graph.query',
    description: '知识图谱实体匹配、受限遍历、推理路径和评分依据。',
    configSchema: z.object({
      graphRef: registryRef,
      operation: z.enum(['query', 'match', 'match_and_assess']),
      maxPathsPerCandidate: z.number().int().min(1).max(100),
      maxDepth: z.number().int().min(1).max(10),
    }).strict(),
    capabilities: { agentCallable: true, supportsRetry: true, emitsEvidence: true },
  }));

  registry.register(catalogOnly({
    type: 'rules.evaluate',
    description: '对版本化规则集执行确定性 condition/effect 评估。',
    configSchema: z.object({
      ruleSetRef: registryRef,
      conflictPolicy: z.enum(['highest_priority_then_review', 'fail_closed']),
      includeEffects: z.array(z.enum(['add_context', 'require_human_review', 'score_factor', 'hard_constraint'])).min(1),
    }).strict(),
    capabilities: { emitsEvidence: true },
  }));

  registry.register(catalogOnly({
    type: 'llm.reason',
    description: '根据受控证据执行结构化推理并生成整改建议。',
    configSchema: z.object({
      modelProfileRef: registryRef,
      promptRef: registryRef,
      outputSchemaRef: registryRef,
      citationMode: z.literal('keys_only'),
    }).strict(),
    capabilities: { agentCallable: true, supportsRetry: true, emitsEvidence: true },
  }));

  registry.register(catalogOnly({
    type: 'risk.grade',
    description: '引用绑定、风险矩阵计算和最终 A/B/C/D 定级守卫。',
    configSchema: z.object({
      policyRef: registryRef,
      bindCitationsByKey: z.boolean(),
      rejectUnknownCitations: z.boolean(),
      requireStandardEvidence: z.boolean(),
      modelGradeAuthority: z.literal('advisory'),
    }).strict(),
    capabilities: { emitsEvidence: true },
  }));

  registry.register(catalogOnly({
    type: 'human.review',
    description: '创建可恢复、可审计的人工审批任务。',
    configSchema: z.object({
      assigneeRole: z.string().min(1),
      decisionSchemaRef: registryRef,
      allowedDecisions: z.array(z.enum(['approve', 'reject', 'patch'])).min(1),
      dueIn: z.string().regex(/^P(?!$).+/),
      onTimeout: z.enum(['reject', 'keep_waiting']),
      requireReasonFor: z.array(z.enum(['approve', 'reject', 'patch'])).optional(),
    }).strict(),
    capabilities: {
      executionMode: 'async_suspend',
      sideEffect: 'idempotent',
      sensitivity: 'restricted',
    },
  }));

  registry.register(catalogOnly({
    type: 'result.assemble',
    description: '组装并校验最终 AnalysisResult。',
    configSchema: z.object({
      outputSchemaRef: registryRef,
      disclaimerRef: registryRef.optional(),
      preferHumanPatch: z.boolean(),
    }).strict(),
    capabilities: { sideEffect: 'idempotent' },
  }));

  registry.register(catalogOnly({
    type: 'run.reject',
    description: '以稳定错误码终止并驳回 Run。',
    configSchema: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]+$/) }).strict(),
  }));

  return registry;
}

