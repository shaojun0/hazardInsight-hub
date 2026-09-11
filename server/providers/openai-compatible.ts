/**
 * OpenAI-compatible 多模态 Provider（通用视觉大模型接入）。
 * 通过 fetch 直连 /chat/completions，支持 vision 系统消息中的 image_url（data URL）。
 * 已适配 DeepSeek 系列视觉模型（deepseek-v4-flash-vision-exp 等）：
 *   - Base URL 兼容误填完整端点（自动剥离尾部 /chat/completions）；
 *   - 推理模型输出含 reasoning_content，仅取 choices[0].message.content；
 *   - 兼容字符串/分段 content，并对 200 空正文进行有界重试；
 *   - 默认 max_tokens 8000，满足推理模型「最终回答」长度要求。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ModelPricing } from '../../shared/context-observability.js';
import type {
  ImagePayload,
  ModelCallOptions,
  ModelCallResult,
  MultimodalModelProvider,
  StreamingModelCallOptions,
} from './types.js';
import { normalizeOpenAICompatibleUsage, type OpenAICompatibleRawUsage } from './token-usage.js';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  jsonMode?: boolean;
  maxRetries?: number;
  contextWindow?: number;
  pricing?: ModelPricing;
  /**
   * 供应商是否支持 reasoning_effort（DeepSeek 推理模型）。
   * 由工厂按 baseUrl/model 判定；false 时即使前端传了思考强度也不会注入
   * DeepSeek 专属参数，避免破坏其他 OpenAI 兼容模型。
   */
  reasoningEffortSupported?: boolean;
}

/** 规整 Base URL：去尾部斜杠、剥离误填的完整 /chat/completions 端点。 */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}

/** 默认单次响应 token 上限（推理模型最终回答，含 reasoning 内容之外的正文）。 */
const DEFAULT_MAX_TOKENS = 8000;

export class OpenAICompatibleProvider implements MultimodalModelProvider {
  readonly providerId = 'openai-compatible';
  readonly name: string;
  readonly contextWindow?: number;
  readonly pricing?: ModelPricing;
  private readonly cfg: OpenAiCompatibleConfig;

  constructor(cfg: OpenAiCompatibleConfig) {
    this.cfg = { timeoutMs: 120_000, jsonMode: false, maxRetries: 2, reasoningEffortSupported: false, ...cfg };
    this.name = this.cfg.model;
    this.contextWindow = positiveInt(this.cfg.contextWindow);
    this.pricing = this.cfg.pricing;
  }

