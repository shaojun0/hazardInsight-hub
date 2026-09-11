/**
 * Agent Runtime 路由：
 *   POST /api/agent/runs/stream                 multipart 创建 run，SSE 返回真实事件
 *   GET  /api/agent/runs/:runId                 run 状态与结果
 *   GET  /api/agent/runs/:runId/events?after=N  事件补取
 *   GET  /api/agent/runs/:runId/token-usage     单 Run 调用级 Token Usage
 *   GET  /api/agent/sessions/:id/token-usage    Session 聚合
 *   GET  /api/agent/conversations/:id/token-usage Conversation 聚合
 *   GET  /api/agent/token-usage                 当前前端身份的三级 Token 总览
 *   GET  /api/agent/context-observability       Agent/Turn/LLM Step 上下文总览
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { isReasoningEffort, type AgentStreamEvent, type FrontendAgentState, type ReasoningEffort } from '../../shared/agent-protocol.js';
import type { AgentRuntime } from '../agent/runtime.js';
import { sendError, sendJson } from './helpers.js';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype) || /\.(jpe?g|png|webp)$/i.test(file.originalname)),
});

function mimeOf(originalName: string, declared: string): string | null {
  if (ALLOWED_MIME[declared]) return ALLOWED_MIME[declared];
  const ext = originalName.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return null;
}

export function createAgentRoutes(runtime: AgentRuntime): Router {
  const router = Router();

  router.post('/agent/runs/stream', (req, res) => {
    upload.single('image')(req, res, (error) => {
      if (error) {
        sendError(res, 400, `上传失败：${(error as Error).message}`, 'UPLOAD_ERROR');
        return;
      }
      void handleStream(req, res, runtime);
    });
  });

  router.get('/agent/runs/:runId', (req, res) => {
    const run = runtime.getRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'Agent run 不存在或已过期。', 'RUN_NOT_FOUND');
      return;
    }
    sendJson(res, { data: run });
  });

  router.get('/agent/runs/:runId/events', (req, res) => {
    const run = runtime.getRun(req.params.runId);
    if (!run) {
      sendError(res, 404, 'Agent run 不存在或已过期。', 'RUN_NOT_FOUND');
      return;
    }
    const after = Math.max(0, Number(req.query.after) || 0);
    sendJson(res, { data: runtime.getEvents(req.params.runId, after) });
  });

  router.get('/agent/runs/:runId/token-usage', (req, res) => {
    const usage = runtime.getRunTokenUsage(req.params.runId);
    if (!usage) {
      sendError(res, 404, 'Agent run 不存在或 Token 数据已过期。', 'RUN_TOKEN_USAGE_NOT_FOUND');
      return;
    }
    sendJson(res, { data: usage });
  });

  router.get('/agent/sessions/:sessionId/token-usage', (req, res) => {
    sendJson(res, { data: runtime.getSessionTokenUsage(req.params.sessionId) });
  });

  router.get('/agent/conversations/:conversationId/token-usage', (req, res) => {
    sendJson(res, { data: runtime.getConversationTokenUsage(req.params.conversationId) });
  });

  router.get('/agent/token-usage', (req, res) => {
    const conversationId = safeId(req.query.conversationId);
    const sessionId = safeId(req.query.sessionId);
    if (!conversationId || !sessionId) {
      sendError(res, 400, '缺少有效的 conversationId 或 sessionId。', 'TOKEN_USAGE_SCOPE_INVALID');
      return;
    }
    sendJson(res, { data: runtime.getTokenUsageOverview(conversationId, sessionId) });
  });

  router.get('/agent/context-observability', (req, res) => {
    const conversationId = safeId(req.query.conversationId);
    const sessionId = safeId(req.query.sessionId);
    if (!conversationId || !sessionId) {
      sendError(res, 400, '缺少有效的 conversationId 或 sessionId。', 'CONTEXT_SCOPE_INVALID');
      return;
    }
    sendJson(res, { data: runtime.getContextObservability(conversationId, sessionId) });
  });

  router.get('/agent/context-observability/steps/:stepId', (req, res) => {
    const step = runtime.getContextStep(req.params.stepId);
    if (!step) {
      sendError(res, 404, 'LLM Step 不存在或已过期。', 'LLM_STEP_NOT_FOUND');
      return;
    }
    sendJson(res, { data: step });
  });

  router.get('/agent/context-observability/export/:sessionId', (req, res) => {
    const sessionId = safeId(req.params.sessionId);
    if (!sessionId) {
      sendError(res, 400, 'Session ID 无效。', 'CONTEXT_SESSION_INVALID');
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="agent-context-${sessionId}.json"`);
    sendJson(res, { data: runtime.exportContextSession(sessionId) });
  });

  router.get('/agent/traces/:traceId', (req, res) => {
    const trace = runtime.getTrace(req.params.traceId);
    if (!trace) {
      sendError(res, 404, 'Agent trace 不存在或已过期。', 'TRACE_NOT_FOUND');
      return;
    }
    sendJson(res, { data: trace });
  });

  return router;
}

interface UploadRequest extends Request {
  file?: Express.Multer.File;
}

async function handleStream(req: UploadRequest, res: Response, runtime: AgentRuntime): Promise<void> {
  const file = req.file;
  if (!file?.buffer) {
    sendError(res, 400, '请上传 JPG / JPEG / PNG / WebP 格式的工程现场图片。', 'NO_IMAGE');
    return;
  }
  const mimeType = mimeOf(file.originalname, file.mimetype);
  if (!mimeType) {
    sendError(res, 400, '不支持的图片格式，仅支持 JPG / JPEG / PNG / WebP。', 'BAD_FORMAT');
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let writable = true;
  let streamed = false;
  res.on('close', () => {
    writable = false;
  });
  const heartbeat = setInterval(() => {
    if (writable && !res.writableEnded) res.write(': heartbeat\n\n');
  }, 15_000);

  const writeEvent = (event: AgentStreamEvent) => {
    if (!writable || res.writableEnded) return;
    streamed = true;
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const scenario = textField(req.body?.scenario);
  const source = validSource(textField(req.body?.source));
  try {
    await runtime.runHazardAnalysis({
      buffer: file.buffer,
      mimeType,
      scenario,
      // Demo HTTP 边界不信任前端自报 userId；生产由认证中间件解析 Principal。
      userId: 'anonymous-demo',
      conversationId: textField(req.body?.conversationId),
      sessionId: textField(req.body?.sessionId),
      taskId: textField(req.body?.taskId),
      frontendState: {
        source,
        scenarioId: scenario,
        reasoningEffort: validReasoningEffort(textField(req.body?.reasoningEffort)),
        deviceId: textField(req.body?.deviceId),
        stationId: textField(req.body?.stationId),
        locale: textField(req.body?.locale) ?? 'zh-CN',
      },
      onEvent: writeEvent,
    });
  } catch (error) {
    // Runtime 通常已发送 run.failed；若在 run 创建前失败（如未配置真实模型），补发事件。
    if (writable && !res.writableEnded && !streamed) {
      const err = error as Error & { code?: string };
      writeEvent({
        protocolVersion: '1.0',
        eventId: `evt_${Date.now()}`,
        sequence: 0,
        type: 'run.failed',
        timestamp: new Date().toISOString(),
        traceId: '',
        runId: '',
        taskId: '',
        payload: { status: 'failed', code: err.code ?? 'INTERNAL', message: err.message, retryable: false, metrics: {} },
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (writable && !res.writableEnded) res.end();
  }
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validSource(value: string | undefined): FrontendAgentState['source'] {
  return value === 'camera' || value === 'robot' ? value : 'workbench';
}

/** 思考强度校验：仅接受 low/high/max，非法或缺失返回 undefined（由 Runtime 回退默认 low）。 */
function validReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}
