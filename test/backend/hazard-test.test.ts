import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { createHazardTestRoutes } from '../../server/http/hazard-test.routes.js';
import { parseTestDataset, readDefaultTestDataset, testCandidateOf } from '../../server/testing/dataset.js';
import { HazardTestService, calculateTestStats, compareTestRow, exportTestErrors } from '../../server/testing/service.js';
import type { HazardTestJob, HazardTestRow } from '../../shared/hazard-test.js';
import type { AnalysisResult } from '../../shared/types.js';
import { AgentRuntime } from '../../server/agent/runtime.js';
import { createRetriever } from '../../server/retrieval/index.js';
import { TestProvider } from './helpers.js';
import type { StreamingModelCallOptions } from '../../server/providers/types.js';

const csv = (body: string) => parseTestDataset(Buffer.from(body), '测试.csv');
const minimal = () => csv('隐患描述,隐患级别\n高处防护缺失,B级\n通道堆物,C级\n标识缺失,\n设备问题,D级');
const result = (grade: 'A' | 'B' | 'C' | 'D', fallback = false) => ({
  hazards: [{ grade }], agentMeta: { fallbackUsed: fallback, fallbackReason: fallback ? '模型输出无效' : undefined },
}) as AnalysisResult;
async function finished(job: HazardTestJob) {
  for (let i = 0; i < 1000 && (job.status === 'running' || job.status === 'stopping'); i += 1) await delay(5);
  assert.ok(job.status === 'completed' || job.status === 'stopped', '任务应结束');
}

test('真实默认集：29 字段、50 条，B10/C20/D20，保留多行描述和图片追踪', async () => {
  const dataset = await readDefaultTestDataset();
  assert.equal(dataset.metadata.total, 50);
  assert.equal(dataset.metadata.headers.length, 29);
  assert.deepEqual(dataset.metadata.gradeCounts, { A: 0, B: 10, C: 20, D: 20 });
  assert.ok(dataset.records[0]['隐患描述'].includes('\n'));
  assert.ok(dataset.records[0]['图片文件']);
});

test('CSV 兼容 BOM、引号、逗号、多行、全角等级；缺失答案不丢失记录', () => {
  const dataset = csv('\uFEFF隐患描述,隐患级别,隐患分类\r\n"第一行,\n第二行""引用""",ｂ级,用电\r\n其他问题,,');
  assert.equal(dataset.records[0]['隐患描述'], '第一行,\n第二行"引用"');
  assert.equal(dataset.metadata.gradeCounts.B, 1);
  assert.equal(dataset.metadata.labeled, 1);
  assert.match(dataset.metadata.warnings[0], /无标准答案/);
});

test('CSV 输入错误给出明确提示，不接受坏等级、空描述或错误列数', () => {
  for (const [input, message] of [
    ['', /文件为空/], ['描述,等级\nx,B', /缺少必要字段/], ['隐患描述,隐患级别', /没有数据行/],
    ['隐患描述,隐患级别\nx,Z级', /级别.*无效/], ['隐患描述,隐患级别\n,B', /缺少隐患描述/],
    ['隐患描述,隐患级别\nx,B,extra', /列数/], ['隐患描述,隐患级别\n"x,B', /引号未闭合/],
    ['隐患描述,隐患级别\n"x"bad,B', /引号结束/], ['隐患描述,隐患级别\nx"bad",B', /引号位置/],
    ['隐患描述,隐患描述,隐患级别\nx,y,B', /重复列名/],
  ] as const) assert.throws(() => csv(input), message);
  assert.throws(() => parseTestDataset(Buffer.from('fake excel'), 'test.xlsx'), /仅支持 CSV/);
  assert.throws(() => parseTestDataset(Buffer.alloc(5 * 1024 * 1024 + 1), 'test.csv'), /5MB/);
  assert.throws(() => csv('隐患描述,隐患级别\n' + 'x,B\n'.repeat(501)), /500/);
});

test('只传真实描述和分类，移除显式等级；保留 B 级作业票事实', () => {
  const candidate = testCandidateOf({ '隐患描述': '判定为B级隐患，未办理B级风险作业票', '隐患分类': '用电', '隐患级别': 'B', 'A/B级判定标准': 'SECRET', '整改责任人': 'PRIVATE' });
  assert.deepEqual(Object.keys(candidate), ['description', 'category']);
  assert.equal(candidate.description, ',未办理B级风险作业票');
  assert.ok(!JSON.stringify(candidate).includes('SECRET'));
});

