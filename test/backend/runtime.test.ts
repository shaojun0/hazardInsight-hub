/** Agent Runtime 核心回归：显式阶段、fallback、cache 与兼容结果。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AgentStreamEvent } from '../../shared/agent-protocol.js';
import type { ImagePayload, ModelCallOptions, ModelCallResult, MultimodalModelProvider, StreamingModelCallOptions } from '../../server/providers/types.js';
import { normalizeOpenAICompatibleUsage } from '../../server/providers/token-usage.js';
import { createRetriever } from '../../server/retrieval/index.js';
import { AgentRuntime } from '../../server/agent/runtime.js';
import { createAgentRoutes } from '../../server/http/agent.routes.js';
import { createAnalysisRoutes } from '../../server/http/analysis.routes.js';
import { clampBBox } from '../../server/lib/schema.js';
import { parseRulesText } from '../../server/rules/parser.js';
import { AgentContextBuilder } from '../../server/agent/context/context-builder.js';
import { TestProvider } from './helpers.js';

const TEST_IMAGE = Buffer.from('agent-runtime-test-image');

async function testRun(runtime: AgentRuntime, scenario: string, provider: MultimodalModelProvider = new TestProvider(scenario)) {
  const events: AgentStreamEvent[] = [];
  const result = await runtime.runHazardAnalysis({
    buffer: TEST_IMAGE,
    mimeType: 'image/png',
    scenario,
    providerOverride: provider,
    onEvent: (event) => events.push(event),
  });
  return { result, events };
}

test('desk workflow produces compatible result and all explicit stages', async () => {
  const { result, events } = await testRun(new AgentRuntime(createRetriever()), 'desk');
  assert.equal(result.hazards.length, 3);
  assert.deepEqual(result.hazards.map((item) => item.grade), ['B', 'C', 'D']);
  assert.ok(result.agentMeta?.runId.startsWith('run_'));
  assert.ok(result.analysisId.startsWith('HAZ-'));
  assert.equal(result.agentMeta?.fallbackUsed, false);
  assert.deepEqual(
    events.filter((event) => event.type === 'step.completed').map((event) => event.uiStage),
    ['preflight', 'vision', 'retrieval', 'rules', 'context', 'reasoning', 'validation', 'assemble']
  );
  assert.equal(events.at(0)?.type, 'run.started');
  assert.equal(events.at(-1)?.type, 'run.completed');
  assert.equal(events.filter((event) => event.type === 'result.completed').length, 1);
  const modelCompletion = events.find((event) => {
    if (event.type !== 'tool.completed') return false;
    return (event.payload as { name?: string }).name === 'model.vision';
  });
  assert.equal((modelCompletion?.payload as { providerAttempts?: number }).providerAttempts, 1);
  assert.ok(((modelCompletion?.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0) > 0);
});

test('output guardrails keep bbox in bounds and preserve rule taxonomy semantics', () => {
  const bbox = clampBBox({ x: 0.99, y: 0.995, width: 0.001, height: 0.001 });
  assert.ok(bbox.x + bbox.width <= 1);
  assert.ok(bbox.y + bbox.height <= 1);
  assert.ok(bbox.width >= 0.02 && bbox.height >= 0.02);

  const parsed = parseRulesText('b 现场作业 隧道作业 BSD07*未及时维护盾尾密封装置');
  assert.equal(parsed[0]?.level, 'b');
  assert.equal(parsed[0]?.starred, true);
  assert.equal('grade' in parsed[0], false);
});

test('provider usage normalization treats cached tokens as an input subset', () => {
  const usage = normalizeOpenAICompatibleUsage({
    prompt_tokens: 8_000,
    completion_tokens: 500,
    total_tokens: 8_500,
    prompt_tokens_details: { cached_tokens: 5_000 },
  });
  assert.equal(usage.inputTokens, 8_000);
  assert.equal(usage.outputTokens, 500);
  assert.equal(usage.cachedTokens, 5_000);
  assert.equal(usage.totalTokens, 8_500);
  assert.equal(usage.cachedTokensAreInputSubset, true);
  assert.equal(normalizeOpenAICompatibleUsage({ prompt_tokens: 100, completion_tokens: 10 }).cachedTokensAvailable, false);
});

test('context builder deterministically trims evidence to its token budget', () => {
  const builder = new AgentContextBuilder();
  const repeated = Array.from({ length: 12 }, (_, index) => ({
    key: `H0-S${index}`,
    doc: `标准${index}`,
    code: `STD-${index}`,
    clause: `${index + 1}`,
    title: '测试条款',
    content: '临时用电安全要求'.repeat(300),
  }));
  const prompt = builder.reasoningPrompt({
    perHazard: [{
      ref: 'H0',
      category: '临时用电',
      title: '插排过载',
      description: '同一插排连接多个设备。',
      confidence: 0.9,
      evidence: ['多个设备连接同一插排'],
      possibleConsequence: '线路发热或短路。',
      standards: repeated,
      cases: [],
      rules: [],
    }],
  }, { modelName: 'test', ruleSetVersion: 'rules-v1', tokenBudget: 3_500 });
  assert.ok(prompt.dropped.length > 0);
  assert.ok(prompt.estimatedTokens <= 3_500);
});

test('clean workflow skips retrieval work but preserves observable state machine', async () => {
  const { result, events } = await testRun(new AgentRuntime(createRetriever()), 'clean');
  assert.equal(result.hazards.length, 0);
  assert.equal(result.overallRisk, null);
  assert.equal(result.needManualReview, false);
  const completed = events.filter((event) => event.type === 'step.completed');
  assert.equal(completed.length, 8);
  assert.equal(events.some((event) => event.type === 'retrieval.completed'), false);
});

test('reasoning failure completes with explicit fallback and provisional review', async () => {
  const { result, events } = await testRun(new AgentRuntime(createRetriever()), 'desk', new BrokenReasoningProvider());
  assert.equal(result.hazards.length, 3);
  assert.equal(result.agentMeta?.fallbackUsed, true);
  assert.equal(events.some((event) => event.type === 'run.fallback'), true);
  assert.equal(result.needManualReview, true);
  assert.ok(result.hazards.every(h=>h.manualReviewRequired && h.gradingTrace?.status==='provisional'));
  assert.equal(events.at(-1)?.type, 'run.completed');
});

test('retrieval and static context caches are reused across runs', async () => {
  const runtime = new AgentRuntime(createRetriever());
  await testRun(runtime, 'desk');
  const second = await testRun(runtime, 'desk');
  assert.ok(second.events.some((event) => event.type === 'cache.hit'));
  assert.ok((second.result.agentMeta?.cache.hits ?? 0) > 0);
});

test('LLM calls remain independently traceable and aggregate across run/session/conversation', async () => {
  const runtime = new AgentRuntime(createRetriever());
  const identity = { conversationId: 'conv_token_test', sessionId: 'sess_token_test', taskId: 'task_token_test' };
  const first = await runtime.runHazardAnalysis({
    buffer: TEST_IMAGE,
    mimeType: 'image/png',
    scenario: 'desk',
    providerOverride: new UsageProvider(new TestProvider('desk')),
    ...identity,
  });
  const run = runtime.getRunTokenUsage(first.agentMeta?.runId ?? '');
  assert.ok(run);
  assert.equal(run.llmCallCount, 3);
  assert.equal(run.inputTokens, 17_420);
  assert.equal(run.outputTokens, 520);
  assert.equal(run.cachedTokens, 13_500);
  assert.equal(run.totalTokens, 17_940);
  assert.equal(run.calls[0]?.sequence, 1);
  assert.equal(run.calls[0]?.phase, 'vision_analysis');
  assert.equal(run.calls[1]?.phase, 'reasoning');
  assert.equal(run.calls[2]?.phase, 'final_answer');
  assert.ok(run.calls.every((call) => call.stepId?.startsWith('step_')));

  await runtime.runHazardAnalysis({
    buffer: TEST_IMAGE,
    mimeType: 'image/png',
    scenario: 'clean',
    providerOverride: new UsageProvider(new TestProvider('clean')),
    ...identity,
  });
  const overview = runtime.getTokenUsageOverview(identity.conversationId, identity.sessionId);
  assert.equal(overview.session.runs.length, 2);
  assert.equal(overview.session.llmCallCount, 5);
  assert.equal(overview.conversation.llmCallCount, 5);
  assert.equal(overview.session.totalTokens, 26_600);
});

test('SSE HTTP endpoint streams events and exposes run snapshot', async () => {
  const runtime = new AgentRuntime(createRetriever());
  const originalRun = runtime.runHazardAnalysis.bind(runtime);
  runtime.runHazardAnalysis = (input) => originalRun({ ...input, providerOverride: new TestProvider(input.scenario ?? 'desk') });
  const app = express();
  app.use('/api', createAgentRoutes(runtime));
  app.use('/api', createAnalysisRoutes(runtime));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const form = new FormData();
    form.append('image', new Blob([TEST_IMAGE], { type: 'image/png' }), 'test.png');
    form.append('scenario', 'desk');
    const response = await fetch(`${baseUrl}/api/agent/runs/stream`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const streamText = await response.text();
    assert.match(streamText, /event: run\.started/);
    assert.match(streamText, /event: result\.completed/);
    assert.match(streamText, /event: run\.completed/);
    const dataEvents = streamText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as AgentStreamEvent);
    const runId = dataEvents[0]?.runId;
    assert.ok(runId?.startsWith('run_'));
    const detail = await fetch(`${baseUrl}/api/agent/runs/${runId}`).then((res) => res.json()) as {
      data: {
        status: string;
        result?: { hazards: unknown[]; agentMeta?: { conversationId: string; sessionId: string } };
      };
    };
    assert.equal(detail.data.status, 'completed');
    assert.equal(detail.data.result?.hazards.length, 3);

    const legacyForm = new FormData();
    legacyForm.append('image', new Blob([TEST_IMAGE], { type: 'image/png' }), 'test.png');
    legacyForm.append('scenario', 'clean');
    const legacyResponse = await fetch(`${baseUrl}/api/analyze`, { method: 'POST', body: legacyForm });
    assert.equal(legacyResponse.status, 200);
    const legacy = await legacyResponse.json() as {
      ok: boolean;
      runId?: string;
      data: { hazards: unknown[]; agentMeta?: { runId: string } };
    };
    assert.equal(legacy.ok, true);
    assert.equal(legacy.data.hazards.length, 0);
    assert.equal(legacy.runId, legacy.data.agentMeta?.runId);

    const overviewResponse = await fetch(
      `${baseUrl}/api/agent/token-usage?conversationId=${detail.data.result?.agentMeta?.conversationId ?? ''}&sessionId=${detail.data.result?.agentMeta?.sessionId ?? ''}`
    );
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json() as { data: { latestRun: { llmCallCount: number } } };
    assert.equal(overview.data.latestRun.llmCallCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

class BrokenReasoningProvider implements MultimodalModelProvider {
  readonly providerId = 'test';
  readonly name = 'broken-reasoning-test';
  private readonly visionDelegate = new TestProvider('desk');

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async vision(text: string, image: ImagePayload, options?: ModelCallOptions): Promise<ModelCallResult> {
    return this.visionDelegate.vision(text, image, options);
  }

  async visionStream(text: string, image: ImagePayload, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    return this.visionDelegate.visionStream(text, image, options);
  }

  async chat(): Promise<ModelCallResult> {
    throw new Error('forced reasoning failure');
  }

  async chatStream(system: string, user: string, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    if (system.includes('只输出严格 JSON')) throw new Error('forced reasoning failure');
    return this.visionDelegate.chatStream(system, user, options);
  }
}

class UsageProvider implements MultimodalModelProvider {
  readonly providerId = 'openai-compatible-test';
  readonly name = 'usage-test-model';
  private readonly visionDelegate: MultimodalModelProvider;

  constructor(delegate: MultimodalModelProvider) {
    this.visionDelegate = delegate;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async vision(text: string, image: ImagePayload, options?: ModelCallOptions): Promise<ModelCallResult> {
    const result = await this.visionDelegate.vision(text, image, options);
    return {
      ...result,
      usage: normalizeOpenAICompatibleUsage({
        prompt_tokens: 8_200,
        completion_tokens: 320,
        total_tokens: 8_520,
        prompt_tokens_details: { cached_tokens: 6_000 },
      }),
    };
  }

  async visionStream(text: string, image: ImagePayload, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    const result = await this.vision(text, image, options);
    options.onTextDelta(result.text);
    return result;
  }

  async chat(): Promise<ModelCallResult> {
    const hazards = [
      { ref: 'H0', grade: 'B', severityScore: 4, probabilityScore: 3 },
      { ref: 'H1', grade: 'C', severityScore: 3, probabilityScore: 2 },
      { ref: 'H2', grade: 'D', severityScore: 2, probabilityScore: 1 },
    ].map((item) => ({
      ...item,
      gradeReason: '测试定级理由',
      standardRefs: [],
      caseRefs: [],
      ruleRefs: [],
      rectification: [
        { kind: 'immediate', text: '立即隔离风险区域。' },
        { kind: 'corrective', text: '组织专业人员完成整改。' },
      ],
      manualReviewRequired: false,
    }));
    return {
      text: JSON.stringify({ needManualReview: false, hazards }),
      attempts: 1,
      usage: normalizeOpenAICompatibleUsage({
        prompt_tokens: 9_100,
        completion_tokens: 180,
        total_tokens: 9_280,
        prompt_tokens_details: { cached_tokens: 7_500 },
      }),
      finishReason: 'stop',
    };
  }

  async chatStream(system: string, _user: string, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    if (system.includes('只输出严格 JSON')) {
      const result = await this.chat();
      options.onTextDelta(result.text);
      return result;
    }
    const text = '已完成公开业务摘要。';
    options.onTextDelta(text);
    return {
      text,
      attempts: 1,
      usage: normalizeOpenAICompatibleUsage({ prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 }),
      finishReason: 'stop',
    };
  }
}
