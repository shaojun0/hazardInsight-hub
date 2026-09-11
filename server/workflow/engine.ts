/**
 * 首期确定性 Workflow Engine：支持单入口、排他路由、失败分支、retry、timeout 和 Human suspension。
 * 并行 DAG 与持久化 resume 在后续阶段接入，不改变本文件使用的 Node/State 契约。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { NodeExecutionResult } from '../../shared/node-protocol.js';
import type { EdgeSpec, NodePolicy, NodeSpec, ValueSource, WorkflowDefinition } from '../../shared/workflow-schema.js';
import { NodeExecutor } from '../nodes/executor.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { canonicalJson, contentHash } from './canonical.js';
import { evaluateCondition } from './condition-evaluator.js';
import { applyStatePatch, readStatePath, setStatePath, type WorkflowState } from './state.js';

export interface WorkflowEngineEvent {
  type: 'run.started' | 'node.started' | 'node.retry_scheduled' | 'node.completed' | 'route.selected' | 'run.waiting_human' | 'run.completed' | 'run.failed';
  runId: string;
  timestamp: string;
  nodeId?: string;
  payload: Record<string, unknown>;
}

export interface WorkflowEngineResult {
  runId: string;
  traceId: string;
  status: 'succeeded' | 'failed' | 'waiting_human' | 'rejected';
  workflowHash: string;
  state: WorkflowState;
  output?: unknown;
  error?: { code: string; message: string };
  suspension?: unknown;
  events: WorkflowEngineEvent[];
}

export class WorkflowEngine {
  private readonly executor: NodeExecutor;

  constructor(private readonly nodes: NodeRegistry) {
    this.executor = new NodeExecutor(nodes);
  }

  async run(definition: WorkflowDefinition, input: Record<string, unknown>): Promise<WorkflowEngineResult> {
    if (definition.spec.entryNodes.length !== 1) {
      throw new Error('首期 Engine 仅支持单入口排他路由；多入口并行 DAG 尚未启用。');
    }
    const runId = `wrun_${randomUUID()}`;
    const traceId = `wtrace_${randomUUID()}`;
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const workflowHash = contentHash(definition);
    const activeDeadlineAt = new Date(started + definition.spec.policies.activeExecutionMs).toISOString();
    const lifecycleDeadlineAt = new Date(started + definition.spec.policies.maxRunLifetimeMs).toISOString();
    const state: WorkflowState = {
      input: structuredClone(input),
      data: structuredClone(definition.spec.initialState?.data ?? {}),
      nodes: {},
      approvals: {},
      meta: {
        runId,
        traceId,
        startedAt,
        workflowId: definition.metadata.id,
        workflowVersion: definition.metadata.version,
        workflowHash,
      },
    };
    const events: WorkflowEngineEvent[] = [];
    const nodeById = new Map(definition.spec.nodes.map((node) => [node.id, node]));
    const visits = new Map<string, number>();
    let transitions = 0;
    let nodeCalls = 0;
    let currentId = definition.spec.entryNodes[0];
    emit('run.started', { workflowId: definition.metadata.id, workflowVersion: definition.metadata.version, workflowHash });

    while (true) {
      if (Date.now() > Date.parse(activeDeadlineAt) || Date.now() > Date.parse(lifecycleDeadlineAt)) {
        return fail('WORKFLOW_DEADLINE_EXCEEDED', 'Workflow 超过执行时限。');
      }
      if (nodeCalls >= definition.spec.policies.budgets.maxNodeCalls) {
        return fail('WORKFLOW_NODE_BUDGET_EXCEEDED', 'Workflow Node 调用预算耗尽。');
      }

      const node = nodeById.get(currentId);
      if (!node) return fail('WORKFLOW_NODE_UNKNOWN', `运行时找不到 Node：${currentId}`);
      const visitCount = (visits.get(currentId) ?? 0) + 1;
      visits.set(currentId, visitCount);
      if (visitCount > definition.spec.policies.maxVisitsPerNode) {
        return fail('WORKFLOW_NODE_VISIT_LIMIT', `Node ${currentId} 超过最大访问次数。`);
      }

      const projected = projectInput(node, state);
      if ('error' in projected) return fail(projected.error.code, projected.error.message);
      const inputHash = `sha256:${createHash('sha256').update(canonicalJson(projected.data)).digest('hex')}`;
      const policy = node.policy ?? { timeoutMs: 30_000, maxAttempts: 1 };
      let result: NodeExecutionResult<unknown> | null = null;
      let executedAttempts = 0;
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        if (Date.now() > Date.parse(activeDeadlineAt) || Date.now() > Date.parse(lifecycleDeadlineAt)) {
          return fail('WORKFLOW_DEADLINE_EXCEEDED', 'Workflow 超过执行时限。');
        }
        if (nodeCalls >= definition.spec.policies.budgets.maxNodeCalls) {
          return fail('WORKFLOW_NODE_BUDGET_EXCEEDED', 'Workflow Node 调用预算耗尽。');
        }
        nodeCalls += 1;
        executedAttempts = attempt;
        const nodeRunId = `wnode_${randomUUID()}`;
        emit('node.started', { use: node.uses, attempt, inputHash }, currentId);
        result = await this.executor.executeOnce({
          use: node.uses,
          request: {
            run: {
              runId,
              traceId,
              workflowId: definition.metadata.id,
              workflowVersion: definition.metadata.version,
              workflowHash,
              activeDeadlineAt,
              lifecycleDeadlineAt,
            },
            node: { nodeId: currentId, nodeRunId, attempt, inputHash },
            idempotencyKey: policy.idempotency
              ? `${runId}:${currentId}:${policy.idempotency.operation}:${inputHash}`
              : undefined,
          },
          nodeInput: projected.data,
          config: node.with,
          timeoutMs: policy.timeoutMs,
        });
        if (result.status !== 'failed' || !shouldRetry(result, policy.retryOn, attempt, policy.maxAttempts)) break;
        const delayMs = backoffDelay(policy.backoff, attempt);
        emit('node.retry_scheduled', { attempt, nextAttempt: attempt + 1, delayMs, code: result.error.code }, currentId);
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (!result) return fail('WORKFLOW_NODE_NO_RESULT', `Node ${currentId} 未返回结果。`);

      state.nodes[currentId] = {
        status: result.status,
        output: result.status === 'succeeded' ? structuredClone(result.output) : undefined,
        error: result.status === 'failed' ? structuredClone(result.error) : undefined,
        attempts: executedAttempts,
      };

      if (result.status === 'waiting_human') {
        state.approvals[currentId] = structuredClone(result.suspension);
        emit('run.waiting_human', { taskId: result.suspension.taskId }, currentId);
        return { runId, traceId, status: 'waiting_human', workflowHash, state, suspension: result.suspension, events };
      }
      if (result.status === 'succeeded') {
        try {
          publishOutput(node, result.output, state);
        } catch (error) {
          return fail('WORKFLOW_PUBLISH_FAILED', (error as Error).message);
        }
      }
      emit('node.completed', { status: result.status }, currentId);

      if (definition.spec.terminalNodes.includes(currentId)) {
        if (result.status === 'failed') return fail(result.error.code, result.error.message);
        emit('run.completed', { terminalNode: currentId }, currentId);
        return {
          runId,
          traceId,
          status: node.uses.startsWith('run.reject@') ? 'rejected' : 'succeeded',
          workflowHash,
          state,
          output: result.status === 'succeeded' ? result.output : undefined,
          events,
        };
      }

      const edgeStatus = result.status;
      const selection = selectEdge(definition.spec.edges, currentId, edgeStatus, state);
      if ('error' in selection) return fail(selection.error.code, selection.error.message);
      if (transitions >= definition.spec.policies.maxTransitions) {
        return fail('WORKFLOW_TRANSITION_BUDGET_EXCEEDED', 'Workflow transition 预算耗尽。');
      }
      if (selection.edge.transitionPatch?.length) {
        try {
          applyStatePatch(state, selection.edge.transitionPatch);
        } catch (error) {
          return fail('WORKFLOW_TRANSITION_PATCH_FAILED', (error as Error).message);
        }
      }
      transitions += 1;
      emit('route.selected', { edgeId: selection.edge.id, to: selection.edge.to, priority: selection.edge.priority }, currentId);
      currentId = selection.edge.to;
    }

    function emit(type: WorkflowEngineEvent['type'], payload: Record<string, unknown>, nodeId?: string): void {
      events.push({ type, runId, timestamp: new Date().toISOString(), nodeId, payload });
    }

    function fail(code: string, message: string): WorkflowEngineResult {
      emit('run.failed', { code, message }, currentId);
      return { runId, traceId, status: 'failed', workflowHash, state, error: { code, message }, events };
    }
  }
}

function projectInput(node: NodeSpec, state: WorkflowState): { data: Record<string, unknown> } | { error: { code: string; message: string } } {
  const output: Record<string, unknown> = {};
  const root = state as unknown as Record<string, unknown>;
  for (const [key, source] of Object.entries(node.input ?? {})) {
    const resolved = resolveSource(source, root);
    if (!resolved.found) {
      if (source.optional) continue;
      return { error: { code: 'WORKFLOW_INPUT_MAPPING_MISSING', message: `Node ${node.id} 缺少映射输入：${key}` } };
    }
    output[key] = structuredClone(resolved.value);
  }
  return { data: output };
}

function resolveSource(source: ValueSource, state: Record<string, unknown>): { found: boolean; value?: unknown } {
  const primary = readStatePath(state, source.from);
  if (primary.found) return primary;
  if (source.fallbackFrom) {
    const fallback = readStatePath(state, source.fallbackFrom);
    if (fallback.found) return fallback;
  }
  if (source.default !== undefined) return { found: true, value: source.default };
  return { found: false };
}

function publishOutput(node: NodeSpec, output: unknown, state: WorkflowState): void {
  const sourceRoot = { output };
  const stateRoot = state as unknown as Record<string, unknown>;
  for (const publish of node.publish ?? []) {
    const value = readStatePath(sourceRoot, publish.from);
    if (!value.found) throw new Error(`Node ${node.id} publish 来源不存在：${publish.from}`);
    setStatePath(stateRoot, publish.to, value.value, 'add');
  }
}

function selectEdge(
  edges: EdgeSpec[],
  from: string,
  status: NodeExecutionResult<unknown>['status'],
  state: WorkflowState
): { edge: EdgeSpec } | { error: { code: string; message: string } } {
  const candidates = edges
    .filter((edge) => edge.from === from && edge.on === status)
    .filter((edge) => !edge.when || evaluateCondition(edge.when, state as unknown as Record<string, unknown>))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  if (!candidates.length) {
    return { error: { code: 'WORKFLOW_ROUTE_NOT_FOUND', message: `Node ${from} 的 ${status} 状态没有命中路由。` } };
  }
  if (candidates.length > 1) {
    return { error: { code: 'WORKFLOW_ROUTE_AMBIGUOUS', message: `Node ${from} 的 ${status} 状态命中多个排他路由：${candidates.map((edge) => edge.id).join(', ')}` } };
  }
  return { edge: candidates[0] };
}

function shouldRetry(result: Extract<NodeExecutionResult<unknown>, { status: 'failed' }>, retryOn: string[] | undefined, attempt: number, maxAttempts: number): boolean {
  return result.error.retryable && attempt < maxAttempts && Boolean(retryOn?.includes(result.error.code));
}

function backoffDelay(backoff: NodePolicy['backoff'], attempt: number): number {
  if (!backoff) return 0;
  return Math.min(backoff.maxMs, backoff.initialMs * (2 ** Math.max(0, attempt - 1)));
}
