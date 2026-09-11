/**
 * 核电工程隐患智能识别与定级系统 - API 服务入口。
 * 仅负责：加载 .env、组装 Express 应用、监听端口。
 * 路由与业务逻辑见 server/http/（路由层）与 server/ 各领域模块（业务层）。
 */
import { loadEnv } from './lib/env.js';
import { createApp } from './http/app.js';
import { resolveProvider } from './providers/index.js';

loadEnv();

const PORT = Number(process.env.PORT) || 3001;
const app = createApp({ auth: false });

app.listen(PORT, () => {
  console.log(`[hazard] Nuclear Hazard API listening on http://127.0.0.1:${PORT}`);
  try {
    const cfg = resolveProvider();
    console.log(`[hazard] Mode: AI 模式（${cfg.provider.name}）`);
  } catch (err) {
    console.log(`[hazard] 警告：${(err as Error).message}`);
  }
  console.log(`[hazard] 提示：生产部署时前端构建产物位于 /dist`);
});