import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import type { NodeCapabilities, NodeDefinition } from '../../shared/node-protocol.js';
import type { WorkflowDefinition } from '../../shared/workflow-schema.js';
import { createApp } from '../../server/http/app.js';
import { createBuiltinNodeRegistry } from '../../server/nodes/builtin-catalog.js';
import { NodeRegistry } from '../../server/nodes/registry.js';
import { contentHash } from '../../server/workflow/canonical.js';
import { evaluateCondition } from '../../server/workflow/condition-evaluator.js';
import { WorkflowEngine } from '../../server/workflow/engine.js';
import { loadWorkflowSource, parseWorkflowObject, WorkflowLoadError } from '../../server/workflow/loader.js';
import { validateWorkflow } from '../../server/workflow/validator.js';

const WORKFLOW_FILE = resolve(process.cwd(), 'configs', 'workflows', 'hazard-analysis.v1.yaml');

test('built-in hazard YAML parses, validates and has a stable canonical hash', () => {
  const yaml = readFileSync(WORKFLOW_FILE, 'utf8');
  const definition = loadWorkflowSource(yaml, 'yaml');
  const jsonDefinition = loadWorkflowSource(JSON.stringify(definition), 'json');
  const report = validateWorkflow(definition, createBuiltinNodeRegistry());

  assert.equal(definition.metadata.id, 'hazard-analysis');
  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.canonicalHash, contentHash(jsonDefinition));
  assert.deepEqual(
    new Set(definition.spec.nodes.map((node) => node.uses.split('@')[0])),
    new Set([
      'input.preflight', 'llm.vision', 'knowledge_graph.query', 'rules.evaluate',
      'llm.reason', 'risk.grade', 'human.review', 'result.assemble', 'run.reject',
    ])
  );
});

test('safe YAML loader rejects duplicate keys and unknown executable fields', () => {
  const source = readFileSync(WORKFLOW_FILE, 'utf8');
  assert.throws(
    () => loadWorkflowSource(source.replace('kind: Workflow', 'kind: Workflow\nkind: Workflow'), 'yaml'),
    WorkflowLoadError
  );
  const definition = loadWorkflowSource(source, 'yaml') as WorkflowDefinition & { execute?: string };
  definition.execute = 'process.exit(0)';
  assert.throws(() => parseWorkflowObject(definition), WorkflowLoadError);
});

test('validator rejects cycles, terminal outgoing edges and unknown node references', () => {
  const definition = loadWorkflowSource(readFileSync(WORKFLOW_FILE, 'utf8'), 'yaml');
  const broken = structuredClone(definition);
  broken.spec.edges.push({
    id: 'unsafe_cycle',
    from: 'assemble',
    to: 'vision',
    on: 'succeeded',
    priority: 1,
  });
  broken.spec.edges[0].to = 'missing_node';
  const report = validateWorkflow(broken, createBuiltinNodeRegistry());
  const codes = new Set(report.errors.map((issue) => issue.code));
  assert.equal(report.valid, false);
  assert.ok(codes.has('WORKFLOW_EDGE_TO_UNKNOWN'));
  assert.ok(codes.has('WORKFLOW_TERMINAL_HAS_OUTGOING_EDGE'));
  assert.ok(codes.has('WORKFLOW_DAG_CYCLE'));
});

test('condition evaluator only reads structured state paths', () => {
  const state = {
    input: { source: 'camera' },
    data: { score: 12, flags: { review: true } },
    nodes: {},
    approvals: {},
    meta: {},
  };
  assert.equal(evaluateCondition({ all: [
    { gte: { path: 'data#/score', value: 9 } },
    { eq: { path: 'data#/flags/review', value: true } },
    { in: { path: 'input#/source', values: ['camera', 'robot'] } },
  ] }, state), true);
  assert.equal(evaluateCondition({ exists: { path: 'data#/missing' } }, state), false);
});

