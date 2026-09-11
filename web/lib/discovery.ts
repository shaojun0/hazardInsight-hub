/**
 * 隐患发现：固定摄像头 / 具身智能机器人 的 Mock 设备源与抓拍-识别辅助。
 * 识别仍走真实 /api/analyze 链路（法规检索、案例匹配、定级一致）。
 * 摄像头 / 机器人源抽象：未来可替换为企业视频平台 / 机器人导航调度平台。
 */
import type { AnalysisResult, BBox, Grade, Hazard } from '../../shared/types';
import { analyzeImage } from '../api/analysis';
import { SAMPLE_SCENES, renderSampleScene } from './sampleScenes';

export interface MockCamera {
  id: string;
  code: string;
  name: string;
  location: string;
  sceneId: string;
  status: 'online' | 'offline';
}

export interface MockRobot {
  id: string;
  code: string;
  name: string;
  area: string;
  battery: number;
  route: Array<{ point: string; sceneId: string }>;
}

export const MOCK_CAMERAS: MockCamera[] = [
  { id: 'cam-1', code: 'CAM-01', name: '核岛外侧摄像机', location: '核岛脚手架及临边区域', sceneId: 'scaffold', status: 'online' },
  { id: 'cam-2', code: 'CAM-02', name: '临时配电间摄像机', location: '临时用电配电区域', sceneId: 'workshop', status: 'online' },
  { id: 'cam-3', code: 'CAM-03', name: '现场办公区摄像机', location: '现场办公及用电集中区域', sceneId: 'desk', status: 'online' },
  { id: 'cam-4', code: 'CAM-04', name: '通道文明施工摄像机', location: '主通道与材料堆场区域', sceneId: 'clean', status: 'offline' },
];

export const MOCK_ROBOTS: MockRobot[] = [
  {
    id: 'rob-1',
    code: 'ROB-A1',
    name: '巡检机器人 A1',
    area: '核岛 A 区',
    battery: 86,
    route: [
      { point: '配电间', sceneId: 'workshop' },
      { point: '脚手架区', sceneId: 'scaffold' },
      { point: '整洁通道', sceneId: 'clean' },
      { point: '办公用电区', sceneId: 'desk' },
    ],
  },
  {
    id: 'rob-2',
    code: 'ROB-B2',
    name: '巡检机器人 B2',
    area: '综合厂房',
    battery: 64,
    route: [
      { point: '办公区', sceneId: 'desk' },
      { point: '通道', sceneId: 'clean' },
      { point: '装配配电区', sceneId: 'workshop' },
    ],
  },
];

function sceneMeta(sceneId: string) {
  return SAMPLE_SCENES.find((s) => s.meta.id === sceneId)?.meta ?? SAMPLE_SCENES[0].meta;
}

export interface CapturedFrame {
  file: File;
  dataUrl: string;
  scenarioId: string;
  sceneId: string;
}

/** 抓拍一帧（将内置演示场景渲染为 PNG 供识别；真实对接时为设备帧）。 */
export async function captureFrame(sceneId: string): Promise<CapturedFrame> {
  const meta = sceneMeta(sceneId);
  const { blob, dataUrl, scenarioId } = await renderSampleScene(SAMPLE_SCENES.find((s) => s.meta.id === sceneId)!);
  const file = new File([blob], `${sceneId}-${meta.id}.png`, { type: 'image/png' });
  return { file, dataUrl, scenarioId, sceneId };
}

/** 抓拍帧 -> 分析。 */
export async function analyzeFrame(
  frame: CapturedFrame,
  context: { source: 'camera' | 'robot'; deviceId?: string; stationId?: string; taskId?: string }
): Promise<AnalysisResult> {
  const resp = await analyzeImage(frame.file, frame.scenarioId, context);
  return resp.data;
}

export interface Finding {
  id: string;
  title: string;
  category: string;
  grade: Grade;
  confidence: number;
  description: string;
  possibleConsequence: string;
  evidence: string[];
  rectificationTexts: string[];
  bbox: BBox | null;
  image?: { dataUrl: string; name: string };
}

export function resultToFindings(result: AnalysisResult, image?: { dataUrl: string; name: string }): Finding[] {
  return (result.hazards ?? []).map((h: Hazard) => ({
    id: `${result.analysisId}-${h.id}`,
    title: h.title,
    category: h.category,
    grade: h.grade,
    confidence: h.confidence,
    description: h.description,
    possibleConsequence: h.possibleConsequence,
    evidence: h.evidence,
    rectificationTexts: h.rectification.map((r) => r.text),
    bbox: h.bbox,
    image,
  }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
