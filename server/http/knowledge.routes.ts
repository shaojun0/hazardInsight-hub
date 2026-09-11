/**
 * 知识库路由：标准文档列表、历史案例检索、服务健康检查。
 *   GET /api/health     服务健康检查
 *   GET /api/standards  标准知识库列表（?type=general|nuclear|enterprise|all）
 *   GET /api/cases      历史案例检索（?q=&category=&grade=）
 */
import { Router } from 'express';
import type { KnowledgeRetriever } from '../retrieval/index.js';
import { resolveProvider } from '../providers/index.js';
import { sendJson } from './helpers.js';

export const STANDARD_TYPES = ['all', 'general', 'nuclear', 'enterprise'] as const;
export type StandardFilter = (typeof STANDARD_TYPES)[number];

export function createKnowledgeRoutes(retriever: KnowledgeRetriever): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    sendJson(res, { ok: true, mode: resolveProvider().mode, service: 'nuclear-hazard-demo' });
  });

  router.get('/standards', (req, res) => {
    const type = (req.query.type as string) || 'all';
    const docs = retriever
      .listDocuments(STANDARD_TYPES.includes(type as StandardFilter) ? (type as StandardFilter) : undefined)
      .map((d) => ({
        id: d.id,
        type: d.type,
        documentName: d.documentName,
        documentCode: d.documentCode,
        version: d.version,
        status: d.status,
        updatedAt: d.updatedAt,
        category: d.category,
        clauseCount: d.clauses.length,
        clauses: d.clauses.map((c) => ({
          id: c.id,
          clause: c.clause,
          clauseTitle: c.clauseTitle,
          content: c.content,
          category: c.category,
          keywords: c.keywords,
        })),
      }));
    sendJson(res, { data: docs, disclaimer: '' });
  });

  router.get('/cases', (req, res) => {
    const q = String(req.query.q ?? '');
    const category = String(req.query.category ?? '全部');
    const grade = String(req.query.grade ?? '全部');
    const data = retriever.listCases({ q, category, grade });
    sendJson(res, { data });
  });

  return router;
}