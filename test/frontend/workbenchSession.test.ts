import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentStreamEvent, AgentEventType, AgentUiStage } from '../../shared/agent-protocol.js';
import type { AnalysisResult, Hazard, StandardReference } from '../../shared/types.js';
import { applyAgentEvent, clearWorkbench, deleteWorkbenchHazard, emptyRunView, getWorkbenchSnapshot, restoreWorkbench } from '../../web/lib/workbenchSession.js';
import { loadLastResult, saveLastResult } from '../../web/lib/storage.js';

function event(sequence: number, type: AgentEventType, payload: unknown, uiStage?: AgentUiStage): AgentStreamEvent {
  return {
    protocolVersion: '1.0',
    eventId: `evt_${sequence}`,
    sequence,
    type,
    timestamp: `2026-08-26T02:00:${String(sequence).padStart(2, '0')}.000Z`,
    traceId: 'trace_test',
    runId: 'run_test',
    taskId: 'task_test',
    uiStage,
    payload,
  };
}

test('deleting a hazard preserves other IDs, edits and boxes, persists the image and handles the final deletion', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  try {
    const reference: StandardReference = {
      type: 'general', documentName: '测试标准', documentCode: 'TEST', version: '1', clause: '1',
      clauseTitle: '测试条款', content: '测试', category: '测试', relevance: 1, reason: '测试',
    };
    const hazards: Hazard[] = [1, 2, 3].map((index) => ({
      id: `hazard-${index}`, index, title: `人工修订 ${index}`, category: '测试', description: '已修订描述',
      confidence: 0.9, bbox: { x: index / 10, y: 0.2, width: 0.1, height: 0.3 }, evidence: ['证据'],
      possibleConsequence: '测试', grade: index === 2 ? 'A' : 'C', gradeReason: '测试',
      severityScore: 3, probabilityScore: 2, riskScore: 6,
      standardReferences: [reference, { ...reference, clause: String(index) }],
      historicalReferences: [], rectification: [{ kind: 'corrective', text: '已修订措施' }],
      manualReviewRequired: false,
    }));
    const result: AnalysisResult = {
      analysisId: 'delete-test', imageSummary: '测试现场', overallRisk: 'A', needManualReview: true,
      hazards, stats: { standardsCited: 3, casesCited: 0 }, mode: 'ai', modelName: 'test',
      disclaimer: '测试', createdAt: '2026-09-09T00:00:00Z',
    };
    const image = { dataUrl: 'data:image/png;base64,test', name: 'test.png' };
    saveLastResult(result, image, 'sample');
    restoreWorkbench();
    const before = getWorkbenchSnapshot();

    deleteWorkbenchHazard('missing');
    assert.equal(getWorkbenchSnapshot(), before);
    deleteWorkbenchHazard('hazard-2');
    const after = getWorkbenchSnapshot();
    assert.deepEqual(after.result?.hazards.map((hazard) => hazard.index), [1, 3]);
    assert.equal(after.result?.hazards[0], before.result?.hazards[0]);
    assert.equal(after.result?.hazards[1], before.result?.hazards[2]);
    assert.equal(after.result?.overallRisk, 'C');
    assert.equal(after.result?.needManualReview, true, '保留分析级复核要求');
    assert.equal(after.result?.stats.standardsCited, 2, '只统计剩余隐患的去重引用');
    assert.equal(after.phase, 'done');
    assert.deepEqual(loadLastResult()?.analysis, after.result);
    assert.deepEqual(loadLastResult()?.image, image, '从已保存结果恢复后删除仍保留图片');
    assert.equal(loadLastResult()?.scenario, 'sample');

    deleteWorkbenchHazard('hazard-1');
    deleteWorkbenchHazard('hazard-3');
    assert.equal(getWorkbenchSnapshot().phase, 'empty');
    assert.deepEqual(getWorkbenchSnapshot().result?.hazards, []);
    assert.equal(getWorkbenchSnapshot().result?.overallRisk, null);
    assert.deepEqual(getWorkbenchSnapshot().result?.stats, { standardsCited: 0, casesCited: 0 });
    assert.deepEqual(loadLastResult()?.analysis.hazards, []);
    assert.equal(getWorkbenchSnapshot().previewUrl, image.dataUrl);
  } finally {
    clearWorkbench();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('workbench stream reducer produces the same idempotent business view from ordered events', () => {
  const result: AnalysisResult = {
    analysisId: 'analysis_test',
    imageSummary: '钢筋施工区域',
    overallRisk: 'B',
    needManualReview: false,
    hazards: [{
      id: 'H001', index: 1, title: '高处作业防护不足', category: '高处作业', description: 'test', confidence: 0.86,
      bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, evidence: ['test'], possibleConsequence: 'test', grade: 'B',
      gradeReason: 'test', severityScore: 4, probabilityScore: 3, riskScore: 12, standardReferences: [], historicalReferences: [],
      ruleReferences: [], rectification: [{ kind: 'immediate', text: '隔离作业区域' }], manualReviewRequired: false,
    }],
    stats: { standardsCited: 0, casesCited: 0 },
    mode: 'ai', modelName: 'deepseek-test', disclaimer: 'test', createdAt: '2026-08-26T02:00:00.000Z',
  };
  const events = [
    event(1, 'run.started', { config: { model: 'deepseek-test' } }),
    event(2, 'step.started', { step: 'vision' }, 'vision'),
    event(3, 'step.completed', { business: { scenes: ['高处作业'], candidateCount: 1, maxConfidence: 0.86 } }, 'vision'),
    event(4, 'step.completed', { business: { matchedRules: 5 } }, 'rules'),
    event(5, 'analysis.output.started', { channel: 'public_summary' }, 'assemble'),
    event(6, 'analysis.output.delta', { channel: 'public_summary', delta: '公开摘要', chunkIndex: 0 }, 'assemble'),
    event(7, 'analysis.output.completed', { channel: 'public_summary', textLength: 4 }, 'assemble'),
    event(8, 'result.completed', { data: result }, 'assemble'),
  ];
  let view = emptyRunView();
  for (const item of events) view = applyAgentEvent(view, item);
  const logCount = view.logs.length;
  view = applyAgentEvent(view, events[events.length - 1]);

  assert.equal(view.status, 'completed');
  assert.equal(view.progress, 100);
  assert.equal(view.completedStages.length, 8);
  assert.equal(view.modelName, 'deepseek-test');
  assert.deepEqual(view.summary.scenes, ['高处作业']);
  assert.equal(view.summary.currentGrade, 'B');
  assert.equal(view.summary.confidence, 0.86);
  assert.equal(view.summary.ruleHits, 5);
  assert.equal(view.publicOutput.text, '公开摘要');
  assert.equal(view.publicOutput.status, 'completed');
  assert.equal(view.logs.length, logCount, '重复 sequence 不应生成重复日志');
});

test('workbench stream reducer keeps formal completion when public summary is interrupted', () => {
  let view = emptyRunView();
  view = applyAgentEvent(view, event(1, 'analysis.output.started', { channel: 'public_summary' }, 'assemble'));
  view = applyAgentEvent(view, event(2, 'analysis.output.delta', { channel: 'public_summary', delta: '部分内容', chunkIndex: 0 }, 'assemble'));
  view = applyAgentEvent(view, event(3, 'analysis.output.failed', { channel: 'public_summary', message: 'stream interrupted' }, 'assemble'));

  assert.equal(view.publicOutput.text, '部分内容');
  assert.equal(view.publicOutput.status, 'interrupted');
  assert.equal(view.logs.at(-1)?.tone, 'warning');
});

test('workbench stream reducer keeps independent streamed output for every model phase', () => {
  let view = emptyRunView();
  view = applyAgentEvent(view, event(1, 'analysis.output.started', { channel: 'vision', label: '图像识别模型输出', model: 'test' }, 'vision'));
  view = applyAgentEvent(view, event(2, 'analysis.output.delta', { channel: 'vision', delta: '{"candidates":', chunkIndex: 0 }, 'vision'));
  view = applyAgentEvent(view, event(3, 'analysis.output.delta', { channel: 'vision', delta: '[]}', chunkIndex: 1 }, 'vision'));
  view = applyAgentEvent(view, event(4, 'analysis.output.completed', { channel: 'vision', textLength: 17 }, 'vision'));
  view = applyAgentEvent(view, event(5, 'analysis.output.started', { channel: 'reasoning', label: '风险推理模型输出', model: 'test' }, 'reasoning'));
  view = applyAgentEvent(view, event(6, 'analysis.output.delta', { channel: 'reasoning', delta: '推理结果', chunkIndex: 0 }, 'reasoning'));
  view = applyAgentEvent(view, event(7, 'analysis.output.failed', { channel: 'reasoning', message: 'stream interrupted' }, 'reasoning'));

  assert.equal(view.modelOutputs.length, 2);
  assert.equal(view.modelOutputs[0]?.text, '{"candidates":[]}');
  assert.equal(view.modelOutputs[0]?.status, 'completed');
  assert.equal(view.modelOutputs[1]?.text, '推理结果');
  assert.equal(view.modelOutputs[1]?.status, 'interrupted');
  assert.equal(view.publicOutput.status, 'idle');
});
