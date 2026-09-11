import type { AgentUiStage } from '../../shared/agent-protocol';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/agent-protocol';
import type { Grade, GradeMeta, RectificationItem } from '../../shared/types';

/**
 * 思考强度下拉选项（与共享层 REASONING_EFFORTS 保持同一顺序与取值）。
 * 默认值 = low，见 workbenchSession.freshSnapshot / 后端 runtime 校验回退。
 */
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{ label: string; value: ReasoningEffort }> = [
  { label: '低', value: REASONING_EFFORTS[0] },
  { label: '高', value: REASONING_EFFORTS[1] },
  { label: '最大', value: REASONING_EFFORTS[2] },
];

export const GRADE_META: Record<Grade, GradeMeta> = {
  A: { grade: 'A', label: '重大隐患', short: 'A级', tone: 'critical', color: '#b42318', bg: '#fdecea', border: '#f5b6ae' },
  B: { grade: 'B', label: '较大隐患', short: 'B级', tone: 'major', color: '#c2410c', bg: '#fff4e6', border: '#ffd9a8' },
  C: { grade: 'C', label: '一般隐患', short: 'C级', tone: 'general', color: '#a16207', bg: '#fffbeb', border: '#fde68a' },
  D: { grade: 'D', label: '轻微问题', short: 'D级', tone: 'minor', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
};

export const GRADE_ORDER: Grade[] = ['A', 'B', 'C', 'D'];

export const ANALYSIS_STEPS: Array<{ stage: AgentUiStage; label: string }> = [
  { stage: 'preflight', label: '校验图片与运行配置' },
  { stage: 'vision', label: '解析图像并提取作业特征' },
  { stage: 'retrieval', label: '检索标准法规与历史案例' },
  { stage: 'rules', label: '匹配施工场景风险规则' },
  { stage: 'context', label: '构建受控分析上下文' },
  { stage: 'reasoning', label: '调用大模型判断并生成整改建议' },
  { stage: 'validation', label: '校验隐患等级、依据与引用' },
  { stage: 'assemble', label: '生成最终结果与公开摘要' },
];

export const ANALYSIS_STAGE_LOG: Record<AgentUiStage, { started: string; completed: string }> = {
  preflight: { started: '正在校验图片格式、大小与运行配置', completed: '图片与运行配置校验完成' },
  vision: { started: '视觉模型正在解析图像并提取作业特征', completed: '图像解析与候选隐患提取完成' },
  retrieval: { started: '正在检索相关标准法规与历史案例', completed: '标准法规与历史案例检索完成' },
  rules: { started: '正在匹配施工场景风险规则', completed: '施工场景风险规则匹配完成' },
  context: { started: '正在构建最小化、受控的分析上下文', completed: '受控分析上下文构建完成' },
  reasoning: { started: '正在调用大模型进行风险判断', completed: '模型风险判断与整改建议生成完成' },
  validation: { started: '正在校验风险等级、引用和规则约束', completed: '风险等级与判定依据校验完成' },
  assemble: { started: '正在生成最终结果与用户可见摘要', completed: '最终结构化结果生成完成' },
};

export const CATEGORY_OPTIONS = [
  '全部',
  '临时用电', '电缆线路', '高处作业', '脚手架', '临边洞口', '起重吊装',
  '消防', '动火作业', 'PPE防护', '设备防护', '通道堵塞', '材料堆放',
  '液体泄漏', '易燃物', '工器具', '机械设备', '文明施工', '核电现场', '其他',
];

export const STANDARD_TYPE_LABEL: Record<string, string> = {
  general: '通用标准',
  nuclear: '核电专用标准',
  enterprise: '企业文件',
};

export const TYPE_TAG_LABEL: Record<string, string> = {
  general: '通用标准',
  nuclear: '核电专用',
  enterprise: '企业文件',
};

export const RECT_KIND_LABEL: Record<RectificationItem['kind'], string> = {
  immediate: '立即措施',
  corrective: '整改措施',
  preventive: '预防措施',
};

export const RECT_KIND_COLOR: Record<RectificationItem['kind'], string> = {
  immediate: '#e0342f',
  corrective: '#e97a1f',
  preventive: '#1d63ed',
};

export const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];

/** 工作台阶段 */
export type Phase = 'idle' | 'ready' | 'analyzing' | 'done' | 'empty' | 'error';

/** 综合所有风险的展示描述 */
export function overallRiskText(hazardsCount: number, grade: Grade | null): string {
  if (hazardsCount === 0) return '未定级';
  return grade ? `${grade} 级` : '未定级';
}
