import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisResult, BBox, Hazard, StandardReference } from '../../shared/types';
import type { ReasoningEffort } from '../../shared/agent-protocol';
import { AnalysisProgress } from '../components/AnalysisProgress';
import { AnalysisSummary } from '../components/AnalysisSummary';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { HazardCard } from '../components/HazardCard';
import { ImagePanel } from '../components/ImagePanel';
import type { AnnotatorHandle } from '../components/ImageAnnotator';
import { IconAlert, IconAnalyze, IconChartBar, IconRoute, IconXCircle } from '../components/icons';
import { postExportReport } from '../api/analysis';
import { addOrMergeLastRecord } from '../lib/storage';
import { downscaleForStorage, fileToDataUrl } from '../lib/imageUtils';
import { REASONING_EFFORT_OPTIONS } from '../lib/constants';
import { replaceBBoxById } from '../lib/bboxGeometry';
import { SAMPLE_SCENES } from '../lib/sampleScenes';
import { renderSampleScene } from '../lib/sampleScenes';
import {
  clearWorkbench,
  deleteWorkbenchHazard,
  getWorkbenchSnapshot,
  patchWorkbenchResult,
  resetWorkbenchForFile,
  restoreWorkbench,
  setWorkbenchReasoningEffort,
  startWorkbenchAnalysis,
  subscribeWorkbench,
  type WorkbenchSnapshot,
} from '../lib/workbenchSession';

/**
 * 工程现场智能识别工作台。
 * 识别任务状态由模块级会话单例（lib/workbenchSession）持有：
 * 切换路由导致本组件卸载时任务不中断，重新挂载后自动恢复图片/进度/结果。
 */
