/** Provider 原始 usage 归一化；禁止在前端或 Runtime 猜测模型 Token。 */
import type { ModelTokenUsage } from './types.js';

export interface OpenAICompatibleRawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
}

/**
 * OpenAI Chat Completions/Responses 口径：cached tokens 是输入 token 的子集，
 * 所以 total 不得再额外加 cached。优先保留 Provider 返回的 total_tokens。
 */
export function normalizeOpenAICompatibleUsage(raw: OpenAICompatibleRawUsage): ModelTokenUsage {
  const inputTokens = nonNegative(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = nonNegative(raw.completion_tokens ?? raw.output_tokens);
  const rawCached = raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens;
  const cachedTokens = Math.min(inputTokens, nonNegative(rawCached));
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens: nonNegative(raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens),
    totalTokens: nonNegative(raw.total_tokens) || inputTokens + outputTokens,
    cachedTokensAvailable: rawCached !== undefined,
    cachedTokensAreInputSubset: true,
    source: 'provider',
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
