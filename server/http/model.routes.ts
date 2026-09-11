/**
 * 模型相关路由：运行期模式/模型配置查询与修改、连通性测试。
 *   GET  /api/model                当前模型配置（Mock 演示模式已移除，仅真实模型）
 *   POST /api/model-config         保存模型配置（模型配置页）
 *   POST /api/model-config/reset   恢复 .env / 环境变量默认
 *   POST /api/health-check         多模态 Provider 连通性测试
 */
import { Router } from 'express';
import { clearRuntimeConfig, effectiveModelConfig, getRuntimeConfig, setRuntimeConfig } from '../services/model-config.js';
import { ProviderNotConfiguredError, resolveProvider } from '../providers/index.js';
import { sendError, sendJson } from './helpers.js';

export function createModelRoutes(): Router {
  const router = Router();

  function modelInfo() {
    const eff = effectiveModelConfig();
    const configured = eff.modeFlag === 'ai' || Boolean(eff.apiKey);
    const model = configured ? eff.model || 'deepseek-v4-flash-vision-exp' : '未配置';
    return {
      mode: 'ai' as const,
      model,
      configured,
      baseUrl: eff.baseUrl,
      configModel: eff.model,
      source: eff.source,
      hasApiKey: Boolean(eff.apiKey && eff.source !== 'none'),
      runtimeMode: getRuntimeConfig().mode ?? 'auto',
      envConfigured: Boolean(process.env.MULTIMODAL_API_KEY),
    };
  }

  router.get('/model', (_req, res) => {
    sendJson(res, modelInfo());
  });

  router.post('/model-config', (req, res) => {
    const body = (req.body ?? {}) as { baseUrl?: string; apiKey?: string; model?: string; mode?: string };
    if (typeof body.mode !== 'undefined' && !['auto', 'ai'].includes(body.mode)) {
      sendError(res, 400, 'mode 仅支持 auto / ai');
      return;
    }
    setRuntimeConfig({
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      mode: (body.mode as 'auto' | 'ai' | undefined) ?? undefined,
    });
    sendJson(res, modelInfo());
  });

  router.post('/model-config/reset', (_req, res) => {
    clearRuntimeConfig();
    sendJson(res, modelInfo());
  });

  router.post('/health-check', async (_req, res) => {
    let cfg;
    try {
      cfg = resolveProvider();
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        sendError(res, 502, err.message);
        return;
      }
      sendError(res, 502, `测试失败：${(err as Error).message}`);
      return;
    }
    try {
      const ok = await cfg.provider.healthCheck();
      sendJson(res, { ok, mode: cfg.mode, message: ok ? '连接正常' : '连接失败' });
    } catch (err) {
      sendError(res, 502, `测试失败：${(err as Error).message}`);
    }
  });

  return router;
}