  /** 单次响应 token 上限：显示传入优先，否则使用默认值。 */
  private maxTokens(options?: ModelCallOptions): number {
    return options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = `${normalizeBaseUrl(this.cfg.baseUrl)}/models`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: this.headers(),
        },
        this.cfg.timeoutMs ?? 120_000
      );
      return res.ok;
    } catch (err) {
      console.warn('[hazard] provider 健康检查失败:', (err as Error).message);
      return false;
    }
  }

  async vision(text: string, image: ImagePayload, options?: ModelCallOptions): Promise<ModelCallResult> {
    const payload = this.visionPayload(text, image, options);
    return this.complete(payload, options);
  }

  async visionStream(text: string, image: ImagePayload, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    const payload = this.visionPayload(text, image, options);
    payload.stream = true;
    payload.stream_options = { include_usage: true };
    return this.completeStream(payload, options);
  }

  private visionPayload(text: string, image: ImagePayload, options?: ModelCallOptions): Record<string, unknown> {
    const payload = {
      model: this.cfg.model,
      temperature: 0.2,
      max_tokens: this.maxTokens(options),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            {
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
            },
          ],
        },
      ],
    } as Record<string, unknown>;
    if (this.cfg.jsonMode) payload.response_format = { type: 'json_object' };
    return payload;
  }

  async chat(system: string, user: string, options?: ModelCallOptions): Promise<ModelCallResult> {
    const payload = {
      model: this.cfg.model,
      temperature: 0.2,
      max_tokens: this.maxTokens(options),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    } as Record<string, unknown>;
    if (this.cfg.jsonMode) payload.response_format = { type: 'json_object' };
    return this.complete(payload, options);
  }

  async chatStream(system: string, user: string, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    const payload = {
      model: this.cfg.model,
      temperature: 0.2,
      max_tokens: this.maxTokens(options),
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    } as Record<string, unknown>;
    if (this.cfg.jsonMode) payload.response_format = { type: 'json_object' };
    return this.completeStream(payload, options);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  private async complete(payload: Record<string, unknown>, options?: ModelCallOptions): Promise<ModelCallResult> {
    if (this.cfg.reasoningEffortSupported && options?.reasoningEffort) {
      payload.reasoning_effort = options.reasoningEffort;
    }
    const url = `${normalizeBaseUrl(this.cfg.baseUrl)}/chat/completions`;
    const retries = this.cfg.maxRetries ?? 2;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const invocationId = `inv_${randomUUID()}`;
      const startedMs = Date.now();
      let attemptUsage: ReturnType<typeof normalizeOpenAICompatibleUsage> | undefined;
      let attemptUsageRaw: OpenAICompatibleRawUsage | undefined;
      let attemptRequestId: string | undefined;
      const serialized = JSON.stringify(payload);
      options?.telemetry?.onRequest({
        invocationId,
        attempt: attempt + 1,
        provider: this.providerId,
        model: this.name,
        startedAt: new Date(startedMs).toISOString(),
        payloadHash: createHash('sha256').update(serialized).digest('hex'),
        serializedTools: Array.isArray(payload.tools) ? payload.tools : undefined,
      });
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(payload),
          },
          this.cfg.timeoutMs ?? 120_000,
          options?.signal
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new ProviderHttpError(`模型接口返回 ${res.status}: ${bodyText.slice(0, 300)}`, res.status);
        }
        const data = (await res.json()) as {
          choices?: Array<{
            finish_reason?: string;
            message?: {
              content?: OpenAICompatibleContent;
              reasoning_content?: unknown;
            };
          }>;
          usage?: OpenAICompatibleRawUsage;
          error?: { message?: string };
        };
        attemptUsageRaw = data.usage;
        attemptUsage = data.usage ? normalizeOpenAICompatibleUsage(data.usage) : undefined;
        attemptRequestId = res.headers.get('x-request-id') ?? undefined;
        if (data.error?.message) throw new Error(`模型接口错误: ${data.error.message}`);
        const choice = data.choices?.[0];
        const content = normalizeAssistantContent(choice?.message?.content);
        if (!content) {
          throw new ProviderEmptyContentError({
            finishReason: choice?.finish_reason,
            reasoningPresent: hasNonEmptyText(choice?.message?.reasoning_content),
            completionTokens: attemptUsage?.outputTokens,
          });
        }
        const usage = attemptUsage;
        const requestId = attemptRequestId;
        options?.telemetry?.onResponse({
          invocationId,
          requestId,
          status: 'completed',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedMs,
          usage,
          usageRaw: data.usage,
        });
        return {
          text: content,
          attempts: attempt + 1,
          requestId,
          finishReason: choice?.finish_reason,
          usage,
        };
      } catch (err) {
        lastErr = err as Error;
        options?.telemetry?.onResponse({
          invocationId,
          status: 'failed',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedMs,
          errorCode: lastErr instanceof ProviderHttpError
            ? `HTTP_${lastErr.status}`
            : lastErr instanceof ProviderEmptyContentError
              ? 'PROVIDER_EMPTY_CONTENT'
              : 'PROVIDER_REQUEST_FAILED',
          requestId: attemptRequestId,
          usage: attemptUsage,
          usageRaw: attemptUsageRaw,
        });
        if (options?.signal?.aborted) throw lastErr;
        if (attempt < retries && shouldRetry(lastErr)) {
          await sleep(Math.min(1500, 300 * 2 ** attempt));
        } else {
          break;
        }
      }
    }
    throw lastErr ?? new Error('模型调用失败');
  }

  private async completeStream(payload: Record<string, unknown>, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    if (this.cfg.reasoningEffortSupported && options.reasoningEffort) {
      payload.reasoning_effort = options.reasoningEffort;
    }
    const url = `${normalizeBaseUrl(this.cfg.baseUrl)}/chat/completions`;
    const retries = this.cfg.maxRetries ?? 2;
    let lastErr: Error | null = null;
    let visibleDeltaEmitted = false;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const invocationId = `inv_${randomUUID()}`;
      const startedMs = Date.now();
      const serialized = JSON.stringify(payload);
      let attemptUsage: ReturnType<typeof normalizeOpenAICompatibleUsage> | undefined;
      let attemptUsageRaw: OpenAICompatibleRawUsage | undefined;
      let attemptRequestId: string | undefined;
      options.telemetry?.onRequest({
        invocationId,
        attempt: attempt + 1,
        provider: this.providerId,
        model: this.name,
        startedAt: new Date(startedMs).toISOString(),
        payloadHash: createHash('sha256').update(serialized).digest('hex'),
      });
      try {
        const res = await fetchWithTimeout(
          url,
          { method: 'POST', headers: this.headers(), body: serialized },
          this.cfg.timeoutMs ?? 120_000,
          options.signal
        );
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          throw new ProviderHttpError(`模型接口返回 ${res.status}: ${bodyText.slice(0, 300)}`, res.status);
        }
        attemptRequestId = res.headers.get('x-request-id') ?? undefined;
        const contentType = res.headers.get('content-type') ?? '';
        let text = '';
        let finishReason: string | undefined;

        if (!/text\/event-stream/i.test(contentType)) {
          const data = await parseNonStreamingResponse(res);
          text = data.text;
          finishReason = data.finishReason;
          attemptUsageRaw = data.usageRaw;
          attemptUsage = data.usageRaw ? normalizeOpenAICompatibleUsage(data.usageRaw) : undefined;
          if (text) {
            visibleDeltaEmitted = true;
            options.onTextDelta(text);
          }
        } else {
          if (!res.body) throw new Error('模型流式接口未返回响应体');
          const parsed = await consumeOpenAIStream(res.body, (delta) => {
            visibleDeltaEmitted = true;
            text += delta;
            options.onTextDelta(delta);
          });
          finishReason = parsed.finishReason;
          attemptUsageRaw = parsed.usageRaw;
          attemptUsage = parsed.usageRaw ? normalizeOpenAICompatibleUsage(parsed.usageRaw) : undefined;
        }

        if (!text.trim()) {
          throw new ProviderEmptyContentError({
            finishReason,
            reasoningPresent: false,
            completionTokens: attemptUsage?.outputTokens,
          });
        }
        options.telemetry?.onResponse({
          invocationId,
          requestId: attemptRequestId,
          status: 'completed',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedMs,
          usage: attemptUsage,
          usageRaw: attemptUsageRaw,
        });
        return {
          text: text.trim(),
          attempts: attempt + 1,
          requestId: attemptRequestId,
          finishReason,
          usage: attemptUsage,
        };
      } catch (err) {
        lastErr = err as Error;
        options.telemetry?.onResponse({
          invocationId,
          requestId: attemptRequestId,
          status: 'failed',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedMs,
          errorCode: lastErr instanceof ProviderHttpError
            ? `HTTP_${lastErr.status}`
            : lastErr instanceof ProviderEmptyContentError
              ? 'PROVIDER_EMPTY_CONTENT'
              : 'PROVIDER_STREAM_FAILED',
          usage: attemptUsage,
          usageRaw: attemptUsageRaw,
        });
        if (options.signal?.aborted || visibleDeltaEmitted) break;
        if (attempt < retries && shouldRetry(lastErr)) {
          await sleep(Math.min(1500, 300 * 2 ** attempt));
        } else {
          break;
        }
      }
    }
    throw lastErr ?? new Error('模型流式调用失败');
  }
}

