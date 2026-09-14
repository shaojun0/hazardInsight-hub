import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时前端使用 Vite(5175)：
// - /api/clustering/* 代理到 Python 聚类服务(8000)
// - 其余 /api/* 代理到本地 Node API(3001)
// 代理规则按声明顺序匹配，因此 /api/clustering 必须写在 /api 之前。
const PY_CLUSTER_TARGET = process.env.VITE_PY_CLUSTER_TARGET ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    // 显式绑定 IPv4 回环，避免部分环境只监听 [::1] 导致访问/代理探测异常。
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: {
      '/api/clustering': {
        target: PY_CLUSTER_TARGET,
        changeOrigin: true,
        // 30 万条样本的聚类可能跑很久，默认代理超时会中途断开连接。
        // 这里与后端 timeout_seconds(3600s) 对齐。
        // 请求体大小无需在此限制：http-proxy 默认流式转发，不设上限。
        timeout: 3_600_000,
        proxyTimeout: 3_600_000,
      },
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
