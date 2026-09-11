/**
 * 工作台识别会话（模块级单例）。
 *
 * 识别任务的生命周期被提升到 Workbench 组件之外，解决"页面切换后任务/结果丢失"：
 * - 组件卸载（hash 路由切换）不会中断正在进行的 SSE 流，任务继续在后台完成；
 * - 组件重新挂载后通过 subscribe() 重新附着同一会话，图片/进度/结果原样保留；
 * - 上传图片时立即把图片与场景写入 localStorage 草稿，刷新页面后仍可恢复；
 * - 刷新/重进时 SSE 已随页面断开，则通过后端 run store（GET /api/agent/runs/:runId
 *   与 /events?after=N）重新附着：已完成 → 直接恢复结果；仍运行 → 轮询事件继续展示进度。
 */
import type {
  AgentRunSnapshot,
  AgentStreamEvent,
  AgentUiStage,
  AnalysisOutputChannel,
  AnalysisOutputDeltaPayload,
  AnalysisOutputLifecyclePayload,
  AnalysisStageBusinessSummary,
  ReasoningEffort,
} from '../../shared/agent-protocol';
import type { AnalysisResult, Grade } from '../../shared/types';
import { analyzeImageStream, fetchAgentRun, fetchRunEvents } from '../api/agent';
import { ApiError } from '../api/client';
import { createAgentTaskId } from '../agent/session';
import { ANALYSIS_STAGE_LOG, ANALYSIS_STEPS, type Phase } from './constants';
import { downscaleForStorage, imageDataUrlToFile } from './imageUtils';
import {
  clearDraft,
  clearLastResult,
  loadDraft,
  loadLastResult,
  loadReasoningEffort,
  saveDraft,
  saveLastResult,
  saveReasoningEffort,
} from './storage';

export interface RunViewState {
  runId: string | null;
  status: 'idle' | 'connecting' | 'streaming' | 'completed' | 'failed';
  modelName: string | null;
  activeStage: AgentUiStage | null;
  completedStages: AgentUiStage[];
  progress: number;
  logs: AnalysisLogEntry[];
  modelOutputs: ModelOutputEntry[];
  /** 兼容已有调用方；始终镜像 public_summary 输出。 */
  publicOutput: { text: string; status: 'idle' | 'streaming' | 'completed' | 'interrupted' };
  summary: {
    scenes: string[];
    currentGrade: Grade | null;
    confidence: number | null;
    ruleHits: number | null;
  };
  lastSequence: number;
  replayStatus: 'none' | 'replaying' | 'available' | 'unavailable';
  fallbackReason: string | null;
  requiresReview: boolean;
}

export interface ModelOutputEntry {
  channel: AnalysisOutputChannel;
  label: string;
  model: string | null;
  text: string;
  status: 'streaming' | 'completed' | 'interrupted';
  sequence: number;
}

export interface AnalysisLogEntry {
  id: string;
  sequence: number;
  timestamp: string;
  stage: AgentUiStage | null;
  tone: 'normal' | 'success' | 'decision' | 'warning' | 'error';
  text: string;
}

export function emptyRunView(): RunViewState {
  return {
    runId: null,
    status: 'idle',
    modelName: null,
    activeStage: null,
    completedStages: [],
    progress: 0,
    logs: [],
    modelOutputs: [],
    publicOutput: { text: '', status: 'idle' },
    summary: { scenes: [], currentGrade: null, confidence: null, ruleHits: null },
    lastSequence: 0,
    replayStatus: 'none',
    fallbackReason: null,
    requiresReview: false,
  };
}

export interface WorkbenchSnapshot {
  phase: Phase;
  previewUrl: string | null;
  imageName: string;
  imageSize?: number;
  scenarioId: string | null;
  /** 思考强度（DeepSeek reasoning effort）；从未配置/旧配置缺失时回退 'low'。 */
  reasoningEffort: ReasoningEffort;
  taskId: string;
  runView: RunViewState;
  result: AnalysisResult | null;
  errorMsg: string;
  /** 是否存在内存中的活动任务（SSE 直连或后端轮询附着）；false 表示纯恢复态。 */
  live: boolean;
  /** 是否通过后端 run store 重新附着（非本次页面发起的任务）。 */
  reattached: boolean;
}