test('分母排除无标签、失败、未完成；各等级比较和总体完全一致分开计算', () => {
  const row = (expected: HazardTestRow['expected'], actual: NonNullable<HazardTestRow['actual']>): HazardTestRow => {
    const value: HazardTestRow = { index: 1, sourceData: {}, expected, actual: null, status: 'success', agentRawOutput: '', differences: [], accuracy: { A: null, B: null, C: null, D: null, overall: null } };
    compareTestRow(value, actual); return value;
  };
  const wrong = row('B', 'C');
  assert.deepEqual(wrong.accuracy, { A: true, B: false, C: false, D: true, overall: false });
  assert.deepEqual(wrong.differences, ['B', 'C']);
  const stats = calculateTestStats([row('B', 'B'), wrong, row(null, 'D'), { ...row('C', 'C'), status: 'failed' }, { ...row('D', 'D'), status: 'pending' }]);
  assert.deepEqual(stats.overall, { correct: 1, valid: 2, percent: 50 });
  assert.equal(stats.byGrade.A.percent, 100);
  assert.equal(stats.recall.A.percent, null);
  assert.equal(stats.recall.B.percent, 50);
  assert.equal(stats.unscored, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.completed, 4);
  assert.equal(calculateTestStats([]).overall.percent, null);
});

test('单条失败/兜底不中断任务、重复开始不重复调用、错误导出可追踪', async () => {
  let calls = 0;
  const service = new HazardTestService({ runHazardAnalysis: async () => {
    calls += 1; await delay(5);
    if (calls === 2) throw new Error('连接超时');
    return result('B', calls === 4);
  } });
  const dataset = service.addDataset('owner', minimal());
  const job = service.start('owner', dataset.id);
  assert.equal(service.start('owner', dataset.id).id, job.id);
  assert.throws(() => service.getJob('other', job.id), /不存在/);
  await finished(job);
  assert.equal(calls, 4);
  assert.deepEqual(job.rows.map(r => r.status), ['success', 'failed', 'success', 'failed']);
  assert.equal(job.stats.overall.percent, 100);
  assert.equal(job.stats.overall.valid, 1);
  assert.equal(job.rows[3].actual, null);
  assert.match(exportTestErrors(job), /连接超时/);
  assert.match(exportTestErrors(job), /模型输出无效/);
  assert.equal(service.latest('owner')?.id, job.id);
});

test('停止测试等待当前项结束，后续项不执行', async () => {
  let calls = 0;
  const service = new HazardTestService({ runHazardAnalysis: async () => { calls += 1; await delay(20); return result('B'); } });
  const dataset = service.addDataset('owner', minimal());
  const job = service.start('owner', dataset.id);
  service.stop('owner', job.id);
  await finished(job);
  assert.equal(job.status, 'stopped');
  assert.equal(job.stats.completed, 1);
  assert.equal(calls, 1);
  assert.equal(job.rows[1].status, 'pending');
});

class TextProvider extends TestProvider {
  requests: string[] = [];
  reasoningBudgets: Array<number | undefined> = [];
  constructor() { super('desk'); }
  override async visionStream(): Promise<never> { throw new Error('文本测试不能调用视觉接口'); }
  override async chatStream(system: string, user: string, options: StreamingModelCallOptions) {
    this.requests.push(user);
    if (system.includes('只输出严格 JSON')) {
      this.reasoningBudgets.push(options.maxTokens);
      const response = await this.chat();
      const parsed = JSON.parse(response.text);
      parsed.hazards = [parsed.hazards[0]];
      // 超过原 UI 6000 字符限制，验证评测原文仍完整保存。
      const text = JSON.stringify(parsed) + ' '.repeat(6500);
      options.onTextDelta(text);
      return { ...response, text };
    }
    return super.chatStream(system, user, options);
  }
}

test('默认 50 条通过真实 Agent Runtime/检索/定级护栏执行，Provider 注入，原文完整保存', async () => {
  const provider = new TextProvider();
  const runtime = new AgentRuntime(createRetriever());
  const service = new HazardTestService({ runHazardAnalysis: input => runtime.runHazardAnalysis({ ...input, providerOverride: provider }) });
  const dataset = service.addDataset('test', await readDefaultTestDataset());
  const job = service.start('test', dataset.id, { concurrency: 4, maxOutputTokens: 12000 });
  await finished(job);
  assert.equal(job.stats.total, 50);
  assert.equal(job.stats.completed, 50);
  assert.equal(job.stats.failed, 0);
  assert.deepEqual(job.options, { concurrency: 4, maxOutputTokens: 12000 });
  assert.equal(provider.reasoningBudgets.length, 50);
  assert.ok(provider.reasoningBudgets.every(value => value === 12000));
  assert.equal(job.stats.overall.percent, 20);
  assert.ok(job.rows.every(r => r.runId && r.analysis?.agentMeta?.tokenUsage));
  assert.ok(job.rows[0].agentRawOutput.length > 6000);
  assert.equal(JSON.parse(job.rows[0].agentRawOutput).hazards.length, 1);
  assert.equal(runtime.getRun(job.rows[0].runId!)?.workflowType, 'text_hazard_analysis');
});

