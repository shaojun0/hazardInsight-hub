import { useCallback, useRef, useState } from 'react';
import { FindingsList } from '../components/FindingsList';
import { IconZap } from '../components/icons';
import { addLedgerItems } from '../lib/ledger';
import {
  analyzeFrame,
  captureFrame,
  MOCK_CAMERAS,
  resultToFindings,
  type CapturedFrame,
  type Finding,
  type MockCamera,
} from '../lib/discovery';

/** 隐患发现 · 固定摄像头抓隐患：单页固定摄像头抓拍识别。 */
export function CameraDiscover() {
  const [activeCam, setActiveCam] = useState<MockCamera | null>(null);

  const [phase, setPhase] = useState<'idle' | 'working' | 'done'>('idle');
  const [status, setStatus] = useState('选择一台固定摄像头，开始抓拍识别');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [frame, setFrame] = useState<CapturedFrame | null>(null);
  const [toast, setToast] = useState('');
  const busyRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const addAll = useCallback(() => {
    if (!findings.length) return;
    const items = findings.map((f) => ({
      id: `ledger-camera-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      source: 'camera' as const,
      title: f.title,
      category: f.category,
      description: f.description,
      possibleConsequence: f.possibleConsequence,
      evidence: f.evidence,
      rectificationTexts: f.rectificationTexts,
      grade: f.grade,
      confidence: f.confidence,
      image: f.image,
      foundAt: new Date().toISOString(),
      status: 'pending' as const,
    }));
    addLedgerItems(items);
    showToast(`已将 ${items.length} 项隐患转入台账`);
  }, [findings, showToast]);

  const addOne = useCallback(
    (f: Finding) => {
      addLedgerItems([
        {
          id: `ledger-camera-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          source: 'camera' as const,
          title: f.title,
          category: f.category,
          description: f.description,
          possibleConsequence: f.possibleConsequence,
          evidence: f.evidence,
          rectificationTexts: f.rectificationTexts,
          grade: f.grade,
          confidence: f.confidence,
          image: f.image,
          foundAt: new Date().toISOString(),
          status: 'pending' as const,
        },
      ]);
      showToast('已转入隐患台账');
    },
    [showToast]
  );

  const selectCamera = useCallback((cam: MockCamera) => {
    setActiveCam(cam);
    setFindings([]);
    setFrame(null);
    setPhase('idle');
    setStatus(`${cam.code} 已就绪，点击「抓拍并识别」`);
  }, []);

  const triggerCamera = useCallback(async () => {
    const cam = activeCam;
    if (!cam || busyRef.current) return;
    if (cam.status === 'offline') {
      setStatus(`${cam.code} 离线，画面不可用，请检查设备后重试。`);
      return;
    }
    busyRef.current = true;
    setPhase('working');
    setFindings([]);
    setStatus(`正在抓拍 ${cam.code} 画面并进行智能识别…`);
    try {
      const f = await captureFrame(cam.sceneId);
      setFrame(f);
      const result = await analyzeFrame(f, { source: 'camera', deviceId: cam.id });
      setFindings(resultToFindings(result, { dataUrl: f.dataUrl, name: `${cam.code}-${cam.location}.png` }));
      setStatus(result.hazards.length ? `${cam.code} 识别完成，发现 ${result.hazards.length} 处隐患` : `${cam.code} 未发现明确安全隐患`);
    } catch (e) {
      setStatus(`识别失败：${(e as Error).message}`);
    }
    setPhase('done');
    busyRef.current = false;
  }, [activeCam]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>固定摄像头抓隐患</h1>
        <div className="sub">固定摄像头定点抓拍工程现场画面，自动识别安全隐患，并转入隐患台账闭环管理。</div>
      </div>

      <div className="workbench">
        <div className="left-col">
          <div className="card wb-img-card">
            <div className="wb-img-head">
              <span className="title">固定摄像头</span>
              <span className="chip">{MOCK_CAMERAS.filter((c) => c.status === 'online').length} 台在线</span>
            </div>
            <div className="wb-img-body">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                {MOCK_CAMERAS.map((cam) => (
                  <button
                    key={cam.id}
                    className={`btn ${activeCam?.id === cam.id ? 'btn-primary-soft' : 'btn-outline'}`}
                    style={{ height: 'auto', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 12px', textAlign: 'left' }}
                    onClick={() => selectCamera(cam)}
                  >
                    <span className="row" style={{ width: '100%', justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{cam.code}</span>
                      <span
                        style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: cam.status === 'online' ? 'var(--ok)' : 'var(--text-3)',
                        }}
                      />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{cam.name}</span>
                    <span className="small muted">{cam.location}</span>
                  </button>
                ))}
              </div>

              {activeCam && (
                <>
                  <div className="image-wrap" style={{ minHeight: 200 }}>
                    {frame ? <img src={frame.dataUrl} alt="抓拍画面" style={{ maxWidth: '100%', maxHeight: 300 }} /> : (
                      <span className="muted" style={{ color: '#9aa0aa' }}>未抓拍，点击下方按钮获取实时画面</span>
                    )}
                  </div>
                  {activeCam.status === 'offline' && (
                    <div className="disclaimer-bar" style={{ marginTop: 8 }}>{activeCam.code} 设备离线，无法抓拍。</div>
                  )}
                  <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                    <span className="muted small" style={{ flex: 1 }}>当前设备：{activeCam.code} · {activeCam.name}</span>
                    <button className="btn btn-primary" disabled={phase === 'working'} onClick={() => void triggerCamera()}>
                      <IconZap size={14} />
                      {phase === 'working' ? '识别中…' : '抓拍并识别'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="right-col">
          <div className="card card-pad">
            <div className="spread" style={{ marginBottom: 6 }}>
              <b style={{ color: 'var(--navy)' }}>摄像头抓拍结果</b>
              <span className="mode-chip ai">
                <span className="dot" />
                AI 模式
              </span>
            </div>
            <span className="small muted">{status}</span>
            {phase === 'working' && (
              <div className="progress-bar-track" style={{ marginTop: 12 }}>
                <div className="progress-bar-fill" style={{ width: '100%' }} />
              </div>
            )}
          </div>

          <div className="card card-pad">
            <FindingsList
              findings={findings}
              sourceLabel="摄像头"
              onAddAll={addAll}
              onAddOne={addOne}
            />
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