test('engine executes validated nodes, publishes state and selects one deterministic route', async () => {
  const registry = new NodeRegistry();
  registry.register(startNode());
  registry.register(finishNode());
  const definition = linearWorkflow();
  const report = validateWorkflow(definition, registry);
  assert.equal(report.valid, true);
  assert.equal(report.riskSummary.unimplementedNodes.length, 0);

  const result = await new WorkflowEngine(registry).run(definition, { value: 2 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { value: 3 });
  assert.equal(result.state.data.value, 3);
  assert.equal(result.events.filter((event) => event.type === 'route.selected').length, 1);
  assert.equal(result.events.at(-1)?.type, 'run.completed');
});

test('engine retries only an allowlisted retryable error', async () => {
  let calls = 0;
  const registry = new NodeRegistry();
  registry.register<Record<string, never>, { ok: boolean }, Record<string, never>>({
    type: 'test.retry',
    version: '1.0.0',
    description: 'retry test',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    configSchema: z.object({}).strict(),
    capabilities: nodeCapabilities({ supportsRetry: true }),
    async execute() {
      calls += 1;
      return calls === 1
        ? { status: 'failed', error: { code: 'TEMPORARY', category: 'internal', message: 'retry', retryable: true } }
        : { status: 'succeeded', output: { ok: true } };
    },
  });
  const definition = parseWorkflowObject({
    ...workflowBase('retry-workflow', ['retry'], ['retry']),
    spec: {
      ...workflowBase('retry-workflow', ['retry'], ['retry']).spec,
      policies: policies(['test.retry']),
      nodes: [{
        id: 'retry',
        uses: 'test.retry@1.0.0',
        with: {},
        input: {},
        policy: { timeoutMs: 1000, maxAttempts: 2, retryOn: ['TEMPORARY'] },
      }],
      edges: [],
    },
  });
  const result = await new WorkflowEngine(registry).run(definition, {});
  assert.equal(result.status, 'succeeded');
  assert.equal(calls, 2);
  assert.equal(result.events.filter((event) => event.type === 'node.retry_scheduled').length, 1);
});

test('workflow control API exposes catalog, built-in draft and YAML validation', async () => {
  const app = createApp({ auth: false });
  const server = await new Promise<Server>((resolveServer) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const catalog = await fetch(`${base}/api/node-catalog`).then((response) => response.json()) as { data: unknown[] };
    assert.equal(catalog.data.length, 9);

    const revisionResponse = await fetch(`${base}/api/workflows/hazard-analysis/versions/1.0.0`);
    assert.equal(revisionResponse.status, 200);
    const revision = await revisionResponse.json() as { data: { status: string; validation: { valid: boolean } } };
    assert.equal(revision.data.status, 'draft');
    assert.equal(revision.data.validation.valid, true);

    const validationResponse = await fetch(`${base}/api/workflows/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/yaml' },
      body: readFileSync(WORKFLOW_FILE, 'utf8'),
    });
    assert.equal(validationResponse.status, 200);
    const validation = await validationResponse.json() as { data: { valid: boolean; errors: unknown[] } };
    assert.equal(validation.data.valid, true);
    assert.equal(validation.data.errors.length, 0);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

function nodeCapabilities(overrides: Partial<NodeCapabilities> = {}): NodeCapabilities {
  return {
    executionMode: 'sync',
    sideEffect: 'none',
    sensitivity: 'internal',
    agentCallable: false,
    supportsRetry: false,
    supportsDryRun: true,
    emitsEvidence: false,
    ...overrides,
  };
}

function startNode(): NodeDefinition<{ value: number }, { value: number; route: string }, { increment: number }> {
  return {
    type: 'test.start',
    version: '1.0.0',
    description: 'start test',
    inputSchema: z.object({ value: z.number() }).strict(),
    outputSchema: z.object({ value: z.number(), route: z.string() }).strict(),
    configSchema: z.object({ increment: z.number() }).strict(),
    capabilities: nodeCapabilities(),
    async execute(request) {
      return { status: 'succeeded', output: { value: request.input.value + request.config.increment, route: 'go' } };
    },
  };
}

function finishNode(): NodeDefinition<{ value: number }, { value: number }, Record<string, never>> {
  return {
    type: 'test.finish',
    version: '1.0.0',
    description: 'finish test',
    inputSchema: z.object({ value: z.number() }).strict(),
    outputSchema: z.object({ value: z.number() }).strict(),
    configSchema: z.object({}).strict(),
    capabilities: nodeCapabilities(),
    async execute(request) {
      return { status: 'succeeded', output: request.input };
    },
  };
}

function linearWorkflow(): WorkflowDefinition {
  const base = workflowBase('linear-workflow', ['start'], ['finish']);
  return parseWorkflowObject({
    ...base,
    spec: {
      ...base.spec,
      policies: policies(['test.start', 'test.finish']),
      nodes: [
        {
          id: 'start',
          uses: 'test.start@1.0.0',
          with: { increment: 1 },
          input: { value: { from: 'input#/value' } },
          publish: [{ from: 'output#/value', to: 'data#/value' }],
          policy: { timeoutMs: 1000, maxAttempts: 1 },
        },
        {
          id: 'finish',
          uses: 'test.finish@1.0.0',
          with: {},
          input: { value: { from: 'data#/value' } },
          policy: { timeoutMs: 1000, maxAttempts: 1 },
        },
      ],
      edges: [{
        id: 'start_to_finish',
        from: 'start',
        to: 'finish',
        on: 'succeeded',
        priority: 100,
        when: { eq: { path: 'nodes#/start/output/route', value: 'go' } },
      }],
    },
  });
}

function workflowBase(id: string, entryNodes: string[], terminalNodes: string[]) {
  return {
    apiVersion: 'workflow.openai.local/v1alpha1',
    kind: 'Workflow',
    metadata: { id, name: id, version: '1.0.0', owner: 'test' },
    spec: {
      mode: 'dag',
      inputSchemaRef: 'schema://test/input@1.0.0',
      outputSchemaRef: 'schema://test/output@1.0.0',
      initialState: { data: {} },
      entryNodes,
      terminalNodes,
      dependencies: { modelProfiles: {}, prompts: {} },
      policies: policies([]),
      nodes: [],
      edges: [],
    },
  };
}

function policies(allowedNodeTypes: string[]) {
  return {
    activeExecutionMs: 10_000,
    maxRunLifetimeMs: 10_000,
    maxTransitions: 10,
    maxVisitsPerNode: 1,
    routing: { onAmbiguous: 'fail', onNoMatch: 'fail' },
    budgets: { maxNodeCalls: 10, maxModelCalls: 0, maxToolCalls: 10, maxRetrievals: 0 },
    security: {
      allowedNodeTypes,
      allowedSecretRefs: [],
      allowedKnowledgeScopes: [],
      allowNonIdempotent: false,
      requireSignedDefinition: false,
    },
    human: { mode: 'flag_only' },
  };
}
