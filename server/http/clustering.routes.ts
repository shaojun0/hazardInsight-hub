/**
 * 聚类服务反向代理。
 *
 * 聚类算法跑在独立的 Python 服务里（backend/python，FastAPI + cluster-engine）。
 * 开发时由 Vite 代理转发，生产时前端由 Express 托管，因此 Express 也必须把
 * `/api/clustering/*` 转发过去，否则打包部署后聚类页面会 404。
 *
 * 转发策略：
 * - 只透传必要头部（Content-Type / Accept / x-request-id / Idempotency-Key），
 *   不转发 Host、Cookie；
 * - 请求体按流透传，multipart 上传不会被缓冲到内存里；
 * - JSON 请求体例外：`express.json()` 已在上游消费了流，需要重新序列化后再转发；
 * - **响应按流回传**，不再 `arrayBuffer()` 整份读进来：作业结果分页后每次只有几十 KB，
 *   但同步 `/run` 的响应可以到几百 MB，缓冲它等于把 Python 进程算出来的东西
 *   在 Node 里再复制一遍；
 * - 客户端断开时中止上游请求，避免"页面关了，Python 还在为没人要的结果干活"；
 * - Python 服务不可达时返回 502，并保持与 Python 侧一致的 `success/data/error` 结构，
 *   前端只需要一套错误分支。
 */

import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';

/** Python 聚类服务地址，可用环境变量覆盖（默认本机 8000）。 */
const DEFAULT_TARGET = 'http://127.0.0.1:8000';

/**
 * 上游超时（毫秒）。默认与 Python 侧的 `timeout_seconds`（3600s）对齐，
 * 否则代理层会先于引擎把自己的请求掐掉，前端只能看到 504 而引擎还在跑。
 */
const DEFAULT_TIMEOUT_MS = 3_600_000;

/** 这些头部由 Node 侧根据转发结果重新生成，不能直接照搬。 */
const SKIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/** 需要透传给 Python 的请求头。`idempotency-key` 必须在列：作业幂等依赖它。 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id', 'idempotency-key'];

function resolveTarget(): string {
  return (process.env.PY_CLUSTER_URL ?? DEFAULT_TARGET).replace(/\/+$/, '');
}

function resolveTimeout(): number {
  const raw = Number(process.env.PY_CLUSTER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function createClusteringRoutes(): Router {
  const router = Router();

  router.use('/clustering', async (req: Request, res: Response) => {
    const target = resolveTarget();
    // 挂载在 /api 之下、又以 /clustering 为前缀，因此 req.url 已剥掉这两段。
    const suffix = req.url === '/' ? '' : req.url;
    const url = `${target}/api/clustering${suffix}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string' && value) headers.set(name, value);
    }

    const method = req.method.toUpperCase();
    const withBody = method !== 'GET' && method !== 'HEAD';

    // app.ts 里先挂了 express.json()，JSON 请求体已被解析并消费，
    // 此时不能再把 req 当作流透传（会发出空 body），必须重新序列化。
    const rawContentType = req.headers['content-type'];
    const isJson = typeof rawContentType === 'string' && rawContentType.includes('application/json');
    let body: string | ReadableStream | undefined;
    if (withBody && isJson) {
      body = JSON.stringify(req.body ?? {});
      headers.set('content-type', 'application/json');
    } else if (withBody) {
      // multipart 等未被 express.json() 解析的请求体保持流式转发，避免缓冲大文件。
      body = req as unknown as ReadableStream;
    }

    // 客户端断开（用户关页面/取消）时中止上游请求，别让引擎白跑一趟。
    const abort = new AbortController();
    const onClosed = () => abort.abort();
    res.on('close', onClosed);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(resolveTimeout())]),
        // Node 的 fetch 要求流式请求体显式声明 half duplex。
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
      });

      if (!response.body) {
        res.end();
        return;
      }
      // 逐块回传：分页响应很小，同步全量响应也不再被复制成一份 Buffer。
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (error) {
      // 客户端主动断开不算上游故障，此时响应已经无法写回，直接结束。
      if (abort.signal.aborted) {
        res.destroy();
        return;
      }
      res.status(502).json({
        success: false,
        data: null,
        error: {
          code: 'CLUSTERING_UNAVAILABLE',
          message: `无法连接 Python 聚类服务（${target}）：${(error as Error).message}`,
          requestId: null,
          detail: '请先启动聚类服务：在项目根目录执行 npm run dev:py。',
        },
      });
    } finally {
      res.off('close', onClosed);
    }
  });

  return router;
}
