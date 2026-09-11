/**
 * 可配置 Workflow DSL 的权威 Zod Schema。
 * YAML/JSON 都必须先转换为普通对象，再通过本文件校验；配置不得携带可执行代码。
 */
import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const identifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const registryUriSchema = z.string()
  .max(240)
  .regex(/^[a-z][a-z0-9-]*:\/\/[A-Za-z0-9][A-Za-z0-9._\-/:]*(?:@[0-9A-Za-z.+-]+)?$/);
const nodeUseSchema = z.string()
  .regex(/^[a-z][a-z0-9_.-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

/** 固定 namespace + RFC 6901 JSON Pointer。 */
export const statePathSchema = z.string()
  .max(300)
  .regex(/^(input|data|nodes|approvals|meta|output)#(?:\/(?:[^~\/]|~[01])*)*$/);

const runtimeStatePathSchema = statePathSchema.refine((value) => !value.startsWith('output#'), {
  message: '运行态映射不能读取 output namespace。',
});
const outputPathSchema = statePathSchema.refine((value) => value.startsWith('output#'), {
  message: 'publish.from 必须读取 output namespace。',
});
const dataPathSchema = statePathSchema.refine((value) => value.startsWith('data#'), {
  message: 'publish.to 必须写入 data namespace。',
});

export const valueSourceSchema = z.object({
  from: runtimeStatePathSchema,
  fallbackFrom: runtimeStatePathSchema.optional(),
  default: jsonValueSchema.optional(),
  optional: z.boolean().optional(),
}).strict();

const binaryPredicateSchema = z.object({
  path: runtimeStatePathSchema,
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
}).strict();

const numericPredicateSchema = z.object({
  path: runtimeStatePathSchema,
  value: z.number().finite(),
}).strict();

export type ConditionExpr =
  | { all: ConditionExpr[] }
  | { any: ConditionExpr[] }
  | { not: ConditionExpr }
  | { exists: { path: string } }
  | { eq: { path: string; value: JsonPrimitive } }
  | { in: { path: string; values: JsonPrimitive[] } }
  | { gt: { path: string; value: number } }
  | { gte: { path: string; value: number } }
  | { lt: { path: string; value: number } }
  | { lte: { path: string; value: number } };

export const conditionExprSchema: z.ZodType<ConditionExpr> = z.lazy(() => z.union([
  z.object({ all: z.array(conditionExprSchema).min(1).max(32) }).strict(),
  z.object({ any: z.array(conditionExprSchema).min(1).max(32) }).strict(),
  z.object({ not: conditionExprSchema }).strict(),
  z.object({ exists: z.object({ path: runtimeStatePathSchema }).strict() }).strict(),
  z.object({ eq: binaryPredicateSchema }).strict(),
  z.object({ in: z.object({
    path: runtimeStatePathSchema,
    values: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).min(1).max(100),
  }).strict() }).strict(),
  z.object({ gt: numericPredicateSchema }).strict(),
  z.object({ gte: numericPredicateSchema }).strict(),
  z.object({ lt: numericPredicateSchema }).strict(),
  z.object({ lte: numericPredicateSchema }).strict(),
]));

export const statePatchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'test']),
  path: z.string().regex(/^(data|approvals|meta)#(?:\/(?:[^~\/]|~[01])*)*$/),
  value: jsonValueSchema.optional(),
}).strict();

const backoffSchema = z.object({
  type: z.literal('exponential'),
  initialMs: z.number().int().min(0).max(60_000),
  maxMs: z.number().int().min(0).max(300_000),
}).strict().refine((value) => value.maxMs >= value.initialMs, {
  message: 'backoff.maxMs 不能小于 initialMs。',
});

export const nodePolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(172_800_000),
  maxAttempts: z.number().int().min(1).max(10),
  retryOn: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/)).max(30).optional(),
  backoff: backoffSchema.optional(),
  schemaRepairAttempts: z.number().int().min(0).max(3).optional(),
  idempotency: z.object({
    operation: z.string().regex(/^[a-z][a-z0-9._-]{0,80}$/),
  }).strict().optional(),
}).strict();