export function Workbench({ modelName }: { modelName: string }) {
  const annotatorRef = useRef<AnnotatorHandle>(null);
  const [snap, setSnap] = useState<WorkbenchSnapshot>(getWorkbenchSnapshot);
  const [selectedHazardId, setSelectedHazardId] = useState<Hazard['id'] | null>(null);
  const [rightView, setRightView] = useState<'agent' | 'result'>('agent');
  const [showLabels, setShowLabels] = useState(true);
  const [drawerRef, setDrawerRef] = useState<StandardReference | null>(null);
  const [toast, setToast] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  // 挂载：订阅会话单例并恢复状态（内存会话 > 草稿/后端重连 > 上次结果）。
  // 注意：这里不做任何 abort —— 卸载时任务在会话单例中继续运行。
  useEffect(() => {
    setSnap(getWorkbenchSnapshot());
    const unsubscribe = subscribeWorkbench(setSnap);
    restoreWorkbench();
    return unsubscribe;
  }, []);

  const onFile = useCallback(async (f: File, scenario: string | null) => {
    const url = await fileToDataUrl(f);
    resetWorkbenchForFile({ file: f, previewUrl: url, imageName: f.name, imageSize: f.size, scenarioId: scenario });
    setSelectedHazardId(null);
    setRightView('agent');
  }, []);

  const onUseSample = useCallback(
    async (sceneId: string) => {
      const scene = SAMPLE_SCENES.find((s) => s.meta.id === sceneId);
      if (!scene) return;
      const { blob, dataUrl, scenarioId: sid } = await renderSampleScene(scene);
      const f = new File([blob], `${sceneId}-sample.png`, { type: 'image/png' });
      await onFile(f, sid);
      showToast('演示样例图已载入，可点击「AI 智能识别」');
    },
    [onFile, showToast]
  );

  const runAnalyze = useCallback(() => {
    if (!snap.previewUrl) return;
    setSelectedHazardId(null);
    setRightView('agent');
    void startWorkbenchAnalysis({ previewUrl: snap.previewUrl, imageName: snap.imageName, scenarioId: snap.scenarioId });
  }, [snap.previewUrl, snap.imageName, snap.scenarioId]);

  const onClear = useCallback(() => {
    clearWorkbench();
    setSelectedHazardId(null);
    setRightView('agent');
  }, []);

  const updateHazard = useCallback((hazardId: Hazard['id'], patch: Partial<Hazard>) => {
    patchWorkbenchResult((r) => {
      const hazards = r.hazards.map((h) => {
        if (h.id !== hazardId) return h;
        if (patch.grade && patch.grade !== h.grade) {
          return {
            ...h,
            ...patch,
            gradeReason: `${h.gradeReason} 人工复核将等级从 ${h.grade} 级调整为 ${patch.grade} 级（本地修订）。`,
            manualReviewRequired: true,
          };
        }
        return { ...h, ...patch };
      });
      const order = { A: 4, B: 3, C: 2, D: 1 } as const;
      const overallRisk = hazards.reduce<Hazard['grade'] | null>(
        (worst, hazard) => (!worst || order[hazard.grade] > order[worst] ? hazard.grade : worst),
        null
      );
      return { ...r, hazards, overallRisk, needManualReview: r.needManualReview || hazards.some((hazard) => hazard.manualReviewRequired) };
    });
  }, []);

  const updateHazardBBox = useCallback((hazardId: Hazard['id'], bbox: BBox) => {
    patchWorkbenchResult((result) => ({
      ...result,
      hazards: replaceBBoxById(result.hazards, hazardId, bbox),
    }));
  }, []);

  const deleteHazard = useCallback((hazardId: Hazard['id']) => {
    deleteWorkbenchHazard(hazardId);
    setSelectedHazardId((selected) => selected === hazardId ? null : selected);
    showToast('已删除该条隐患及其标注');
  }, [showToast]);

  const downloadHazardImage = useCallback((hazardId: Hazard['id']) => {
    const result = getWorkbenchSnapshot().result;
    const hazard = result?.hazards.find((item) => item.id === hazardId);
    if (!result || !hazard) return;
    try {
      const dataUrl = annotatorRef.current?.getDataUrl(hazardId);
      if (!dataUrl) {
        showToast('图片尚未就绪，请稍后重试');
        return;
      }
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `${result.analysisId}-隐患${String(hazard.index).padStart(2, '0')}-标注图.png`;
      link.click();
    } catch {
      showToast('标注图片下载失败，请重试');
    }
  }, [showToast]);

  const selectHazard = useCallback((hazardId: Hazard['id'] | null, scrollToCard = true) => {
    setSelectedHazardId(hazardId);
    if (hazardId !== null && scrollToCard) {
      requestAnimationFrame(() => {
        const hazard = getWorkbenchSnapshot().result?.hazards.find((item) => item.id === hazardId);
        if (hazard) {
          document.getElementById(`hazard-${hazard.index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
  }, []);

  const exportReport = useCallback(async () => {
    const result = getWorkbenchSnapshot().result;
    if (!result) return;
    try {
      const { html } = await postExportReport(result);
      const win = window.open('', '_blank');
      if (!win) {
        showToast('浏览器已阻止弹窗，请允许后重试，或使用下载方式');
        return;
      }
      win.document.write(html);
      win.document.close();
      win.focus();
      showToast('报告已在新窗口打开，可打印或另存为 PDF');
    } catch {
      showToast('导出报告失败');
    }
  }, [showToast]);

  const saveRecord = useCallback(async () => {
    const { result, previewUrl, imageName } = getWorkbenchSnapshot();
    if (!result || !previewUrl) return;
    const stored = previewUrl.length > 400_000 ? await downscaleForStorage(previewUrl) : previewUrl;
    addOrMergeLastRecord(result, { dataUrl: stored, name: imageName });
    showToast('已保存到「隐患记录」');
  }, [showToast]);

  const { phase, previewUrl, imageName, imageSize, runView, result, errorMsg } = snap;
  const hazards = result?.hazards ?? [];

  useEffect(() => {
    if (selectedHazardId !== null && !hazards.some((hazard) => hazard.id === selectedHazardId)) {
      setSelectedHazardId(null);
    }
  }, [hazards, selectedHazardId]);

  // 旧版已保存结果可能没有可回放的 runId：避免 Agent 页签出现空白。
  useEffect(() => {
    if (rightView === 'agent' && result && !runView.runId) setRightView('result');
    if (rightView === 'result' && !result) setRightView('agent');
  }, [result, rightView, runView.runId]);

  return (
    <div className="page">
      <div className="page-head wb-page-head">
        <div className="wb-page-title">
          <h1>工程现场智能识别</h1>
          <div className="sub">上传工程现场图片，AI 将结合标准法规及历史案例自动识别安全隐患，并完成 A/B/C/D 智能定级与整改建议。</div>
        </div>

        {/* 思考强度（DeepSeek reasoning effort）：默认 low；切换后立即持久化并作用于下一次识别请求。 */}
        <div className="wb-page-tools">
          <div className="wb-view-switch" role="tablist" aria-label="右侧内容视图">
            <button
              type="button"
              role="tab"
              aria-selected={rightView === 'agent'}
              aria-disabled={Boolean(result && !runView.runId)}
              className={rightView === 'agent' ? 'active' : ''}
              disabled={Boolean(result && !runView.runId)}
              onClick={() => setRightView('agent')}
            >
              <IconRoute size={15} />
              Agent 流
              {(phase === 'analyzing' || runView.status === 'connecting' || runView.status === 'streaming') && (
                <span className="wb-view-live" aria-label="运行中" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightView === 'result'}
              aria-disabled={!result}
              className={rightView === 'result' ? 'active' : ''}
              disabled={!result}
              onClick={() => setRightView('result')}
            >
              <IconChartBar size={15} />
              结果
              {result && <span className="wb-view-count">{result.hazards.length}</span>}
            </button>
          </div>

          <div className="wb-effort-picker">
            <label htmlFor="reasoning-effort">思考强度</label>
            <select
              id="reasoning-effort"
              className="select"
              value={snap.reasoningEffort}
              onChange={(e) => setWorkbenchReasoningEffort(e.target.value as ReasoningEffort)}
            >
              {REASONING_EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="workbench">
        <div className="left-col">
          <ImagePanel
            annotatorRef={annotatorRef}
            previewUrl={previewUrl}
            imageName={imageName}
            imageSize={imageSize}
            hazards={hazards}
            phase={phase}
            selectedHazardId={selectedHazardId}
            showLabels={showLabels}
            exportFileName={result?.analysisId}
            onFile={onFile}
            onUseSample={onUseSample}
            onClear={onClear}
            onSelectHazard={selectHazard}
            onChangeBBox={updateHazardBBox}
            onToggleLabels={setShowLabels}
          />

          {/* 复核 / 免责提示：随识别结果展示，位于图片卡片（含文件信息）正下方，宽度与卡片一致。 */}
          {(phase === 'done' || phase === 'empty') && result && (
            <>
              {(result.needManualReview || result.agentMeta?.fallbackUsed) && (
                <div className="disclaimer-bar" style={{ marginBottom: 12 }}>
                  <IconAlert size={14} />
                  {result.agentMeta?.fallbackUsed
                    ? `本次运行启用了保守降级：${result.agentMeta.fallbackReason ?? '模型推理不可用'}；结果必须人工复核。`
                    : '本次结果存在证据不足、规则命中或引用校验条件，请由专业安全人员人工复核。'}
                </div>
              )}

              {result.disclaimer && <div className="disclaimer-bar" style={{ marginBottom: 12 }}>{result.disclaimer}</div>}
            </>
          )}
        </div>

        <div className="right-col">
          {(phase === 'idle' || phase === 'ready') && (
            <div className="card card-pad" style={{ textAlign: 'center' }}>
              <div className="state-block" style={{ padding: '12px 8px 8px' }}>
                <div className="big-ico"><IconAnalyze size={28} /></div>
                <h3>{phase === 'ready' ? '图片已就绪，等待智能识别' : '上传图片开始智能识别'}</h3>
                <p style={{ marginTop: 6, fontSize: 13 }}>
                  当前为 AI 模式{modelName ? `（${modelName}）` : ''}：将调用真实多模态模型分析图像并检索本项目知识库。
                </p>
                <div className="state-actions">
                  <button className="btn btn-primary btn-lg" disabled={!previewUrl} onClick={runAnalyze}>
                    <IconAnalyze size={16} />
                    AI 智能识别
                  </button>
                </div>
              </div>
            </div>
          )}

          {rightView === 'agent' && (phase === 'analyzing' || ((phase === 'done' || phase === 'empty' || phase === 'error') && Boolean(runView.runId))) && (
            <AnalysisProgress run={runView} modelName={modelName} reattached={snap.reattached} />
          )}

          {rightView === 'agent' && phase === 'error' && (
            <div className="card card-pad">
              <div className="state-block">
                <div className="big-ico" style={{ color: 'var(--danger)', background: '#fdecea' }}>
                  <IconXCircle size={28} />
                </div>
                <h3>AI 服务暂时不可用</h3>
                <p>{errorMsg || '模型调用失败，请稍后重试。'}</p>
                <div className="state-actions">
                  <button className="btn btn-primary" onClick={runAnalyze}>
                    <IconAlert size={14} />
                    重新分析
                  </button>
                </div>
              </div>
            </div>
          )}

          {rightView === 'result' && (phase === 'done' || phase === 'empty') && result && (
            <>
              <AnalysisSummary result={result} onReAnalyze={runAnalyze} onExport={() => void exportReport()} onSave={() => void saveRecord()} />

              {phase === 'empty' && (
                <div className="card card-pad">
                  <div className="state-block">
                    <div className="big-ico"><IconCheckCircleIcon /></div>
                    <h3>当前没有隐患记录</h3>
                    <p>您仍可下载报告存档或重新上传图片分析。</p>
                  </div>
                </div>
              )}

              {phase === 'done' &&
                result.hazards.map((h) => {
                  return (
                    <HazardCard
                      key={h.id}
                      hazard={h}
                      active={selectedHazardId === h.id}
                      onSelect={() => selectHazard(selectedHazardId === h.id ? null : h.id, false)}
                      onUpdateHazard={(patch) => updateHazard(h.id, patch)}
                      onDelete={() => deleteHazard(h.id)}
                      onDownloadImage={() => downloadHazardImage(h.id)}
                      onOpenReference={setDrawerRef}
                    />
                  );
                })}
            </>
          )}
        </div>
      </div>

      <EvidenceDrawer open={Boolean(drawerRef)} reference={drawerRef} onClose={() => setDrawerRef(null)} />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export type { RunViewState } from '../lib/workbenchSession';

function IconCheckCircleIcon() {
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}
