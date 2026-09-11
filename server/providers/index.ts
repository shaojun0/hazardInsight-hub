/**
 * 统一多模态 Provider 工厂。
 * 根据运行期配置 / 环境变量解析当前生效的 Provider（真实 OpenAI 兼容模型）。
 * 配置的读写见 services/model-config.ts（本模块只读不写）。
 * 未配置真实模型时抛出 ProviderNotConfiguredError（不再回退 Mock 演示模式）。
 */
import { effectiveModelConfig } from '../services/model-config.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { MultimodalModelProvider } from './types.js';

export interface ResolvedProvider {
  provider: MultimodalModelProvider;
  mode: 'ai';
  summary: { baseUrl: string; model: string; configured: boolean };
}

/** 未配置真实模型（缺 API Key / Base URL，且运行模式未显式设为 ai）。 */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'MODEL_NOT_CONFIGURED';
  constructor(message = '未配置真实模型：请填写 API Key / Base URL，或将运行模式设置为「始终使用 AI」。') {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export function resolveProvider(): ResolvedProvider {
  const cfg = effectiveModelConfig();
  const modeFlag = cfg.modeFlag;

  // 显式 mode=ai 允许企业内网无 Key 网关，由健康检查/实际调用给出结果。
  const aiWanted = modeFlag === 'ai' || Boolean(cfg.apiKey);
  if (!aiWanted) throw new ProviderNotConfiguredError();

  const effectiveBase = cfg.baseUrl || 'https://api.deepseek.com/v1';
  const effectiveModel = cfg.model || 'deepseek-v4-flash-vision-exp';
  const provider = new OpenAICompatibleProvider({
    baseUrl: effectiveBase,
    apiKey: cfg.apiKey,
    model: effectiveModel,
    jsonMode: process.env.MULTIMODAL_JSON_MODE === '1',
    timeoutMs: Number(process.env.MULTIMODAL_TIMEOUT_MS) || 120_000,
    contextWindow: Number(process.env.MULTIMODAL_CONTEXT_WINDOW) || undefined,
    pricing: pricingFromEnv(),
    // 仅 DeepSeek（baseUrl / 模型名含 deepseek）支持 reasoning_effort；其他 OpenAI 兼容网关不注入该参数。
    reasoningEffortSupported: /deepseek/i.test(`${effectiveBase} ${effectiveModel}`),
  });
  return {
    provider,
    mode: 'ai',
    summary: { baseUrl: effectiveBase, model: effectiveModel, configured: Boolean(cfg.apiKey) },
  };
}

function pricingFromEnv() {
  const input = Number(process.env.MULTIMODAL_INPUT_PRICE_PER_MILLION);
  const output = Number(process.env.MULTIMODAL_OUTPUT_PRICE_PER_MILLION);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return undefined;
  const optional = (name: string) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  return {
    currency: (process.env.MULTIMODAL_PRICE_CURRENCY ?? 'CNY').trim() || 'CNY',
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: optional('MULTIMODAL_CACHE_READ_PRICE_PER_MILLION'),
    cacheWritePerMillion: optional('MULTIMODAL_CACHE_WRITE_PRICE_PER_MILLION'),
  };
}
