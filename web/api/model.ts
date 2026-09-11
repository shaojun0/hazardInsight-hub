/**
 * 模型领域 API：运行期模型配置（Mock 演示模式已移除，仅真实模型）。
 */
import { parseRes } from './client';

export interface ModelInfo {
  mode: 'ai';
  model: string;
  configured: boolean;
  baseUrl: string;
  configModel: string;
  source: 'runtime' | 'env' | 'none';
  hasApiKey: boolean;
  runtimeMode: 'auto' | 'ai';
  envConfigured: boolean;
}

export interface ModelConfigPayload {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  mode?: 'auto' | 'ai';
}

export async function fetchModelInfo(): Promise<ModelInfo> {
  const res = await fetch('/api/model');
  return parseRes<ModelInfo>(res);
}

export async function saveModelConfig(payload: ModelConfigPayload): Promise<ModelInfo> {
  const res = await fetch('/api/model-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseRes<ModelInfo>(res);
}

export async function resetModelConfig(): Promise<ModelInfo> {
  const res = await fetch('/api/model-config/reset', { method: 'POST' });
  return parseRes<ModelInfo>(res);
}
