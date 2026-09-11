/**
 * Promise-based Express 处理器适配与统一响应工具。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** 路由内响应 JSON（统一出口，便于后续加日志/包装）。 */
export function sendJson<T>(res: Response, data: T): void {
  res.json(data);
}

/** 统一错误响应：{ error, code? } */
export function sendError(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json(code ? { error: message, code } : { error: message });
}

/** 捕获 async 处理器中的异常并交给 Express 错误链。 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}