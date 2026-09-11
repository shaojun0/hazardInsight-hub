/**
 * 分析路由：图片隐患识别与 HTML 报告导出。
 *   POST /api/analyze   multipart image=<file>[&scenario=<id>] -> AnalysisResult（mode: ai）
 *   POST /api/export    导出 HTML 报告（body: { analysis, download? }）
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { AnalysisResult } from '../../shared/types.js';
import { renderReportHtml } from '../../shared/report.js';
import type { AgentRuntime } from '../agent/runtime.js';
import { sendError, sendJson } from './helpers.js';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

function mimeOf(originalName: string, declared: string): string | null {
  if (ALLOWED_MIME[declared]) return ALLOWED_MIME[declared];
  const ext = originalName.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return null;
}

export function createAnalysisRoutes(runtime: AgentRuntime): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 35 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype) || /\.(jpe?g|png|webp)$/i.test(file.originalname);
      cb(null, ok);
    },
  });

  router.post('/analyze', (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          return sendError(res, 400, `上传失败：${err.message}`, 'UPLOAD_ERROR');
        }
        return sendError(res, 400, `上传失败：${(err as Error).message}`, 'UPLOAD_ERROR');
      }
      void handleAnalyze(req, res, runtime);
    });
  });

  router.post('/export', (req, res) => {
    const analysis = req.body?.analysis as AnalysisResult | undefined;
    if (!analysis?.analysisId || !Array.isArray(analysis.hazards)) {
      sendError(res, 400, '缺少有效的分析结果数据。');
      return;
    }
    const html = renderReportHtml(analysis);
    const download = req.query?.download === '1';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${analysis.analysisId}-report.html"`);
    }
    res.send(html);
  });

  return router;
}

export interface AnalyzeRequest extends Request {
  file?: Express.Multer.File;
}

async function handleAnalyze(req: AnalyzeRequest, res: Response, runtime: AgentRuntime): Promise<void> {
  const file = req.file;
  if (!file || !file.buffer) {
    sendError(res, 400, '请上传 JPG / JPEG / PNG / WebP 格式的工程现场图片。', 'NO_IMAGE');
    return;
  }
  const mime = mimeOf(file.originalname, file.mimetype);
  if (!mime) {
    sendError(res, 400, '不支持的图片格式，仅支持 JPG / JPEG / PNG / WebP。', 'BAD_FORMAT');
    return;
  }
  const scenario = typeof req.body?.scenario === 'string' ? req.body.scenario : undefined;

  try {
    const result = await runtime.runHazardAnalysis({
      buffer: file.buffer,
      mimeType: mime,
      scenario,
      userId: 'anonymous-demo',
      conversationId: typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined,
      taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : undefined,
      frontendState: {
        source: req.body?.source === 'camera' || req.body?.source === 'robot' ? req.body.source : 'workbench',
        scenarioId: scenario,
        reasoningEffort: typeof req.body?.reasoningEffort === 'string' ? req.body.reasoningEffort : undefined,
        deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : undefined,
        stationId: typeof req.body?.stationId === 'string' ? req.body.stationId : undefined,
      },
    });
    sendJson(res, { ok: true, mode: result.mode, runId: result.agentMeta?.runId, data: result satisfies AnalysisResult });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code?.startsWith('MODEL_')) {
      sendError(res, 502, `AI 服务暂时不可用：${e.message}`, 'MODEL_ERROR');
      return;
    }
    console.error('[hazard] 分析失败:', e);
    sendError(res, 500, `分析过程出现异常：${e.message}`, 'INTERNAL');
  }
}
