/**
 * 核电工程隐患智能识别与定级系统 - 共享领域类型
 * 服务端(tsx)与前端(Vite)共同使用；服务端通过 Zod 校验其落地形态。
 */

/** 知识来源类型 */
export type StandardType = 'general' | 'nuclear' | 'enterprise';

/** A/B/C/D 隐患等级 */
export type Grade = 'A' | 'B' | 'C' | 'D';

/** 0~1 归一化坐标边界框 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 标准条款 */
export interface StandardClause {
  id: string;
  type: StandardType;
  documentName: string;
  documentCode: string;
  version: string;
  clause: string;
  clauseTitle: string;
  content: string;
  category: string;
  keywords: string[];
}

/** 标准文档（知识库列表展示用） */
export interface StandardDocument {
  id: string;
  type: StandardType;
  documentName: string;
  documentCode: string;
  version: string;
  status: string;
  updatedAt: string;
  category: string;
  clauseCount: number;
}

/** 隐患引用的一条标准依据 */
export interface StandardReference {
  type: StandardType;
  documentName: string;
  documentCode: string;
  version: string;
  clause: string;
  clauseTitle: string;
  content: string;
  category: string;
  relevance: number;
  reason: string;
}

/** 历史隐患案例 */
export interface HistoricalCase {
  caseId: string;
  project: string;
  date: string;
  category: string;
  description: string;
  grade: Grade;
  rectification: string;
  result: string;
  keywords: string[];
}

/** 隐患引用的历史相似案例 */
export interface HistoricalReference {
  caseId: string;
  similarity: number;
  description: string;
  grade: Grade;
  ref: HistoricalCase;
  similarityReason: string;
}

/** 导入的领域判定规则引用。level 是规则分类，不等同于 A/B/C/D 风险等级。 */
export interface RuleReference {
  ruleId: string;
  code: string;
  level: string;
  levelName: string;
  categoryPath: string;
  text: string;
  starred: boolean;
  relevance: number;
  reason: string;
}

/** 整改措施类型 */
export type RectificationKind = 'immediate' | 'corrective' | 'preventive';

export interface RectificationItem {
  kind: RectificationKind;
  text: string;
}

/** 单条隐患完整结果 */
export interface Hazard {
  id: string;
  index: number;
  title: string;
  category: string;
  description: string;
  confidence: number;
  bbox: BBox;
  evidence: string[];
  possibleConsequence: string;
  grade: Grade;
  gradeReason: string;
  severityScore: number;
  probabilityScore: number;
  riskScore: number;
  /** Evidence-linked decision record; optional for older saved results. */
  gradingTrace?: import('./risk-assessment').GradingTrace;
  standardReferences: StandardReference[];
  historicalReferences: HistoricalReference[];
  /** v2 可选字段，兼容浏览器中已保存的 v1 分析结果。 */
  ruleReferences?: RuleReference[];
  rectification: RectificationItem[];
  manualReviewRequired: boolean;
}

/** 一次完整分析结果 */
export interface AnalysisResult {
  analysisId: string;
  imageSummary: string;
  overallRisk: Grade | null;
  needManualReview: boolean;
  hazards: Hazard[];
  stats: {
    standardsCited: number;
    casesCited: number;
  };
  mode: 'ai';
  modelName: string | null;
  disclaimer: string;
  createdAt: string;
  /** Agent Runtime 元数据；旧结果没有该字段时仍可正常展示。 */
  agentMeta?: import('./agent-protocol.js').AnalysisAgentMeta;
}

/** 分析进度步骤 */
export interface AnalysisStep {
  key: string;
  label: string;
}

/** 定级元信息 */
export interface GradeMeta {
  grade: Grade;
  label: string;
  short: string;
  tone: 'critical' | 'major' | 'general' | 'minor';
  color: string;
  bg: string;
  border: string;
}

/**
 * 隐患判定规则（来自 TXT 导入的行业判定规则）。
 * 样例格式：`<级别> <一级类目> <二级类目> [三级类目] <编码>[星标]<判定内容>`
 * 例如：`b 现场作业 隧道作业 作业规程和要求 BSD07*未及时维护盾尾密封装置...`
 */
export interface GradingRule {
  id: string;
  level: string;
  levelName: string;
  categories: string[];
  categoryPath: string;
  code: string;
  starred: boolean;
  text: string;
  source: 'imported';
  importedAt: string;
}
