import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunIds } from '../../shared/agent-protocol.js';
import type { ContextItemDraft, ProviderRequestObservation, ProviderResponseObservation } from '../../shared/context-observability.js';
import { ContextObservabilityStore } from '../../server/agent/observability/context-observability-store.js';

function ids(run = 'run_1', agentSession = 'sess_ctx'): AgentRunIds {
  return { userId: 'usr_test', conversationId: 'conv_ctx', sessionId: agentSession, taskId: `task_${run}`, runId: run, traceId: `trace_${run}`, analysisId: `analysis_${run}` };
}

function request(invocationId: string, attempt = 1): ProviderRequestObservation {
  return { invocationId, attempt, provider: 'provider-test', model: 'model-test', startedAt: new Date(1_700_000_000_000 + attempt).toISOString(), payloadHash: `payload-${invocationId}` };
}

function response(invocationId: string, input = 13_000, output = 200, cached = 0): ProviderResponseObservation {
  return { invocationId, status: 'completed', completedAt: new Date(1_700_000_001_000).toISOString(), latencyMs: 999, usage: { inputTokens: input, outputTokens: output, cachedTokens: cached, totalTokens: input + output, cachedTokensAvailable: true, source: 'provider' } };
}

function item(id: string, category: ContextItemDraft['category'], content: string): ContextItemDraft {
  return { id, category, label: id, content, sourceType: 'test' };
}

function start(store: ContextObservabilityStore, runIds: AgentRunIds, turn: ReturnType<ContextObservabilityStore['registerRun']>, invocationId: string, items: ContextItemDraft[], extras: { contextWindow?: number; prune?: boolean; agentId?: string; pricing?: { currency: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number } } = {}) {
  return store.startRequest({ ids: runIds, agentId: extras.agentId ?? 'master', turn, phase: 'reasoning', contextItems: items, contextWindow: extras.contextWindow, pricing: extras.pricing, pruneEvents: extras.prune ? [{ reason: 'budget', removedItemIds: ['gone'], removedEstimatedTokens: 50 }] : undefined }, request(invocationId));
}

test('one user run is one Turn and one provider request is one LLM Step', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  start(store, runIds, turn, 'inv-1', [item('u1', 'user_message', 'hello')]);
  const view = store.getOverview(runIds.conversationId, runIds.sessionId);
  assert.equal(view.agents[0].stats.turnCount, 1); assert.equal(view.agents[0].stats.stepCount, 1);
});

test('multiple real requests in one Turn produce multiple Steps without tool-created Steps', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  ['a', 'b', 'c'].forEach((invocation) => start(store, runIds, turn, invocation, [item('u1', 'user_message', 'same turn')]));
  const agent = store.getOverview(runIds.conversationId, runIds.sessionId).agents[0];
  assert.equal(agent.stats.turnCount, 1); assert.deepEqual(agent.steps.map((step) => step.stepIndex), [1, 2, 3]);
});

test('tool result attribution is exclusive to tool_result', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const step = start(store, runIds, turn, 'tool-result', [item('tool:1', 'tool_result', 'shell output')]);
  assert.equal(step.snapshot.categories.tool_result.itemCount, 1); assert.equal(step.snapshot.categories.assistant_message.itemCount, 0);
});

test('actual prompt tokens only come from provider response usage', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const running = start(store, runIds, turn, 'usage', [item('large', 'system', 'x'.repeat(25_000))]);
  assert.equal(running.actualPromptTokens, undefined); store.completeRequest(response('usage', 13_000));
  assert.equal(store.getStep(running.stepId)?.actualPromptTokens, 13_000);
});

test('estimated and actual values remain independent', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const running = start(store, runIds, turn, 'gap', [item('estimate', 'system', 'x'.repeat(25_000))]);
  const estimated = running.snapshot.estimatedPromptTokens; store.completeRequest(response('gap', 13_000)); const complete = store.getStep(running.stepId)!;
  assert.equal(estimated, 10_000); assert.equal(complete.actualPromptTokens, 13_000); assert.equal(complete.snapshot.estimatedPromptTokens, 10_000);
});

test('context window is attached to current snapshot and excludes completion', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const step = start(store, runIds, turn, 'window', [item('s', 'system', 'x')], { contextWindow: 1_000_000 }); store.completeRequest(response('window', 203_700, 700));
  const saved = store.getStep(step.stepId)!; assert.equal(saved.snapshot.contextWindow, 1_000_000); assert.equal(Math.round((saved.actualPromptTokens! / saved.snapshot.contextWindow!) * 100), 20);
});