const POLL_INTERVAL_MS = 2_500;
/** 轮询上限（约 5 分钟），避免无限占用；仍未结束则提示用户手动重试。 */
const MAX_POLLS = 120;
const STORE_IMAGE_MAX_CHARS = 400_000;

let snapshot: WorkbenchSnapshot = freshSnapshot();
const listeners = new Set<(s: WorkbenchSnapshot) => void>();

/** 当前会话上传的 File（仅内存态，用于重试/保存；刷新后由 dataURL 重建）。 */
let lastFile: File | null = null;
/** 已降采样的可持久化图片（草稿与结果共用）。 */
let storedImage: { dataUrl: string; name: string } | null = null;

let liveAbort: AbortController | null = null; // 当前 SSE 流
let pollAbort: AbortController | null = null; // 当前后端恢复轮询（同时兼作会话令牌）
let pollHandle: ReturnType<typeof setInterval> | null = null;
let restoreStarted = false;

function freshSnapshot(): WorkbenchSnapshot {
  return {
    phase: 'idle',
    previewUrl: null,
    imageName: 'upload.png',
    imageSize: undefined,
    scenarioId: null,
    // 用户上次保存的思考强度；从未配置（含旧版本无该字段）时为默认 low。
    reasoningEffort: loadReasoningEffort() ?? 'low',
    taskId: createAgentTaskId(),
    runView: emptyRunView(),
    result: null,
    errorMsg: '',
    live: false,
    reattached: false,
  };
}

function emit(): void {
  const s = snapshot;
  listeners.forEach((fn) => {
    try {
      fn(s);
    } catch {
      /* 忽略订阅者异常 */
    }
  });
}

export function getWorkbenchSnapshot(): WorkbenchSnapshot {
  return snapshot;
}

