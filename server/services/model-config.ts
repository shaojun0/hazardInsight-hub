/**
 * 运行期模型配置存储（模型配置页面写入，持久化到 .runtime-model.json，gitignore 忽略）。
 *
 * 配置优先级：
 *   1. 运行期配置（本模块读写）
 *   2. .env / 环境变量（MULTIMODAL_API_BASE_URL / MULTIMODAL_API_KEY / MULTIMODAL_MODEL）
 *   3. 无任何配置 -> 由 providers 工厂抛错（未配置真实模型），不再回退 Mock 演示模式
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ModelModeFlag = 'auto' | 'ai';

export interface RuntimeModelConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  mode?: ModelModeFlag;
}

const RUNTIME_FILE = resolve(process.cwd(), '.runtime-model.json');

function loadPersisted(): RuntimeModelConfig {
  try {
    if (existsSync(RUNTIME_FILE)) {
      const parsed = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeModelConfig;
      return { ...parsed, mode: parsed.mode === 'ai' ? 'ai' : 'auto' };
    }
  } catch {
    // 配置损坏时忽略，退回默认
  }
  return { mode: 'auto' };
}

function savePersisted(cfg: RuntimeModelConfig): void {
  try {
    writeFileSync(RUNTIME_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    // 落盘失败不影响内存运行
  }
}

let runtime: RuntimeModelConfig = loadPersisted();

export function getRuntimeConfig(): RuntimeModelConfig {
  return { ...runtime };
}

/** 保存运行期配置（空字符串视为未提供，不清空已有值；调用方需显式 reset 恢复 .env 默认）。 */
export function setRuntimeConfig(next: Partial<RuntimeModelConfig>): RuntimeModelConfig {
  const strip = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  if (next.baseUrl !== undefined) runtime.baseUrl = strip(next.baseUrl);
  if (next.apiKey !== undefined) runtime.apiKey = strip(next.apiKey);
  if (next.model !== undefined) runtime.model = strip(next.model);
  if (next.mode !== undefined) {
    runtime.mode = next.mode === 'ai' ? 'ai' : 'auto';
  }
  savePersisted(runtime);
  return getRuntimeConfig();
}

/** 恢复为 .env / 环境变量（清除运行期配置）。 */
export function clearRuntimeConfig(): void {
  runtime = { mode: 'auto' };
  savePersisted(runtime);
}

function envStr(name: string): string {
  return (process.env[name] ?? '').trim();
}

export interface EffectiveModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  modeFlag: ModelModeFlag;
  source: 'runtime' | 'env' | 'none';
  hasRuntime: boolean;
}

export function effectiveModelConfig(): EffectiveModelConfig {
  const rt = runtime;
  const baseUrl = rt.baseUrl ?? envStr('MULTIMODAL_API_BASE_URL');
  const apiKey = rt.apiKey ?? envStr('MULTIMODAL_API_KEY');
  const model = rt.model ?? envStr('MULTIMODAL_MODEL');
  const hasRuntime = Boolean(rt.baseUrl || rt.apiKey || rt.model || (rt.mode && rt.mode !== 'auto'));
  const source: 'runtime' | 'env' | 'none' = hasRuntime
    ? 'runtime'
    : envStr('MULTIMODAL_API_KEY') || envStr('MULTIMODAL_API_BASE_URL')
      ? 'env'
      : 'none';
  return { baseUrl, apiKey, model, modeFlag: rt.mode ?? 'auto', source, hasRuntime };
}