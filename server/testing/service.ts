import { randomUUID } from 'node:crypto';
import type { AgentRuntime, StartHazardRunInput } from '../agent/runtime.js';
import type { AnalysisResult, Grade } from '../../shared/types.js';
import { TEST_GRADES, type HazardTestJob, type HazardTestRow, type HazardTestStats, type TestAccuracy } from '../../shared/hazard-test.js';
import { normalizeTestGrade, testCandidateOf, type ParsedTestDataset } from './dataset.js';
import { DEFAULT_TEST_OPTIONS, TEST_MAX_CONCURRENCY, TEST_MIN_OUTPUT_TOKENS, TEST_MAX_OUTPUT_TOKENS, type HazardTestOptions } from '../../shared/hazard-test.js';

type RunAnalysis = (input: StartHazardRunInput) => Promise<AnalysisResult>;
const EMPTY_ACCURACY = () => ({ A: null, B: null, C: null, D: null, overall: null });
const metric = (correct: number, valid: number): TestAccuracy => ({ correct, valid, percent: valid ? correct / valid * 100 : null });

export function compareTestRow(row: HazardTestRow, actual: Grade): void {
  row.actual = actual;
  if (!row.expected) return;
  for (const grade of TEST_GRADES) row.accuracy[grade] = (row.expected === grade) === (actual === grade);
  row.accuracy.overall = row.expected === actual;
  row.differences = TEST_GRADES.filter(grade => row.accuracy[grade] === false);
}

export function calculateTestStats(rows: HazardTestRow[]): HazardTestStats {
  const successful = rows.filter(r => r.status === 'success');
  const valid = successful.filter(r => r.accuracy.overall !== null);
  const correct = valid.filter(r => r.accuracy.overall === true).length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const byGrade = Object.fromEntries(TEST_GRADES.map(grade => {
    const scored = successful.filter(r => r.accuracy[grade] !== null);
    return [grade, metric(scored.filter(r => r.accuracy[grade]).length, scored.length)];
  })) as Record<Grade, TestAccuracy>;
  const recall = Object.fromEntries(TEST_GRADES.map(grade => {
    const positives = valid.filter(r => r.expected === grade);
    return [grade, metric(positives.filter(r => r.actual === grade).length, positives.length)];
  })) as Record<Grade, TestAccuracy>;
  return { total: rows.length, completed: successful.length + failed, success: successful.length, failed,
    correct, incorrect: valid.length - correct, unscored: successful.length - valid.length,
    overall: metric(correct, valid.length), byGrade, recall };
}

export class HazardTestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'HAZARD_TEST_ERROR') { super(message); }
}

/** 进程内临时缓存：24 小时、最多 12 个数据集和 12 个任务；运行中任务不淘汰。 */
export class HazardTestService {
  private datasets = new Map<string, { owner: string; value: ParsedTestDataset; expires: number }>();
  private jobs = new Map<string, { owner: string; value: HazardTestJob; expires: number }>();
  private readonly ttl = 24 * 60 * 60_000;
  private readonly capacity = 12;
  private run: RunAnalysis;

  constructor(runtime: Pick<AgentRuntime, 'runHazardAnalysis'>) {
    this.run = input => runtime.runHazardAnalysis(input);
  }

  private prune(): void {
    for (const [id, item] of this.jobs) if (item.expires < Date.now() && !this.isActive(item.value)) this.jobs.delete(id);
    for (const [id, item] of this.datasets) if (item.expires < Date.now() && ![...this.jobs.values()].some(j => j.value.dataset.id === id && this.isActive(j.value))) this.datasets.delete(id);
  }

  private isActive(job: HazardTestJob) { return job.status === 'running' || job.status === 'stopping'; }

  addDataset(owner: string, dataset: ParsedTestDataset) {
    this.prune();
    if (this.datasets.size >= this.capacity) {
      const disposable = [...this.datasets].find(([id]) => ![...this.jobs.values()].some(j => j.value.dataset.id === id && this.isActive(j.value)));
      if (!disposable) throw new HazardTestError('当前测试任务过多，请稍后再上传。', 429);
      this.datasets.delete(disposable[0]);
    }
    this.datasets.set(dataset.metadata.id, { owner, value: dataset, expires: Date.now() + this.ttl });
    return dataset.metadata;
  }

  latest(owner: string): HazardTestJob | null {
    this.prune();
    return [...this.jobs.values()].reverse().find(item => item.owner === owner)?.value ?? null;
  }

  getJob(owner: string, id: string): HazardTestJob {
    this.prune();
    const item = this.jobs.get(id);
    if (!item || item.owner !== owner) throw new HazardTestError('测试任务不存在或已过期，请重新加载测试集。', 404, 'TEST_NOT_FOUND');
    return item.value;
  }

