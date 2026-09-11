/**
 * 判定规则库路由：查询、TXT/CSV 导入、演示样本导入、清空。
 *   GET  /api/rules              规则列表
 *   POST /api/rules/import       上传 .txt/.csv 规则文件
 *   POST /api/rules/import-demo      导入内置 TXT 演示样本
 *   POST /api/rules/import-demo-csv  导入内置 CSV 演示样本
 *   POST /api/rules/clear        清空已导入规则
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { clearRules, getRules, importRulesCsv, importRulesText } from '../rules/index.js';
import { sendError, sendJson } from './helpers.js';

const uploadRules = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    const ok = ext === 'txt' || ext === 'csv' || /^(text\/(plain|csv)|application\/csv)$/.test(file.mimetype);
    cb(null, ok);
  },
});

function samplePath(name: string): string {
  return resolve(process.cwd(), 'server', 'data', name);
}

export function createRulesRoutes(): Router {
  const router = Router();

  router.get('/rules', (_req, res) => {
    const data = getRules();
    sendJson(res, { data, total: data.length });
  });

  router.post('/rules/import', (req, res) => {
    uploadRules.single('file')(req, res, (err) => {
      if (err) {
        sendError(res, 400, `上传失败：${(err as Error).message}`);
        return;
      }
      if (!req.file?.buffer) {
        sendError(res, 400, '请选择 .txt 或 .csv 格式的判定规则文件。');
        return;
      }
      const text = req.file.buffer.toString('utf8');
      const isCsv = req.file.originalname.split('.').pop()?.toLowerCase() === 'csv';
      const { rules, added, total } = isCsv ? importRulesCsv(text) : importRulesText(text);
      if (added === 0 && total === rules.length && rules.length === 0) {
        sendError(res, 400, '未解析到有效的判定规则行，请检查文件格式。');
        return;
      }
      sendJson(res, {
        ok: true,
        format: isCsv ? 'csv' : 'txt',
        added,
        total: rules.length,
        data: rules,
      });
    });
  });

  router.post('/rules/import-demo', (_req, res) => {
    try {
      const text = readFileSync(samplePath('sample_rules.txt'), 'utf8');
      const { rules, added, total } = importRulesText(text);
      sendJson(res, { ok: true, demo: true, format: 'txt', added, total: rules.length, data: rules });
    } catch (e) {
      sendError(res, 500, `载入示例失败：${(e as Error).message}`);
    }
  });

  router.post('/rules/import-demo-csv', (_req, res) => {
    try {
      const text = readFileSync(samplePath('sample_rules.csv'), 'utf8');
      const { rules, added, total } = importRulesCsv(text);
      sendJson(res, { ok: true, demo: true, format: 'csv', added, total: rules.length, data: rules });
    } catch (e) {
      sendError(res, 500, `载入示例失败：${(e as Error).message}`);
    }
  });

  router.post('/rules/clear', (_req, res) => {
    const data = clearRules();
    sendJson(res, { ok: true, total: data.length, data });
  });

  return router;
}