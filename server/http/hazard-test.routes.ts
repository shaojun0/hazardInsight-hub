import { Router, type Response } from 'express';
import multer from 'multer';
import type { AgentRuntime } from '../agent/runtime.js';
import { sendError, sendJson } from './helpers.js';
import { MAX_TEST_BYTES, parseTestDataset, readDefaultTestDataset } from '../testing/dataset.js';
import { exportTestErrors, HazardTestError, HazardTestService } from '../testing/service.js';

export function createHazardTestRoutes(runtime: Pick<AgentRuntime, 'runHazardAnalysis'>): Router {
  const router = Router();
  const service = new HazardTestService(runtime);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TEST_BYTES, files: 1, fields: 1 } });
  const owner = (res: Response) => String(res.locals.authUser?.id ?? 'anonymous-demo');
  const fail = (res: Response, error: unknown) => sendError(res,
    error instanceof HazardTestError ? error.status : 400,
    error instanceof Error ? error.message : '测试操作失败。',
    error instanceof HazardTestError ? error.code : 'TEST_INPUT_ERROR');

  router.get('/hazard-tests/datasets/default', async (_req, res) => {
    try { sendJson(res, { data: service.addDataset(owner(res), await readDefaultTestDataset()) }); }
    catch (error) { fail(res, error); }
  });
  router.post('/hazard-tests/datasets', (req, res) => {
    upload.single('file')(req, res, error => {
      if (error) {
        sendError(res, 400, error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
          ? 'CSV 文件不能超过 5MB。' : `上传失败：${(error as Error).message}`, 'UPLOAD_ERROR');
        return;
      }
      try {
        if (!req.file) throw new Error('请上传 CSV 文件（表单字段 file）。');
        // 浏览器使用 UTF-8 filename，multipart 默认按 latin1 读取。
        const rawName = req.file.originalname;
        const fileName = /[^\u0000-\u00ff]/.test(rawName) ? rawName : Buffer.from(rawName, 'latin1').toString('utf8');
        sendJson(res, { data: service.addDataset(owner(res), parseTestDataset(req.file.buffer, fileName)) });
      } catch (error) { fail(res, error); }
    });
  });
  router.get('/hazard-tests/jobs/latest', (_req, res) => sendJson(res, { data: service.latest(owner(res)) }));
  router.post('/hazard-tests/jobs', (req, res) => {
    try {
      if (typeof req.body?.datasetId !== 'string') throw new Error('缺少测试集 ID。');
      sendJson(res, { data: service.start(owner(res), req.body.datasetId, {
        ...(req.body.concurrency !== undefined ? { concurrency: req.body.concurrency } : {}),
        ...(req.body.maxOutputTokens !== undefined ? { maxOutputTokens: req.body.maxOutputTokens } : {}),
      }) });
    } catch (error) { fail(res, error); }
  });
  router.get('/hazard-tests/jobs/:id', (req, res) => {
    try { sendJson(res, { data: service.getJob(owner(res), String(req.params.id)) }); }
    catch (error) { fail(res, error); }
  });
  router.post('/hazard-tests/jobs/:id/stop', (req, res) => {
    try { sendJson(res, { data: service.stop(owner(res), String(req.params.id)) }); }
    catch (error) { fail(res, error); }
  });
  router.get('/hazard-tests/jobs/:id/errors.csv', (req, res) => {
    try {
      const job = service.getJob(owner(res), String(req.params.id));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="hazard-test-${job.id}-errors.csv"`);
      res.send(exportTestErrors(job));
    } catch (error) { fail(res, error); }
  });
  return router;
}
