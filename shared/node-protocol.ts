/** Workflow Engine 与可插拔 Node 之间的统一协议。 */
import type { ZodType } from 'zod';
import type { JsonValue } from './workflow-schema.js';

export type NodeSideEffect = 'none' | 'idempotent' | 'non_idempotent';
export type NodeExecutionMode = 'sync' | 'async_suspend';
export type NodeSensitivity = 'public' | 'internal' | 'restricted';

export interface NodeCapabilities {
  executionMode: NodeExecutionMode;
  sideEffect: NodeSideEffect;
  sensitivity: NodeSensitivity;
  agentCallable: boolean;
  supportsRetry: boolean;
  supportsDryRun: boolean;
  emitsEvidence: boolean;
}

export interface NormalizedWorkflowError {
  code: string;
  category:
    | 'input'
    | 'auth'
    | 'model'
    | 'rule'
    | 'knowledge'
    | 'validation'
    | 'timeout'
    | 'conflict'
    | 'persistence'
    | 'internal';
  message: string;
  retryable: boolean;
  causedBy?: string;
}

export interface NodeEvidence {
  evidenceId: string;
  sourceType: 'standard' | 'case' | 'rule' | 'graph_node' | 'graph_edge' | 'human' | 'runtime';
  sourceId: string;
  sourceVersion: string;
  relevance?: number;
  pathId?: string;
}

export interface HumanSuspension {
  taskId: string;
  runId: string;
  nodeId: string;
  status: 'open';
  assigneeRole: string;
  inputHash: string;
  decisionSchemaRef: string;
  allowedDecisions: Array<'approve' | 'reject' | 'patch'>;
  dueAt: string;
  resumeTokenHash: string;
}

export type NodeExecutionResult<O> =
  | {
      status: 'succeeded';
      output: O;
      evidence?: NodeEvidence[];
      warnings?: string[];
      decisionSummary?: Record<string, JsonValue>;
    }
  | { status: 'waiting_human'; suspension: HumanSuspension }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: NormalizedWorkflowError };

export interface NodeExecutionRequest<I, C> {
  run: {
    runId: string;
    traceId: string;
    workflowId: string;
    workflowVersion: string;
    workflowHash: string;
    activeDeadlineAt: string;
    lifecycleDeadlineAt: string;
  };
  node: {
    nodeId: string;
    nodeRunId: string;
    attempt: number;
    inputHash: string;
  };
  input: I;
  config: C;
  idempotencyKey?: string;
  signal: AbortSignal;
}

export interface NodeDefinition<I = unknown, O = unknown, C = unknown> {
  readonly type: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: ZodType<I>;
  readonly outputSchema: ZodType<O>;
  readonly configSchema: ZodType<C>;
  readonly capabilities: NodeCapabilities;
  execute?(request: NodeExecutionRequest<I, C>): Promise<NodeExecutionResult<O>>;
}

export interface NodeCatalogEntry {
  type: string;
  version: string;
  description: string;
  capabilities: NodeCapabilities;
  implemented: boolean;
  inputJsonSchema: object;
  outputJsonSchema: object;
  configJsonSchema: object;
}
