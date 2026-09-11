/**
 * 聚类分析的共享类型定义。
 *
 * 与后端 Python 网关的 Pydantic 契约（`backend/python/app/schemas/clustering.py`）
 * 逐字段对齐：Python 侧是唯一事实来源，这里只做镜像，不额外发明字段。
 *
 * 统一响应包裹（`success / data / error`）由 `web/api/clustering.ts` 拆封，
 * 页面拿到的都是业务数据本体，不需要关心 `success` 字段。
 */

/** 后端统一错误结构。 */
export interface ClusterApiErrorInfo {
  /** 机器可读错误码，例如 `INVALID_INPUT`、`ENGINE_UNAVAILABLE`。 */
  code: string;
  /** 面向用户的中文错误描述。 */
  message: string;
  /** 请求追踪 ID，便于在后端日志中定位。 */
  request_id?: string | null;
  /** 可选的补充细节。 */
  detail?: string | null;
}

/** 一条待聚类的样本。 */
export interface ClusteringDatasetItem {
  /** 样本唯一 ID。 */
  id: string;
  /** 参与聚类的文本。 */
  text: string;
  /** 随样本展示的业务字段（隐患级别、作业区域等）。 */
  metadata: Record<string, unknown>;
}

/** 二维可视化降维方式。 */
export type ClusterReduceMethod = 'pca' | 'none';

/** 聚类执行选项。算法由后端的 profile 决定，前端不虚构算法超参。 */
export interface ClusteringRunOptions {
  /** 指定 profile；留空则由后端按算法偏好自动挑选。 */
  profileId?: string | null;
  /** 按算法名自动挑选可用 profile。 */
  algorithm?: string | null;
  /** 是否计算二维可视化坐标。 */
  visualize?: boolean;
  /** 二维降维方式。 */
  reduceMethod?: ClusterReduceMethod;
}

/** 聚类请求体。 */
export interface ClusteringRunRequest {
  items: ClusteringDatasetItem[];
  options: ClusteringRunOptions;
}

/** 一个可用 profile 的描述。 */
export interface ClusteringProfileInfo {
  profileId: string;
  algorithm: string;
  modelId: string;
  knowledgeBaseId?: string | null;
  features: Record<string, unknown>;
  algorithmParams: Record<string, unknown>;
  implementationVersion: string;
  maxSamples: number;
  available: boolean;
  /** 不可用原因；`available` 为 true 时通常为空。 */
  unavailableReason?: string | null;
  warnings: string[];
}

/** 一种聚类算法的可用性。 */
export interface ClusteringAlgorithmInfo {
  algorithm: string;
  available: boolean;
  /** 实现后端，例如 `sklearn`、`hdbscan`、`inhouse`。 */
  backend: string;
  implementationVersion: string;
  maxSamples: number;
  warnings: string[];
}

/** 数据文件解析结果。 */
export interface ClusteringDatasetPreview {
  sourceName: string;
  total: number;
  warnings: string[];
  items: ClusteringDatasetItem[];
}

/** 元数据取值计数。 */
export interface ClusteringValueCount {
  value: string;
  count: number;
}

/** 簇的代表样本（离质心最近的若干条）。 */
export interface ClusteringRepresentativeSample {
  id: string;
  text: string;
  /** 与簇质心的余弦相似度映射到 0~1。 */
  confidence?: number | null;
  /** 到簇质心的欧氏距离。 */
  distance?: number | null;
}

/** 一个簇的聚合描述。 */
export interface ClusteringClusterGroup {
  /** `-1` 表示噪声点。 */
  clusterId: number;
  label: string;
  size: number;
  keywords: string[];
  /** 簇内平均余弦相似度。 */
  cohesion?: number | null;
  representativeSamples: ClusteringRepresentativeSample[];
  metadataDistribution: Record<string, ClusteringValueCount[]>;
}

/** 单条样本的聚类归属。 */
export interface ClusteringResultItem {
  id: string;
  text: string;
  clusterId: number;
  clusterLabel: string;
  /** 与簇质心的余弦相似度映射到 0~1。 */
  confidence?: number | null;
  /** 到簇质心的欧氏距离。 */
  distance?: number | null;
  keywords: string[];
  metadata: Record<string, unknown>;
}

/** 二维散点坐标（仅用于可视化，不参与聚类计算）。 */
export interface ClusteringVisualizationPoint {
  id: string;
  x: number;
  y: number;
  clusterId: number;
}

/** 聚类统计。 */
export interface ClusteringSummary {
  runId: string;
  totalSamples: number;
  clusterCount: number;
  noiseCount: number;
  largestClusterSize: number;
  smallestClusterSize: number;
  avgClusterSize: number;
  algorithm: string;
  profileId: string;
  modelId: string;
  implementationVersion: string;
  embeddingDimension: number;
  cacheHit: boolean;
  /** cluster-engine 报告的算法耗时（毫秒）。 */
  elapsedMs: number;
  /** 网关总耗时（含可视化加工，毫秒）。 */
  gatewayMs: number;
  warnings: string[];
}

/** 聚类结果主体。 */
export interface ClusteringData {
  summary: ClusteringSummary;
  clusters: ClusteringClusterGroup[];
  items: ClusteringResultItem[];
  visualization: ClusteringVisualizationPoint[];
}

/** 内置示例数据。 */
export interface ClusteringSampleData {
  sourceName: string;
  items: ClusteringDatasetItem[];
}

/** cluster-engine 的加载状态。 */
export interface ClusteringEngineStatus {
  /** 配置文件名（不下发绝对路径）。 */
  configFile?: string | null;
  loaded: boolean;
  profilesTotal: number;
  profilesAvailable: number;
  algorithmsAvailable: string[];
  modelId?: string | null;
  modelProvider?: string | null;
  modelDimension?: number | null;
  /** 未加载时的说明信息。 */
  message?: string | null;
}

/** 健康检查结果。 */
export interface ClusteringHealthData {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  engine: ClusteringEngineStatus;
}