export const nodeSpecSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(120).optional(),
  uses: nodeUseSchema,
  with: z.record(jsonValueSchema).default({}),
  input: z.record(valueSourceSchema).optional(),
  publish: z.array(z.object({
    from: outputPathSchema,
    to: dataPathSchema,
  }).strict()).max(100).optional(),
  policy: nodePolicySchema.optional(),
}).strict();

export const edgeSpecSchema = z.object({
  id: identifierSchema,
  from: identifierSchema,
  to: identifierSchema,
  on: z.enum(['succeeded', 'failed', 'skipped', 'approved', 'rejected', 'timed_out']),
  when: conditionExprSchema.optional(),
  priority: z.number().int().min(-10_000).max(10_000),
  transitionPatch: z.array(statePatchOperationSchema).max(50).optional(),
}).strict();

export const workflowPoliciesSchema = z.object({
  activeExecutionMs: z.number().int().positive().max(86_400_000),
  maxRunLifetimeMs: z.number().int().positive().max(31_536_000_000),
  maxTransitions: z.number().int().min(1).max(10_000),
  maxVisitsPerNode: z.number().int().min(1).max(100),
  routing: z.object({
    onAmbiguous: z.literal('fail'),
    onNoMatch: z.literal('fail'),
  }).strict(),
  budgets: z.object({
    maxNodeCalls: z.number().int().min(1).max(10_000),
    maxModelCalls: z.number().int().min(0).max(1_000),
    maxToolCalls: z.number().int().min(0).max(10_000),
    maxRetrievals: z.number().int().min(0).max(10_000),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxEstimatedCost: z.number().nonnegative().optional(),
  }).strict(),
  security: z.object({
    allowedNodeTypes: z.array(z.string().regex(/^[a-z][a-z0-9_.-]*$/)).min(1).max(200),
    allowedSecretRefs: z.array(registryUriSchema).max(100),
    allowedKnowledgeScopes: z.array(z.string().min(1).max(100)).max(100),
    allowNonIdempotent: z.boolean(),
    requireSignedDefinition: z.boolean(),
  }).strict(),
  human: z.object({
    mode: z.enum(['block_and_resume', 'flag_only']),
  }).strict(),
}).strict().refine((value) => value.maxRunLifetimeMs >= value.activeExecutionMs, {
  message: 'maxRunLifetimeMs 不能小于 activeExecutionMs。',
});

const dependencyBindingsSchema = z.object({
  modelProfiles: z.record(registryUriSchema).default({}),
  prompts: z.record(registryUriSchema).default({}),
  ruleSet: registryUriSchema.optional(),
  graph: registryUriSchema.optional(),
  gradingPolicy: registryUriSchema.optional(),
  knowledge: registryUriSchema.optional(),
}).strict();

export const workflowDefinitionSchema = z.object({
  apiVersion: z.literal('workflow.openai.local/v1alpha1'),
  kind: z.literal('Workflow'),
  metadata: z.object({
    id: identifierSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    version: versionSchema,
    labels: z.record(z.string().max(120)).optional(),
    owner: z.string().min(1).max(120),
  }).strict(),
  spec: z.object({
    mode: z.enum(['dag', 'state_machine']),
    inputSchemaRef: registryUriSchema,
    outputSchemaRef: registryUriSchema,
    initialState: z.object({ data: z.record(jsonValueSchema).optional() }).strict().optional(),
    entryNodes: z.array(identifierSchema).min(1).max(20),
    terminalNodes: z.array(identifierSchema).min(1).max(20),
    dependencies: dependencyBindingsSchema,
    policies: workflowPoliciesSchema,
    nodes: z.array(nodeSpecSchema).min(1).max(500),
    edges: z.array(edgeSpecSchema).max(2_000),
  }).strict(),
}).strict();

export type ValueSource = z.infer<typeof valueSourceSchema>;
export type StatePatchOperation = z.infer<typeof statePatchOperationSchema>;
export type NodePolicy = z.infer<typeof nodePolicySchema>;
export type NodeSpec = z.infer<typeof nodeSpecSchema>;
export type EdgeSpec = z.infer<typeof edgeSpecSchema>;
export type WorkflowPolicies = z.infer<typeof workflowPoliciesSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