  start(owner: string, datasetId: string, options: Partial<HazardTestOptions> = {}): HazardTestJob {
    const settings = { ...DEFAULT_TEST_OPTIONS, ...options };
    if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > TEST_MAX_CONCURRENCY) {
      throw new HazardTestError(`并发数必须为 1–${TEST_MAX_CONCURRENCY} 的整数。`);
    }
    if (!Number.isInteger(settings.maxOutputTokens) || settings.maxOutputTokens < TEST_MIN_OUTPUT_TOKENS || settings.maxOutputTokens > TEST_MAX_OUTPUT_TOKENS) {
      throw new HazardTestError(`单条输出上限必须为 ${TEST_MIN_OUTPUT_TOKENS}–${TEST_MAX_OUTPUT_TOKENS} 的整数。`);
    }
    this.prune();
    const active = [...this.jobs.values()].find(item => item.owner === owner && this.isActive(item.value));
    if (active) {
      if (active.value.dataset.id === datasetId) return active.value;
      throw new HazardTestError('已有测试正在执行，请等待完成或停止后再开始。', 409, 'TEST_RUNNING');
    }
    const dataset = this.datasets.get(datasetId);
    if (!dataset || dataset.owner !== owner) throw new HazardTestError('测试集不存在或已过期，请重新加载默认数据或上传 CSV。', 404, 'DATASET_NOT_FOUND');
    if (this.jobs.size >= this.capacity) {
      const disposable = [...this.jobs].find(([, item]) => !this.isActive(item.value));
      if (!disposable) throw new HazardTestError('当前测试任务过多，请稍后重试。', 429);
      this.jobs.delete(disposable[0]);
    }
    const rows: HazardTestRow[] = dataset.value.records.map((sourceData, i) => ({
      index: i + 1, sourceData, expected: normalizeTestGrade(sourceData['隐患级别']), actual: null,
      accuracy: EMPTY_ACCURACY(), differences: [], status: 'pending', agentRawOutput: '',
    }));
    const job: HazardTestJob = { id: randomUUID(), options: settings, dataset: dataset.value.metadata, status: 'running',
      createdAt: new Date().toISOString(), rows, stats: calculateTestStats(rows) };
    this.jobs.set(job.id, { owner, value: job, expires: Date.now() + this.ttl });
    // 脱离 HTTP 请求执行；页面离开或请求断开不丢失进度。
    void this.execute(owner, job);
    return job;
  }

  stop(owner: string, id: string): HazardTestJob {
    const job = this.getJob(owner, id);
    if (job.status === 'running') job.status = 'stopping';
    return job;
  }

  private async execute(owner: string, job: HazardTestJob): Promise<void> {
    let next = 0;
    const worker = async () => {
      // 领取序号与停止检查之间没有 await，条目只会被一个 worker 领取。
      while (job.status === 'running' && next < job.rows.length) {
        const row = job.rows[next++];
        await this.executeRow(owner, job, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(job.options.concurrency, job.rows.length) }, worker));
    job.status = job.status === 'stopping' ? 'stopped' : 'completed';
    job.completedAt = new Date().toISOString();
    const cached = this.jobs.get(job.id);
    if (cached) cached.expires = Date.now() + this.ttl;
  }

  private async executeRow(owner: string, job: HazardTestJob, row: HazardTestRow): Promise<void> {
    row.status = 'running';
    row.startedAt = new Date().toISOString();
    let completeRawOutput: string | undefined;
    try {
      const analysis = await this.run({
        buffer: Buffer.alloc(0), mimeType: 'text/plain', textCandidate: testCandidateOf(row.sourceData),
        textMaxOutputTokens: job.options.maxOutputTokens,
        userId: owner, conversationId: `hazard-test-${job.id}`, sessionId: `hazard-test-${job.id}`,
        onReasoningOutput: text => { completeRawOutput = text; },
        onEvent: event => {
          row.runId = event.runId;
          if (event.type === 'analysis.output.delta') {
            const payload = event.payload as { channel?: string; delta?: string };
            if (payload.channel === 'reasoning' && typeof payload.delta === 'string') row.agentRawOutput += payload.delta;
          }
        },
      });
      row.analysis = analysis;
      // 生产系统的兜底 C 级不是模型有效预测，不能被当作测试正确。
      if (analysis.agentMeta?.fallbackUsed || analysis.hazards.length !== 1 || !TEST_GRADES.includes(analysis.hazards[0].grade)) {
        throw new Error(analysis.agentMeta?.fallbackReason ?? 'Agent 未返回唯一有效的隐患等级。');
      }
      compareTestRow(row, analysis.hazards[0].grade);
      row.status = 'success';
    } catch (error) {
      row.status = 'failed';
      row.errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[hazard-test] job=${job.id} row=${row.index} run=${row.runId ?? '-'}: ${row.errorMessage}`);
    } finally {
      if (completeRawOutput !== undefined) row.agentRawOutput = completeRawOutput;
      row.completedAt = new Date().toISOString();
      job.stats = calculateTestStats(job.rows);
    }
  }
}

export function exportTestErrors(job: HazardTestJob): string {
  const rows = job.rows.filter(row => row.accuracy.overall === false || row.status === 'failed');
  // 防止导出后被电子表格当作公式执行；保留原始 JSON 供无损检查。
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const values: unknown[][] = [['序号', '隐患单号', '隐患描述', '标准答案', 'Agent判断', '差异字段', '状态', '异常信息', '原始CSV数据', 'Agent原始输出', 'Agent完整结果', 'runId']];
  for (const row of rows) values.push([row.index, row.sourceData['隐患单号'], row.sourceData['隐患描述'], row.expected, row.actual,
    row.differences.join('/'), row.status === 'failed' ? '执行失败' : '错误', row.errorMessage,
    JSON.stringify(row.sourceData), row.agentRawOutput, JSON.stringify(row.analysis ?? null), row.runId]);
  return '\uFEFF' + values.map(row => row.map(cell).join(',')).join('\r\n');
}
