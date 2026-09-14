/**
 * Express 应用组装：中间件、领域路由、生产静态托管与兜底错误处理。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createRetriever } from '../retrieval/index.js';
import { createAgentRuntime } from '../agent/runtime.js';
import { createAgentRoutes } from './agent.routes.js';
import { createAnalysisRoutes } from './analysis.routes.js';
import { createClusteringRoutes } from './clustering.routes.js';
import { createHazardTestRoutes } from './hazard-test.routes.js';
import { createKnowledgeRoutes } from './knowledge.routes.js';
import { createModelRoutes } from './model.routes.js';
import { createRulesRoutes } from './rules.routes.js';
import { createWorkflowControlPlane } from '../workflow/bootstrap.js';
import { createWorkflowRoutes } from './workflow.routes.js';
import { createAuthRoutes, createAuthRuntime, requireAuthenticated, type AuthOptions } from './auth.routes.js';

export interface CreateAppOptions {
  /** 仅供隔离的内部测试使用；实际应用始终启用登录门禁。 */
  auth?: AuthOptions | false;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // 聚类请求体可能承载数十万条样本，需要远高于默认的上限。
  // 只对 /api/clustering/* 放宽，其余接口仍维持 10 MB，避免无谓地放松其他入口的防护。
  const clusteringJson = express.json({ limit: '200mb' });
  app.use('/api/clustering', clusteringJson);
  app.use(express.json({ limit: '10mb' }));

  // 知识库检索器为各路由共享的进程内单例
  const retriever = createRetriever();
  const agentRuntime = createAgentRuntime(retriever);
  const workflowControl = createWorkflowControlPlane();

  const authRuntime = createAuthRuntime(options.auth === false ? { config: null } : options.auth);
  app.use('/api', createAuthRoutes({ runtime: authRuntime }));
  if (options.auth !== false) app.use('/api', requireAuthenticated(authRuntime));
  app.use('/api', createWorkflowRoutes(workflowControl));
  app.use('/api', createModelRoutes());
  app.use('/api', createKnowledgeRoutes(retriever));
  app.use('/api', createRulesRoutes());
  app.use('/api', createAgentRoutes(agentRuntime));
  app.use('/api', createAnalysisRoutes(agentRuntime));
  app.use('/api', createHazardTestRoutes(agentRuntime));
  // 聚类分析：转发到独立的 Python 聚类服务（FastAPI + cluster-engine）
  app.use('/api', createClusteringRoutes());

  // 生产环境：托管 Vite 构建产物（SPA fallback）
  const distDir = resolve(process.cwd(), 'dist');
  if (process.env.NODE_ENV === 'production' && existsSync(resolve(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(resolve(distDir, 'index.html'));
        return;
      }
      next();
    });
  }

  // 统一兜底：未匹配 API 路由
  app.use((_req, res) => {
    res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' });
  });

  return app;
}
