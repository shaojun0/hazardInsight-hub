import { useCallback, useState } from 'react';
import { FindingsList } from '../components/FindingsList';
import { IconCheck, IconRobot, IconRoute } from '../components/icons';
import { addLedgerItems } from '../lib/ledger';
import {
  analyzeFrame,
  captureFrame,
  MOCK_ROBOTS,
  resultToFindings,
  sleep,
  type Finding,
  type MockRobot,
} from '../lib/discovery';
import { createAgentTaskId } from '../agent/session';

interface PatrolState {
  running: boolean;
  robot: MockRobot | null;
  total: number;
  done: number;
  stations: Array<{ point: string; sceneId: string; status: 'pending' | 'active' | 'done'; found: number }>;
  image: string | null;
}

/** 隐患发现 · 具身智能机器人寻隐患：单页机器人自动巡检，多点位画面分析、进度与结果汇总。 */
export function RobotDiscover() {
  const [activeRobot, setActiveRobot] = useState<MockRobot | null>(null);
  const [patrol, setPatrol] = useState<PatrolState>({ running: false, robot: null, total: 0, done: 0, stations: [], image: null });

  const [phase, setPhase] = useState<'idle' | 'working' | 'done'>('idle');
  const [status, setStatus] = useState('选择一台机器人，开始自动巡检');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [toast, setToast] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const addAll = useCallback(() => {
    if (!findings.length) return;
    const items = findings.map((f) => ({
      id: `ledger-robot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      source: 'robot' as const,
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
          id: `ledger-robot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          source: 'robot' as const,
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

  const startPatrol = useCallback(async () => {
    const robot = activeRobot;
    if (!robot || patrol.running) return;
    setPhase('working');
    setFindings([]);
    const stations = robot.route.map((s) => ({ point: s.point, sceneId: s.sceneId, status: 'pending' as const, found: 0 }));
    setPatrol({ running: true, robot, total: stations.length, done: 0, stations, image: null });
    const all: Finding[] = [];
    const taskId = createAgentTaskId();
    let doneCount = 0;
    for (let i = 0; i < stations.length; i += 1) {
      setPatrol((p) => ({
        ...p,
        stations: p.stations.map((s, j) => (j === i ? { ...s, status: 'active' as const } : s)),
        image: null,
      }));
      setStatus(`巡检 ${robot.code} · ${robot.route[i].point}：正在抓取画面分析…`);
      try {
        const f = await captureFrame(robot.route[i].sceneId);
        const result = await analyzeFrame(f, { source: 'robot', deviceId: robot.id, stationId: robot.route[i].point, taskId });
        const found = resultToFindings(result, { dataUrl: f.dataUrl, name: `${robot.code}-${robot.route[i].point}.png` });
        all.push(...found);
        doneCount += 1;
        setPatrol((p) => ({
          ...p,
          done: doneCount,
          image: f.dataUrl,
          stations: p.stations.map((s, j) => (j === i ? { ...s, status: 'done' as const, found: found.length } : s)),
        }));
        setStatus(`巡检 ${robot.code} · ${robot.route[i].point}：发现 ${found.length} 处（${doneCount}/${stations.length}）`);
        await sleep(1000);
      } catch {
        doneCount += 1;
        setPatrol((p) => ({ ...p, done: doneCount }));
      }
    }
    setFindings(all);
    setStatus(all.length ? `巡检完成，累计发现 ${all.length} 处隐患，已汇总展示` : '巡检完成，未发现明确安全隐患');
    setPatrol((p) => ({ ...p, running: false }));
    setPhase('done');
  }, [activeRobot, patrol.running]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>具身智能机器人寻隐患</h1>
        <div className="sub">具身智能机器人按路线自动巡检工程现场，逐点位抓取画面分析，汇总识别结果并转入隐患台账闭环管理。</div>
      </div>

      <div className="workbench">
        <div className="left-col">
          <div className="card wb-img-card">
            <div className="wb-img-head">
              <span className="title">具身智能巡检机器人</span>
              <span className="chip">{MOCK_ROBOTS.length} 台在役</span>
            </div>
            <div className="wb-img-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 14 }}>
                {MOCK_ROBOTS.map((rob) => (
                  <button
                    key={rob.id}
                    className={`btn ${activeRobot?.id === rob.id ? 'btn-primary-soft' : 'btn-outline'}`}
                    style={{ height: 'auto', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '10px 12px', textAlign: 'left' }}
                    onClick={() => {
                      setActiveRobot(rob);
                      setFindings([]);
                      setPhase('idle');
                      setPatrol({ running: false, robot: null, total: 0, done: 0, stations: [], image: null });
                      setStatus(`${rob.code} 已就绪，点击「开始巡检」`);
                    }}
                  >
                    <span className="row" style={{ width: '100%', justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{rob.code} · {rob.name}</span>
                      <span className="chip" style={{ fontSize: 11, height: 18 }}>电量 {rob.battery}%</span>
                    </span>
                    <span className="small muted">负责区域：{rob.area} · 巡检点位 {rob.route.length} 个</span>
                  </button>
                ))}
              </div>

              <div className="image-wrap" style={{ minHeight: 200 }}>
                {patrol.image ? <img src={patrol.image} alt="巡检画面" style={{ maxWidth: '100%', maxHeight: 300 }} /> : (
                  <span className="muted" style={{ color: '#9aa0aa' }}>巡检实时画面</span>
                )}
              </div>

              {activeRobot && (
                <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
                  <span className="chip"><IconRoute size={12} /> 路线：{activeRobot.route.map((r) => r.point).join(' → ')}</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn btn-primary" disabled={patrol.running || phase === 'working'} onClick={() => void startPatrol()}>
                    <IconRobot size={14} />
                    {patrol.running ? '巡检中…' : '开始巡检'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="card card-pad" style={{ marginTop: 12 }}>
            <b className="small" style={{ color: 'var(--navy)' }}>巡检进度</b>
            {patrol.total > 0 && (
              <div className="progress-bar-track" style={{ marginTop: 10 }}>
                <div className="progress-bar-fill" style={{ width: `${Math.round((patrol.done / patrol.total) * 100)}%` }} />
              </div>
            )}
            <div className="step-list" style={{ marginTop: 12, gap: 8 }}>
              {patrol.stations.map((s, i) => (
                <div className={`step-item ${s.status === 'done' ? 'done' : s.status === 'active' ? 'active' : 'pending'}`} key={i}>
                  <span className="step-state">
                    {s.status === 'done' ? <IconCheck size={13} /> : s.status === 'active' ? <span className="spinner" /> : <span style={{ fontSize: 12 }}>{i + 1}</span>}
                  </span>
                  {s.point}
                  {s.status === 'done' && <span className="small muted">发现 {s.found} 处</span>}
                </div>
              ))}
              {patrol.total === 0 && <span className="small muted">选择机器人后开始巡检，展示各点位进度。</span>}
            </div>
          </div>
        </div>

        <div className="right-col">
          <div className="card card-pad">
            <div className="spread" style={{ marginBottom: 6 }}>
              <b style={{ color: 'var(--navy)' }}>机器人巡检结果汇总</b>
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
              sourceLabel="机器人"
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
