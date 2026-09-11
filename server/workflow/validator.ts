/** Workflow 发布前的 Schema、图结构、Node、策略和领域安全校验。 */
import type { WorkflowDefinition } from '../../shared/workflow-schema.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { contentHash } from './canonical.js';

export interface WorkflowValidationIssue {
  code: string;
  path: string;
  message: string;
  requiresReview?: boolean;
}

export interface WorkflowValidationReport {
  valid: boolean;
  canonicalHash: string;
  errors: WorkflowValidationIssue[];
  warnings: WorkflowValidationIssue[];
  resolvedNodes: Array<{ nodeId: string; use: string; implemented: boolean }>;
  riskSummary: {
    sideEffects: string[];
    humanGates: string[];
    unimplementedNodes: string[];
  };
}

export function validateWorkflow(definition: WorkflowDefinition, registry: NodeRegistry): WorkflowValidationReport {
  const errors: WorkflowValidationIssue[] = [];
  const warnings: WorkflowValidationIssue[] = [];
  const resolvedNodes: WorkflowValidationReport['resolvedNodes'] = [];
  const sideEffects: string[] = [];
  const humanGates: string[] = [];
  const unimplementedNodes: string[] = [];

  const nodeIds = new Set<string>();
  const nodeTypes = new Set<string>();
  definition.spec.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) error('WORKFLOW_NODE_DUPLICATE', `$.spec.nodes.${index}.id`, `Node ID 重复：${node.id}`);
    nodeIds.add(node.id);
    const type = node.uses.slice(0, node.uses.lastIndexOf('@'));
    nodeTypes.add(type);

    const registered = registry.resolve(node.uses);
    if (!registered) {
      error('WORKFLOW_NODE_UNKNOWN', `$.spec.nodes.${index}.uses`, `Node 未注册：${node.uses}`);
      return;
    }
    resolvedNodes.push({ nodeId: node.id, use: node.uses, implemented: Boolean(registered.execute) });
    if (!registered.execute) {
      unimplementedNodes.push(node.id);
      warning('WORKFLOW_NODE_NOT_EXECUTABLE', `$.spec.nodes.${index}.uses`, `Node ${node.uses} 已有契约，但执行适配器尚未接入。`);
    }
    const config = registered.configSchema.safeParse(node.with);
    if (!config.success) {
      for (const issue of config.error.issues) {
        error('WORKFLOW_NODE_CONFIG_INVALID', `$.spec.nodes.${index}.with.${issue.path.join('.')}`, issue.message);
      }
    }
    if (!definition.spec.policies.security.allowedNodeTypes.includes(registered.type)) {
      error('WORKFLOW_NODE_NOT_ALLOWED', `$.spec.nodes.${index}.uses`, `安全策略未允许 Node 类型：${registered.type}`);
    }
    if (registered.capabilities.sideEffect !== 'none') sideEffects.push(`${node.id}:${registered.capabilities.sideEffect}`);
    if (registered.capabilities.sideEffect === 'non_idempotent' && !definition.spec.policies.security.allowNonIdempotent) {
      error('WORKFLOW_NON_IDEMPOTENT_DENIED', `$.spec.nodes.${index}.uses`, `Workflow 禁止非幂等 Node：${node.uses}`);
    }
    if (registered.type === 'human.review') humanGates.push(node.id);
  });

  const edgeIds = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    reverse.set(id, []);
  }
  definition.spec.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) error('WORKFLOW_EDGE_DUPLICATE', `$.spec.edges.${index}.id`, `Edge ID 重复：${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) error('WORKFLOW_EDGE_FROM_UNKNOWN', `$.spec.edges.${index}.from`, `来源 Node 不存在：${edge.from}`);
    if (!nodeIds.has(edge.to)) error('WORKFLOW_EDGE_TO_UNKNOWN', `$.spec.edges.${index}.to`, `目标 Node 不存在：${edge.to}`);
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
      reverse.get(edge.to)!.push(edge.from);
    }
    for (const path of collectConditionPaths(edge.when)) validateNodePath(path, `$.spec.edges.${index}.when`);
  });

  definition.spec.entryNodes.forEach((id, index) => {
    if (!nodeIds.has(id)) error('WORKFLOW_ENTRY_UNKNOWN', `$.spec.entryNodes.${index}`, `入口 Node 不存在：${id}`);
  });
  definition.spec.terminalNodes.forEach((id, index) => {
    if (!nodeIds.has(id)) error('WORKFLOW_TERMINAL_UNKNOWN', `$.spec.terminalNodes.${index}`, `终点 Node 不存在：${id}`);
    if ((adjacency.get(id)?.length ?? 0) > 0) {
      error('WORKFLOW_TERMINAL_HAS_OUTGOING_EDGE', `$.spec.terminalNodes.${index}`, `终点 Node 不能有出边：${id}`);
    }
  });

  definition.spec.nodes.forEach((node, index) => {
    for (const source of Object.values(node.input ?? {})) {
      validateNodePath(source.from, `$.spec.nodes.${index}.input`);
      if (source.fallbackFrom) validateNodePath(source.fallbackFrom, `$.spec.nodes.${index}.input`);
    }
  });

  validateRouteGroups();
  validateSingleWriters();
  validateGraph();
  validateDomainGuardrails();

  return {
    valid: errors.length === 0,
    canonicalHash: contentHash(definition),
    errors,
    warnings,
    resolvedNodes,
    riskSummary: { sideEffects, humanGates, unimplementedNodes },
  };

  function error(code: string, path: string, message: string): void {
    errors.push({ code, path, message });
  }

  function warning(code: string, path: string, message: string, requiresReview = false): void {
    warnings.push({ code, path, message, requiresReview });
  }

  function validateNodePath(path: string, issuePath: string): void {
    const match = path.match(/^nodes#\/([^/]+)/);
    if (!match) return;
    const nodeId = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
    if (!nodeIds.has(nodeId)) error('WORKFLOW_STATE_NODE_UNKNOWN', issuePath, `State 路径引用了未知 Node：${nodeId}`);
  }

  function validateRouteGroups(): void {
    const groups = new Map<string, typeof definition.spec.edges>();
    for (const edge of definition.spec.edges) {
      const key = `${edge.from}:${edge.on}`;
      const group = groups.get(key) ?? [];
      group.push(edge);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const defaults = group.filter((edge) => !edge.when);
      if (defaults.length > 1) error('WORKFLOW_ROUTE_MULTIPLE_DEFAULTS', '$.spec.edges', `路由 ${key} 存在多个无条件 Edge。`);
      const priorities = new Set<number>();
      for (const edge of group) {
        if (priorities.has(edge.priority)) {
          warning('WORKFLOW_ROUTE_PRIORITY_DUPLICATE', '$.spec.edges', `路由 ${key} 存在重复 priority=${edge.priority}，运行时多命中会失败。`, true);
        }
        priorities.add(edge.priority);
      }
    }
  }

  function validateSingleWriters(): void {
    const writers = new Map<string, string>();
    definition.spec.nodes.forEach((node, index) => {
      for (const publish of node.publish ?? []) {
        const previous = writers.get(publish.to);
        if (previous && previous !== node.id) {
          error('WORKFLOW_STATE_MULTIPLE_WRITERS', `$.spec.nodes.${index}.publish`, `State ${publish.to} 同时由 ${previous} 和 ${node.id} 写入。`);
        } else {
          writers.set(publish.to, node.id);
        }
      }
    });
  }

  function validateGraph(): void {
    if (definition.spec.mode === 'dag') {
      const color = new Map<string, 0 | 1 | 2>();
      const visit = (nodeId: string): void => {
        const current = color.get(nodeId) ?? 0;
        if (current === 1) {
          error('WORKFLOW_DAG_CYCLE', '$.spec.edges', `DAG 检测到环：${nodeId}`);
          return;
        }
        if (current === 2) return;
        color.set(nodeId, 1);
        for (const next of adjacency.get(nodeId) ?? []) visit(next);
        color.set(nodeId, 2);
      };
      for (const id of nodeIds) visit(id);
      if (definition.spec.policies.maxVisitsPerNode !== 1) {
        warning('WORKFLOW_DAG_VISIT_LIMIT_REDUNDANT', '$.spec.policies.maxVisitsPerNode', 'DAG 的 maxVisitsPerNode 建议固定为 1。');
      }
    } else if (definition.spec.policies.maxTransitions < 2 || definition.spec.policies.maxVisitsPerNode < 2) {
      warning('WORKFLOW_STATE_MACHINE_TIGHT_LIMIT', '$.spec.policies', '状态机预算可能不足以执行回边。');
    }

    const reachable = traverse(definition.spec.entryNodes, adjacency);
    for (const id of nodeIds) {
      if (!reachable.has(id)) error('WORKFLOW_NODE_UNREACHABLE', '$.spec.nodes', `Node 从入口不可达：${id}`);
    }
    const canReachTerminal = traverse(definition.spec.terminalNodes, reverse);
    for (const id of nodeIds) {
      if (!canReachTerminal.has(id)) error('WORKFLOW_TERMINAL_UNREACHABLE', '$.spec.nodes', `Node 无法到达任何终点：${id}`);
    }
  }

  function validateDomainGuardrails(): void {
    if (definition.metadata.id !== 'hazard-analysis') return;
    for (const required of ['input.preflight', 'risk.grade', 'result.assemble']) {
      if (!nodeTypes.has(required)) error('WORKFLOW_REQUIRED_GUARD_MISSING', '$.spec.nodes', `隐患分析 Workflow 缺少强制 Node：${required}`);
    }
    if (!nodeTypes.has('human.review')) {
      warning('WORKFLOW_HUMAN_GATE_MISSING', '$.spec.nodes', '隐患分析没有 Human Review Node。', true);
    }
  }
}

function traverse(start: string[], graph: Map<string, string[]>): Set<string> {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function collectConditionPaths(condition: WorkflowDefinition['spec']['edges'][number]['when']): string[] {
  if (!condition) return [];
  if ('all' in condition) return condition.all.flatMap(collectConditionPaths);
  if ('any' in condition) return condition.any.flatMap(collectConditionPaths);
  if ('not' in condition) return collectConditionPaths(condition.not);
  if ('exists' in condition) return [condition.exists.path];
  if ('eq' in condition) return [condition.eq.path];
  if ('in' in condition) return [condition.in.path];
  if ('gt' in condition) return [condition.gt.path];
  if ('gte' in condition) return [condition.gte.path];
  if ('lt' in condition) return [condition.lt.path];
  return [condition.lte.path];
}
