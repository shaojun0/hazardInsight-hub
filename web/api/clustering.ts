/**
 * 聚类分析接口客户端。
 *
 * 约定：
 * - 一律走**同源相对路径** `/api/clustering/*`，由 Vite / Node 代理转发到本机
 *   Python 聚类服务，前端任何位置都不硬编码 Python 的地址与端口；
 * - 后端统一返回 `{ success, data, error }`，本模块负责拆封：成功取 `data`，
 *   失败统一抛 `ApiError`（带 `code`），页面只需一套错误分支；
 * - 服务未启动、代理不可达等网络层错误也转成 `ApiError`，避免出现"按钮点了没反应"。
 */

import type {
  ClusteringAlgorithmInfo,
  ClusteringData,
  ClusteringDatasetItem,
  ClusteringDatasetPreview,
  ClusteringHealthData,
  ClusteringProfileInfo,
  ClusteringRunOptions,
  ClusteringSampleData,
} from '../../shared/clustering';
import { ApiError } from './client';

/** 网关基址：与后端 `clustering_router` 的挂载前缀保持一致。 */
const BASE = '/api/clustering';

interface Envelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; requestId?: string | null; detail?: string | null } | null;
}

/** 统一请求：拆封包裹 + 归一化错误。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (cause) {
    throw new ApiError(
      '无法连接聚类服务，请确认后端已启动（npm run dev:py）。',
      'NETWORK_ERROR',
      undefined,
    );
  }

  const raw = await response.text();
  let envelope: Envelope<T> | null = null;
  if (raw) {
    try {
      envelope = JSON.parse(raw) as Envelope<T>;
    } catch {
      // 代理层返回的 HTML 错误页（如 502）走下面的兜底分支
      envelope = null;
    }
  }

  if (response.ok && envelope?.success && envelope.data != null) {
    return envelope.data;
  }

  const detail = envelope?.error;
  const fallback = response.ok
    ? '聚类服务返回了无法识别的响应。'
    : response.status === 502 || response.status === 503 || response.status === 504
      ? '聚类服务暂时不可用，请稍后重试。'
      : `请求失败（HTTP ${response.status}）。`;
  throw new ApiError(detail?.message ?? fallback, detail?.code ?? 'HTTP_ERROR', response.status);
}

/** 仅在需要强制重新校验时才带上 `refresh`，保持缓存友好的干净 URL。 */
const refreshParam = (refresh: boolean) => (refresh ? '?refresh=true' : '');

/** 健康检查：服务与聚类引擎的就绪状态。 */
export const fetchClusteringHealth = (refresh = false) =>
  request<ClusteringHealthData>(`/health${refreshParam(refresh)}`);

/** 列出可用 profile（含可用性与不可用原因）。 */
export const fetchClusteringProfiles = (refresh = false) =>
  request<{ profiles: ClusteringProfileInfo[] }>(`/profiles${refreshParam(refresh)}`).then(
    (data) => data.profiles,
  );

/** 列出引擎暴露的聚类算法及其依赖可用性。 */
export const fetchClusteringAlgorithms = () =>
  request<{ algorithms: ClusteringAlgorithmInfo[] }>('/algorithms').then(
    (data) => data.algorithms,
  );

/** 读取内置示例数据（真实核电工程隐患抽样）。 */
export const fetchClusteringSample = () => request<ClusteringSampleData>('/sample');

/** 上传并解析数据文件（CSV / XLSX / JSON / TXT）。 */
export function uploadClusteringDataset(file: File) {
  const body = new FormData();
  body.append('file', file);
  return request<ClusteringDatasetPreview>('/datasets', { method: 'POST', body });
}

/** 执行一次聚类。 */
export function runClustering(items: ClusteringDatasetItem[], options: ClusteringRunOptions = {}) {
  return request<ClusteringData>('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, options }),
  });
}