async function parseNonStreamingResponse(res: Response): Promise<{
  text: string;
  finishReason?: string;
  usageRaw?: OpenAICompatibleRawUsage;
}> {
  const data = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: OpenAICompatibleContent } }>;
    usage?: OpenAICompatibleRawUsage;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(`模型接口错误: ${data.error.message}`);
  return {
    text: normalizeAssistantContent(data.choices?.[0]?.message?.content),
    finishReason: data.choices?.[0]?.finish_reason,
    usageRaw: data.usage,
  };
}

async function consumeOpenAIStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta: (delta: string) => void
): Promise<{ finishReason?: string; usageRaw?: OpenAICompatibleRawUsage }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | undefined;
  let usageRaw: OpenAICompatibleRawUsage | undefined;
  let doneMarker = false;

  const consumeBlock = (block: string) => {
    const dataText = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!dataText) return;
    if (dataText.trim() === '[DONE]') {
      doneMarker = true;
      return;
    }
    const chunk = JSON.parse(dataText) as {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: unknown };
        finish_reason?: string | null;
      }>;
      usage?: OpenAICompatibleRawUsage | null;
      error?: { message?: string };
    };
    if (chunk.error?.message) throw new Error(`模型接口错误: ${chunk.error.message}`);
    if (chunk.usage) usageRaw = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    // reasoning_content 有意不读取、不累计、不回调，防止隐藏推理越过 Provider 边界。
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
      onTextDelta(choice.delta.content);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consumeBlock(block);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!doneMarker && !finishReason) throw new Error('模型流式接口意外结束');
  return { finishReason, usageRaw };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type OpenAICompatibleContent = string | Array<
  string | {
    type?: string;
    text?: string | { value?: string };
    content?: string;
  }
> | null;

/**
 * OpenAI-compatible 网关并不都把 assistant content 序列化为纯字符串。
 * 这里只提取明确的可见正文，不读取 reasoning_content，避免把隐藏推理当成业务输出。
 */
function normalizeAssistantContent(content: OpenAICompatibleContent | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (part?.text && typeof part.text.value === 'string') return part.text.value;
      if (typeof part?.content === 'string') return part.content;
      return [];
    })
    .join('')
    .trim();
}

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

class ProviderEmptyContentError extends Error {
  constructor(details: { finishReason?: string; reasoningPresent: boolean; completionTokens?: number }) {
    const diagnostics = [
      details.finishReason ? `finish_reason=${details.finishReason}` : undefined,
      `reasoning_content=${details.reasoningPresent ? 'present' : 'absent'}`,
      details.completionTokens !== undefined ? `completion_tokens=${details.completionTokens}` : undefined,
    ].filter(Boolean).join(', ');
    super(`模型接口返回空内容（${diagnostics}）`);
    this.name = 'ProviderEmptyContentError';
  }
}

function shouldRetry(error: Error): boolean {
  // 部分推理/视觉实验模型会偶发返回 HTTP 200 + 空正文；重试仍受 maxRetries 严格限制。
  if (error instanceof ProviderEmptyContentError) return true;
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }
  return /超时|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(error.message);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<globalThis.Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const abortFromParent = () => ctrl.abort();
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (parentSignal?.aborted) throw new Error('模型请求已取消');
      throw new Error(`模型请求超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