export function subscribeWorkbench(fn: (s: WorkbenchSnapshot) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function update(patch: Partial<WorkbenchSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

/** 终止当前所有活动任务（SSE 与轮询）；仅应在用户显式操作时调用。 */
function stopLiveTasks(): void {
  if (liveAbort) {
    liveAbort.abort();
    liveAbort = null;
  }
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
}

/**
 * 切换思考强度：立即更新内存会话并持久化（localStorage）。
 * 下一次「AI 智能识别」直接使用新值，无需刷新页面。
 */
export function setWorkbenchReasoningEffort(effort: ReasoningEffort): void {
  if (effort === snapshot.reasoningEffort) return;
  update({ reasoningEffort: effort });
  saveReasoningEffort(effort);
}

/** SSE/回放事件使用同一纯归约器，确保实时与重放结果一致。 */
export function applyAgentEvent(current: RunViewState, event: AgentStreamEvent): RunViewState {
  if (event.runId === current.runId && event.sequence <= current.lastSequence) return current;
  let next: RunViewState = { ...current, runId: event.runId, lastSequence: event.sequence };
  if (event.type === 'run.started') {
    const payload = event.payload as { config?: { model?: string } };
    next = {
      ...next,
      status: 'streaming',
      modelName: payload.config?.model ?? current.modelName,
    };
    return appendLog(next, event, '分析任务已启动，正在加载模型与运行配置');
  }
  if (event.type === 'step.started') {
    const activeStage = event.uiStage ?? current.activeStage;
    next = withProgress({ ...next, status: 'streaming', activeStage });
    return activeStage ? appendLog(next, event, ANALYSIS_STAGE_LOG[activeStage].started) : next;
  }
  if (event.type === 'step.completed' && event.uiStage) {
    const completedStages = current.completedStages.includes(event.uiStage)
      ? current.completedStages
      : [...current.completedStages, event.uiStage];
    next = withProgress({ ...next, activeStage: event.uiStage, completedStages });
    next = applyBusinessSummary(next, (event.payload as { business?: AnalysisStageBusinessSummary }).business);
    return appendLog(next, event, completedLogText(event), 'success');
  }
  if (event.type === 'run.fallback') {
    const payload = event.payload as { reason?: string };
    const reason = payload.reason ?? '已启用保守降级路径';
    return appendLog({ ...next, fallbackReason: reason }, event, `已切换保守降级路径：${reason}`, 'warning');
  }
  if (event.type === 'run.requires_review') {
    return appendLog({ ...next, requiresReview: true }, event, '当前结果触发人工复核条件', 'warning');
  }
  if (event.type === 'analysis.output.started') {
    const payload = event.payload as AnalysisOutputLifecyclePayload;
    const modelOutputs = upsertModelOutput(current.modelOutputs ?? [], payload.channel, (entry) => ({
      channel: payload.channel,
      label: payload.label ?? outputLabel(payload.channel),
      model: payload.model ?? current.modelName,
      text: '',
      status: 'streaming',
      sequence: entry?.sequence ?? event.sequence,
    }));
    const publicOutput = payload.channel === 'public_summary'
      ? { text: '', status: 'streaming' as const }
      : current.publicOutput;
    return appendLog({ ...next, modelOutputs, publicOutput }, event, `${payload.label ?? outputLabel(payload.channel)}开始流式生成`);
  }
  if (event.type === 'analysis.output.delta') {
    const payload = event.payload as AnalysisOutputDeltaPayload;
    if (!payload.delta) return next;
    const modelOutputs = upsertModelOutput(current.modelOutputs ?? [], payload.channel, (entry) => ({
      channel: payload.channel,
      label: entry?.label ?? outputLabel(payload.channel),
      model: entry?.model ?? current.modelName,
      text: `${entry?.text ?? ''}${payload.delta}`.slice(0, outputLimit(payload.channel)),
      status: 'streaming',
      sequence: entry?.sequence ?? event.sequence,
    }));
    return {
      ...next,
      modelOutputs,
      publicOutput: payload.channel === 'public_summary'
        ? { text: `${current.publicOutput.text}${payload.delta}`.slice(0, 800), status: 'streaming' }
        : current.publicOutput,
    };
  }
  if (event.type === 'analysis.output.completed') {
    const payload = event.payload as AnalysisOutputLifecyclePayload;
    return {
      ...next,
      modelOutputs: upsertModelOutput(current.modelOutputs ?? [], payload.channel, (entry) => ({
        channel: payload.channel,
        label: entry?.label ?? payload.label ?? outputLabel(payload.channel),
        model: entry?.model ?? payload.model ?? current.modelName,
        text: entry?.text ?? '',
        status: 'completed',
        sequence: entry?.sequence ?? event.sequence,
      })),
      publicOutput: payload.channel === 'public_summary'
        ? { ...current.publicOutput, status: 'completed' }
        : current.publicOutput,
    };
  }
  if (event.type === 'analysis.output.failed') {
    const payload = event.payload as AnalysisOutputLifecyclePayload;
    return appendLog(
      {
        ...next,
        modelOutputs: upsertModelOutput(current.modelOutputs ?? [], payload.channel, (entry) => ({
          channel: payload.channel,
          label: entry?.label ?? payload.label ?? outputLabel(payload.channel),
          model: entry?.model ?? payload.model ?? current.modelName,
          text: entry?.text ?? '',
          status: 'interrupted',
          sequence: entry?.sequence ?? event.sequence,
        })),
        publicOutput: payload.channel === 'public_summary'
          ? { ...current.publicOutput, status: 'interrupted' }
          : current.publicOutput,
      },
      event,
      payload.message ?? `${payload.label ?? outputLabel(payload.channel)}已中断`,
      'warning'
    );
  }
  if (event.type === 'result.completed') {
    const payload = event.payload as { data?: AnalysisResult };
    const data = payload.data;
    next = {
      ...next,
      status: 'completed',
      activeStage: null,
      completedStages: ANALYSIS_STEPS.map((item) => item.stage),
      progress: 100,
      modelName: data?.modelName ?? current.modelName,
      summary: data ? finalSummary(current.summary, data) : current.summary,
    };
    return appendLog(next, event, '分析完成，结构化结果已生成', 'success');
  }
  if (event.type === 'run.completed') return { ...next, status: 'completed', activeStage: null, progress: 100 };
  if (event.type === 'run.failed') {
    const payload = event.payload as { message?: string };
    return appendLog(
      { ...next, status: 'failed', activeStage: null },
      event,
      payload.message ?? '分析任务运行失败',
      'error'
    );
  }
  return next;
}

function upsertModelOutput(
  outputs: ModelOutputEntry[],
  channel: AnalysisOutputChannel,
  updateEntry: (entry: ModelOutputEntry | undefined) => ModelOutputEntry
): ModelOutputEntry[] {
  const index = outputs.findIndex((entry) => entry.channel === channel);
  const nextEntry = updateEntry(index >= 0 ? outputs[index] : undefined);
  if (index < 0) return [...outputs, nextEntry];
  return outputs.map((entry, itemIndex) => itemIndex === index ? nextEntry : entry);
}

function outputLabel(channel: AnalysisOutputChannel): string {
  if (channel === 'vision') return '图像识别模型输出';
  if (channel === 'reasoning') return '风险推理模型输出';
  return '最终分析摘要';
}

function outputLimit(channel: AnalysisOutputChannel): number {
  return channel === 'public_summary' ? 800 : 6_000;
}

function withProgress(view: RunViewState): RunViewState {
  const activeContribution = view.activeStage && !view.completedStages.includes(view.activeStage) ? 0.5 : 0;
  const progress = Math.min(99, Math.round(((view.completedStages.length + activeContribution) / ANALYSIS_STEPS.length) * 100));
  return { ...view, progress };
}

function appendLog(
  view: RunViewState,
  event: AgentStreamEvent,
  text: string,
  tone: AnalysisLogEntry['tone'] = 'normal'
): RunViewState {
  if (!text || view.logs.some((item) => item.id === `${event.eventId}:${text}`)) return view;
  return {
    ...view,
    logs: [...view.logs, {
      id: `${event.eventId}:${text}`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      stage: event.uiStage ?? null,
      tone,
      text,
    }].slice(-200),
  };
}

function applyBusinessSummary(view: RunViewState, business?: AnalysisStageBusinessSummary): RunViewState {
  if (!business) return view;
  return {
    ...view,
    summary: {
      scenes: business.scenes?.length ? business.scenes : view.summary.scenes,
      currentGrade: business.finalGrade ?? business.predictedGrade ?? view.summary.currentGrade,
      confidence: business.maxConfidence ?? view.summary.confidence,
      ruleHits: business.matchedRules ?? view.summary.ruleHits,
    },
  };
}

function completedLogText(event: AgentStreamEvent): string {
  const stage = event.uiStage;
  if (!stage) return '当前分析阶段已完成';
  const business = (event.payload as { business?: AnalysisStageBusinessSummary }).business;
  if (stage === 'vision' && business) {
    const scenes = business.scenes?.length ? business.scenes.join(' / ') : business.imageSummary;
    return `${scenes ? `已识别作业场景：${scenes}；` : ''}发现 ${business.candidateCount ?? 0} 个候选隐患`;
  }
  if (stage === 'rules' && business) {
    return `风险规则匹配完成：命中 ${business.matchedRules ?? 0} 条，其中星标 ${business.starredRules ?? 0} 条`;
  }
  if (stage === 'reasoning' && business?.predictedGrade) {
    return `模型阶段性风险预测：${business.predictedGrade} 级，正在进行确定性规则复核`;
  }
  if (stage === 'validation' && business) {
    return business.finalGrade
      ? `风险等级已校验：${business.finalGrade} 级，形成 ${business.hazardCount ?? 0} 条隐患结论`
      : '风险等级校验完成，未形成明确隐患等级';
  }
  return ANALYSIS_STAGE_LOG[stage].completed;
}

function finalSummary(current: RunViewState['summary'], result: AnalysisResult): RunViewState['summary'] {
  const confidences = result.hazards.map((item) => item.confidence);
  const citedRules = result.hazards.reduce((sum, item) => sum + (item.ruleReferences?.length ?? 0), 0);
  return {
    scenes: result.hazards.length
      ? [...new Set(result.hazards.map((item) => item.category))]
      : current.scenes.length ? current.scenes : [result.imageSummary],
    currentGrade: result.overallRisk,
    confidence: confidences.length ? Math.max(...confidences) : current.confidence,
    ruleHits: current.ruleHits ?? citedRules,
  };
}

/** 持久化草稿：写入前校验会话未被替换/清空（避免异步降采样完成后写回过期草稿）。 */
async function persistDraft(phase: 'ready' | 'analyzing', runId?: string): Promise<void> {
  const taskId = snapshot.taskId;
  const previewUrl = snapshot.previewUrl;
  const imageName = snapshot.imageName;
  const scenarioId = snapshot.scenarioId;
  if (!previewUrl) return;
  let image = storedImage;
  if (!image) {
    const dataUrl = previewUrl.length > STORE_IMAGE_MAX_CHARS ? await downscaleForStorage(previewUrl) : previewUrl;
    image = { dataUrl, name: imageName };
  }
  if (snapshot.taskId !== taskId) return; // 会话已切换，丢弃过期写入
  storedImage = image;
  saveDraft({ phase, image, scenario: scenarioId, taskId, runId });
}

/** 识别完成（SSE 或后端恢复）、落库并清除草稿。 */
function finalize(data: AnalysisResult, opts: { reattached?: boolean; runId?: string | null } = {}): void {
  const p: Phase = data.hazards.length ? 'done' : 'empty';
  const runView: RunViewState = {
    ...snapshot.runView,
    runId: opts.runId ?? snapshot.runView.runId,
    status: 'completed',
    activeStage: null,
    completedStages: ANALYSIS_STEPS.map((item) => item.stage),
    progress: 100,
    modelName: data.modelName ?? snapshot.runView.modelName,
    summary: finalSummary(snapshot.runView.summary, data),
  };
  update({
    phase: p,
    result: data,
    errorMsg: '',
    runView,
    live: false,
    reattached: opts.reattached ?? false,
  });
  clearDraft();
  saveLastResult(data, storedImage ?? null, snapshot.scenarioId);
}

function failRun(event: AgentStreamEvent): void {
  const payload = event.payload as { message?: string; code?: string };
  update({
    phase: 'error',
    errorMsg: payload.message ?? 'Agent 运行失败。',
    runView: { ...snapshot.runView, status: 'failed', activeStage: null },
    live: false,
    reattached: false,
  });
  // 保留图片草稿，用户刷新后仍可重试
  void persistDraft('ready').catch(() => undefined);
}

/** 上传/选择新图片：中止旧任务，进入 ready，并立即持久化图片草稿。 */
export function resetWorkbenchForFile(input: {
  file?: File | null;
  previewUrl: string;
  imageName: string;
  imageSize?: number;
  scenarioId: string | null;
}): void {
  stopLiveTasks();
  lastFile = input.file ?? null;
  storedImage = null;
  update({
    phase: 'ready',
    previewUrl: input.previewUrl,
    imageName: input.imageName,
    imageSize: input.imageSize,
    scenarioId: input.scenarioId,
    result: null,
    errorMsg: '',
    taskId: createAgentTaskId(),
    runView: emptyRunView(),
    live: false,
    reattached: false,
  });
  void persistDraft('ready').catch(() => undefined);
}

/** 开始识别。SSE 生命周期由本模块持有：组件卸载不中断，完成后自动落库。 */
export async function startWorkbenchAnalysis(input: {
  previewUrl: string;
  imageName: string;
  scenarioId: string | null;
}): Promise<void> {
  stopLiveTasks();
  const controller = new AbortController();
  liveAbort = controller;
  update({
    phase: 'analyzing',
    result: null,
    errorMsg: '',
    runView: { ...emptyRunView(), status: 'connecting' },
    live: true,
    reattached: false,
  });
  void persistDraft('analyzing').catch(() => undefined);

  const targetFile = lastFile ?? (await imageDataUrlToFile(input.previewUrl, input.imageName));
  try {
    const resp = await analyzeImageStream(targetFile, {
      scenario: input.scenarioId ?? undefined,
      source: 'workbench',
      reasoningEffort: snapshot.reasoningEffort,
      taskId: snapshot.taskId,
      signal: controller.signal,
      onEvent: (event) => {
        update({ runView: applyAgentEvent(snapshot.runView, event) });
        if (event.type === 'run.started') {
          // 记录 runId，保证刷新后可以重新附着
          void persistDraft('analyzing', event.runId).catch(() => undefined);
        }
        if (event.type === 'result.completed') {
          const payload = event.payload as { data?: AnalysisResult };
          if (payload.data) finalize(payload.data);
        }
        if (event.type === 'run.failed') failRun(event);
      },
    });
    // analyzeImageStream 返回时 result.completed 已消费；此处兜底（已过终态则跳过）
    if (snapshot.phase === 'analyzing' && liveAbort === controller) finalize(resp.data);
  } catch (err) {
    if (controller.signal.aborted) return; // 被新上传 / 清空 / 重新分析取代
    const msg = err instanceof ApiError ? err.message : String((err as Error).message ?? err);
    update({ phase: 'error', errorMsg: msg, live: false, reattached: false });
    void persistDraft('ready').catch(() => undefined);
  } finally {
    if (liveAbort === controller) liveAbort = null;
  }
}

/** 清空工作台：中止任务并清除全部持久化状态。 */
export function clearWorkbench(): void {
  stopLiveTasks();
  lastFile = null;
  storedImage = null;
  clearDraft();
  clearLastResult();
  snapshot = freshSnapshot();
  emit();
}

/** 局部修订 result（人工复核等），仅更新内存，不重复落库。 */
export function patchWorkbenchResult(mutate: (r: AnalysisResult) => AnalysisResult): void {
  const r = snapshot.result;
  if (!r) return;
  update({ result: mutate(r) });
}

/** 按稳定 ID 删除误判，保留其余隐患的编号、修订和标注，并持久化当前结果。 */
export function deleteWorkbenchHazard(hazardId: string): void {
  const current = snapshot.result;
  if (!current || !current.hazards.some((hazard) => hazard.id === hazardId)) return;
  const hazards = current.hazards.filter((hazard) => hazard.id !== hazardId);
  const order = { A: 4, B: 3, C: 2, D: 1 } as const;
  const result: AnalysisResult = {
    ...current,
    hazards,
    overallRisk: hazards.reduce<Grade | null>(
      (worst, hazard) => (!worst || order[hazard.grade] > order[worst] ? hazard.grade : worst),
      null
    ),
    stats: {
      standardsCited: new Set(hazards.flatMap((hazard) => hazard.standardReferences.map((ref) => `${ref.documentCode}:${ref.clause}`))).size,
      casesCited: new Set(hazards.flatMap((hazard) => hazard.historicalReferences.map((ref) => ref.caseId))).size,
    },
  };
  update({ result, phase: hazards.length ? 'done' : 'empty' });
  saveLastResult(result, storedImage, snapshot.scenarioId);
}

/**
 * 挂载时恢复，恢复优先级：
 *   1) 模块内存已有会话（组件卸载期间任务继续运行）→ 直接附着；
 *   2) localStorage 草稿 → ready 直接恢复；analyzing 尝试从后端重新附着；
 *   3) 最近一次已完成结果（兼容旧行为）。
 * 幂等：仅首次调用生效（StrictMode 双挂载安全）。
 */
export function restoreWorkbench(): void {
  if (restoreStarted) return;
  restoreStarted = true;

  // 1) 内存会话优先（切换页面场景：任务仍在后台运行）
  if (snapshot.phase !== 'idle') return;

  // 2) localStorage 草稿（刷新页面场景）
  const draft = loadDraft();
  if (draft?.image) {
    storedImage = { dataUrl: draft.image.dataUrl, name: draft.image.name };
    const taskId = draft.taskId ?? createAgentTaskId();
    update({
      phase: draft.phase === 'analyzing' ? 'analyzing' : 'ready',
      previewUrl: draft.image.dataUrl,
      imageName: draft.image.name,
      scenarioId: draft.scenario ?? null,
      taskId,
      runView: emptyRunView(),
      live: false,
      reattached: false,
    });
    if (draft.phase === 'analyzing') {
      if (draft.runId) void attachToBackendRun(draft.runId);
      else {
        // run.started 之前就断流：无法重连，提示后降级为 ready
        update({ phase: 'ready', errorMsg: '上一次识别在页面刷新时中断，图片已保留，可点击「AI 智能识别」重新开始。', live: false });
      }
    }
    return;
  }

  // 3) 兼容旧行为：恢复最近一次已完成的分析
  const last = loadLastResult();
  if (last?.analysis) {
    storedImage = last.image;
    const restoredRunView: RunViewState = {
      ...emptyRunView(),
      runId: last.analysis.agentMeta?.runId ?? null,
      status: 'completed',
      modelName: last.analysis.modelName,
      completedStages: ANALYSIS_STEPS.map((item) => item.stage),
      progress: 100,
      summary: finalSummary(emptyRunView().summary, last.analysis),
      replayStatus: last.analysis.agentMeta?.runId ? 'replaying' : 'unavailable',
    };
    update({
      phase: last.analysis.hazards.length ? 'done' : 'empty',
      previewUrl: last.image?.dataUrl ?? null,
      imageName: last.image?.name ?? 'upload.png',
      scenarioId: last.scenario ?? null,
      taskId: last.analysis.agentMeta?.taskId ?? createAgentTaskId(),
      runView: restoredRunView,
      result: last.analysis,
      live: false,
      reattached: false,
    });
    if (last.analysis.agentMeta?.runId) {
      void replayCompletedRunView(last.analysis.agentMeta.runId, last.analysis.analysisId);
    }
  }
}

/**
 * SSE 已断开（页面刷新/重进）后从后端重新附着：
 *   已终态 → 直接恢复结果/错误；仍运行 → 轮询 /events?after=N 重放进度直至终态。
 * pollAbort 同时充当会话令牌：任何新上传/清空/重新分析都会使其失效，防止旧恢复覆盖新会话。
 */
async function attachToBackendRun(runId: string): Promise<void> {
  const token = new AbortController();
  pollAbort = token;

  let run: AgentRunSnapshot | null = null;
  try {
    run = await fetchAgentRun(runId);
  } catch {
    run = null;
  }
  if (pollAbort !== token) return; // 期间用户已开始新操作

  if (!run) {
    update({
      phase: 'ready',
      errorMsg: '后台任务已过期或服务重启，无法恢复；图片已保留，可点击「AI 智能识别」重新开始。',
      live: false,
      reattached: false,
    });
    return;
  }
  if (run.status === 'completed' && run.result) {
    finalize(run.result, { reattached: true, runId });
    void replayCompletedRunView(runId, run.result.analysisId);
    return;
  }
  if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'rejected') {
    update({
      phase: 'error',
      errorMsg: run.error?.message ?? '识别任务已结束（未完成）。',
      live: false,
      reattached: false,
    });
    return;
  }

  // 仍在运行：轮询事件继续展示进度
  update({
    phase: 'analyzing',
    runView: { ...snapshot.runView, runId, status: 'streaming', replayStatus: 'replaying' },
    live: true,
    reattached: true,
  });

  let after = 0;
  let polls = 0;
  const tick = async () => {
    if (pollAbort !== token) return;
    let events: AgentStreamEvent[] = [];
    try {
      events = await fetchRunEvents(runId, after);
    } catch {
      // 瞬态网络错误：下一轮重试
    }
    if (pollAbort !== token) return;
    for (const event of events) {
      after = Math.max(after, event.sequence);
      update({ runView: applyAgentEvent(snapshot.runView, event) });
      if (event.type === 'result.completed') {
        const payload = event.payload as { data?: AnalysisResult };
        if (payload.data) {
          const current = pollAbort === token; // 先捕获令牌，再停止任务
          stopLiveTasks();
          if (current) finalize(payload.data, { reattached: true, runId });
          return;
        }
      }
      if (event.type === 'run.failed') {
        const current = pollAbort === token;
        stopLiveTasks();
        if (current) failRun(event);
        return;
      }
      if (event.type === 'run.cancelled') {
        const current = pollAbort === token;
        stopLiveTasks();
        if (current) {
          update({ phase: 'ready', errorMsg: '识别任务已被取消，图片已保留。', live: false, reattached: false });
        }
        return;
      }
    }
    polls += 1;
    if (polls >= MAX_POLLS) {
      stopLiveTasks();
      update({
        phase: 'ready',
        errorMsg: '后台任务长时间未结束，已停止自动刷新；可点击「AI 智能识别」重新开始。',
        live: false,
        reattached: false,
      });
    }
  };
  pollHandle = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
}

/** 已完成结果在刷新后使用后端事件重建完整时间线；事件过期时不伪造日志。 */
async function replayCompletedRunView(runId: string, analysisId: string): Promise<void> {
  try {
    const events = await fetchRunEvents(runId, 0);
    if (snapshot.result?.analysisId !== analysisId) return;
    if (!events.length) {
      update({ runView: { ...snapshot.runView, replayStatus: 'unavailable' } });
      return;
    }
    let view: RunViewState = { ...emptyRunView(), replayStatus: 'replaying' };
    for (const event of events) view = applyAgentEvent(view, event);
    if (snapshot.result?.analysisId !== analysisId) return;
    view = {
      ...view,
      runId,
      status: 'completed',
      activeStage: null,
      completedStages: ANALYSIS_STEPS.map((item) => item.stage),
      progress: 100,
      replayStatus: 'available',
      modelName: snapshot.result.modelName ?? view.modelName,
      summary: finalSummary(view.summary, snapshot.result),
    };
    update({ runView: view, reattached: true });
  } catch {
    if (snapshot.result?.analysisId === analysisId) {
      update({ runView: { ...snapshot.runView, replayStatus: 'unavailable' } });
    }
  }
}