test('historical snapshots are immutable after later context changes', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const draft = item('stable', 'user_message', 'before'); const first = start(store, runIds, turn, 'immutable-1', [draft]); draft.content = 'after'; start(store, runIds, turn, 'immutable-2', [draft]);
  assert.equal(store.getStep(first.stepId)?.snapshot.items[0].content, 'before');
});

test('stable item IDs drive added removed and modified Diff', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  start(store, runIds, turn, 'diff-1', [item('keep', 'user_message', 'old'), item('remove', 'user_message', 'gone')]);
  const second = start(store, runIds, turn, 'diff-2', [item('keep', 'user_message', 'changed'), item('add', 'user_message', 'new')]);
  const diff = second.diff.categories.user_message; assert.deepEqual(diff.addedItemIds, ['add']); assert.deepEqual(diff.removedItemIds, ['remove']); assert.deepEqual(diff.modifiedItemIds, ['keep']);
});

test('pruning and compression remain separate events', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  start(store, runIds, turn, 'prune', [item('s', 'system', 'x')], { prune: true });
  store.recordCompression({ sessionId: runIds.sessionId, agentId: 'master', runId: runIds.runId, turnIndex: turn.turnIndex, beforeEstimatedTokens: 100, afterEstimatedTokens: 20, removedItemIds: ['old'], addedItemIds: ['summary'], timestamp: new Date().toISOString() });
  const stats = store.getOverview(runIds.conversationId, runIds.sessionId).agents[0].stats; assert.equal(stats.pruningCount, 1); assert.equal(stats.compressionCount, 1);
});

test('master and child Agent context timelines remain isolated after fork', () => {
  const store = new ContextObservabilityStore(); const masterIds = ids('run_master'); const masterTurn = store.registerRun(masterIds, new Date().toISOString()); const master = start(store, masterIds, masterTurn, 'master', [item('m', 'system', 'master')]);
  const childIds = { ...ids('run_child'), sessionId: masterIds.sessionId, conversationId: masterIds.conversationId }; const childTurn = store.registerRun(childIds, new Date().toISOString(), 'child', { parentAgentId: 'master', forkStepId: master.stepId }); start(store, childIds, childTurn, 'child', [item('c', 'system', 'child')], { agentId: 'child' });
  const agents = store.getOverview(masterIds.conversationId, masterIds.sessionId).agents; assert.equal(agents.length, 2); assert.equal(agents.find((agent) => agent.agentId === 'master')?.stats.stepCount, 1); assert.equal(agents.find((agent) => agent.agentId === 'child')?.parentAgentId, 'master');
});

test('cache hit rate uses provider cache token usage', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString()); start(store, runIds, turn, 'cache', [item('s', 'system', 'x')]); store.completeRequest(response('cache', 100_000, 10, 98_000));
  assert.equal(store.getOverview(runIds.conversationId, runIds.sessionId).agents[0].stats.cacheHitRate, .98);
});

test('cost uses actual provider usage and configured cached-input pricing', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString());
  const step = start(store, runIds, turn, 'cost', [item('s', 'system', 'x')], { pricing: { currency: 'CNY', inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 2 } });
  store.completeRequest(response('cost', 100_000, 10_000, 80_000));
  const complete = store.getStep(step.stepId)!;
  assert.equal(complete.estimatedCost, .56); assert.equal(complete.costCurrency, 'CNY');
});

test('duplicate request and response callbacks are idempotent', () => {
  const store = new ContextObservabilityStore(); const runIds = ids(); const turn = store.registerRun(runIds, new Date().toISOString()); const first = start(store, runIds, turn, 'same', [item('s', 'system', 'x')]); const duplicate = start(store, runIds, turn, 'same', [item('s', 'system', 'x')]); store.completeRequest(response('same', 100, 10)); store.completeRequest(response('same', 999, 999));
  const view = store.getOverview(runIds.conversationId, runIds.sessionId); assert.equal(first.stepId, duplicate.stepId); assert.equal(view.agents[0].stats.stepCount, 1); assert.equal(store.getStep(first.stepId)?.actualPromptTokens, 100);
});
