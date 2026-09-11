/**
 * API 客户端基础：统一 fetch 封装与错误类型。
 * 各领域客户端（./analysis、./model、./rules、./knowledge）基于本模块构建。
 */

export class ApiError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function parseRes<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `请求失败（HTTP ${res.status}）`;
  let code = 'HTTP_ERROR';
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    if (body.code) code = body.code;
  } catch {
    // 非 JSON 响应
  }
  throw new ApiError(message, code, res.status);
}