test('HTTP 默认集、上传、校验错误、启动、进度、详情、导出、任务隔离', async () => {
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.locals.authUser = { id: _req.headers['x-test-user'] ?? 'one' }; next(); });
  app.use('/api', createHazardTestRoutes({ runHazardAnalysis: async () => { await delay(5); return result('D'); } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/hazard-tests`;
  try {
    const defaults = await (await fetch(`${base}/datasets/default`)).json() as { data: { total: number } };
    assert.equal(defaults.data.total, 50);
    const bad = new FormData(); bad.append('file', new Blob(['描述,等级\nx,B']), 'bad.csv');
    const badResponse = await fetch(`${base}/datasets`, { method: 'POST', body: bad });
    assert.equal(badResponse.status, 400);
    assert.match((await badResponse.json() as { error: string }).error, /缺少必要字段/);
    const form = new FormData(); form.append('file', new Blob(['隐患描述,隐患级别\n"=危险公式",B级']), '自定义.csv');
    const uploaded = await (await fetch(`${base}/datasets`, { method: 'POST', body: form })).json() as { data: { id: string; fileName: string } };
    assert.equal(uploaded.data.fileName, '自定义.csv');
    for (const concurrency of [0, 17, 1.5, '4', null]) {
      const invalid = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: uploaded.data.id, concurrency }) });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json() as { error: string }).error, /并发数/);
    }
    const badBudget = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: uploaded.data.id, maxOutputTokens: 32001 }) });
    assert.equal(badBudget.status, 400);
    const response = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId: uploaded.data.id }) });
    assert.equal(response.status, 200);
    const { data: job } = await response.json() as { data: HazardTestJob };
    assert.deepEqual(job.options, { concurrency: 1, maxOutputTokens: 6400 });
    assert.equal((await fetch(`${base}/jobs/${job.id}`, { headers: { 'x-test-user': 'two' } })).status, 404);
    let snapshot = job;
    while (snapshot.status === 'running') { await delay(10); snapshot = (await (await fetch(`${base}/jobs/${job.id}`)).json() as { data: HazardTestJob }).data; }
    assert.equal(snapshot.stats.incorrect, 1);
    assert.deepEqual(snapshot.rows[0].differences, ['B', 'D']);
    const exported = await fetch(`${base}/jobs/${job.id}/errors.csv`);
    assert.match(exported.headers.get('content-type')!, /text\/csv/);
    assert.match(await exported.text(), /'=危险公式/);
    assert.equal((await fetch(`${base}/jobs/missing`)).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('并发 worker 按上限调度，乱序完成和单条失败不丢项、不重复执行', async () => {
  const pending: Array<{ resolve: (result: AnalysisResult) => void; reject: (error: Error) => void }> = [];
  const descriptions: string[] = [];
  let running = 0, peak = 0;
  const service = new HazardTestService({ runHazardAnalysis: async input => {
    descriptions.push(input.textCandidate!.description);
    running += 1; peak = Math.max(peak, running);
    try { return await new Promise<AnalysisResult>((resolve, reject) => pending.push({ resolve, reject })); }
    finally { running -= 1; }
  } });
  const dataset = service.addDataset('concurrent', minimal());
  const job = service.start('concurrent', dataset.id, { concurrency: 3 });
  assert.equal(pending.length, 3);
  assert.equal(job.rows.filter(row => row.status === 'running').length, 3);
  assert.equal(service.start('concurrent', dataset.id, { concurrency: 8 }).options.concurrency, 3);
  pending[1].reject(new Error('并发测试单条失败'));
  await delay(0);
  assert.equal(pending.length, 4);
  assert.equal(job.stats.completed, 1);
  assert.equal(job.status, 'running');
  pending[3].resolve(result('D'));
  pending[2].resolve(result('C'));
  pending[0].resolve(result('B'));
  await finished(job);
  assert.equal(peak, 3);
  assert.equal(new Set(descriptions).size, 4);
  assert.deepEqual(job.rows.map(row => row.index), [1, 2, 3, 4]);
  assert.equal(job.stats.completed, 4);
  assert.equal(job.stats.failed, 1);
  assert.equal(job.stats.overall.percent, 100);
});

test('并发停止不再领取待执行项，等待所有在途条目完成才结束', async () => {
  const pending: Array<(result: AnalysisResult) => void> = [];
  const service = new HazardTestService({ runHazardAnalysis: () => new Promise(resolve => pending.push(resolve)) });
  const dataset = service.addDataset('stop-concurrent', minimal());
  const job = service.start('stop-concurrent', dataset.id, { concurrency: 3 });
  service.stop('stop-concurrent', job.id);
  pending[0](result('B'));
  await delay(0);
  assert.equal(job.status, 'stopping');
  assert.equal(pending.length, 3);
  assert.equal(job.rows[3].status, 'pending');
  pending[1](result('C')); pending[2](result('D'));
  await finished(job);
  assert.equal(job.status, 'stopped');
  assert.equal(job.stats.completed, 3);
});
