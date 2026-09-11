/**
 * 多模态模型 Provider 抽象。
 * 不绑定任何供应商 SDK，统一通过 fetch 调用 OpenAI 兼容接口。
 * 预留统一接口，未来可扩展 Anthropic / 本地视觉模型 / 企业网关。
 */
import type { ModelCallTelemetry, ModelPricing } from '../../shared/context-observability.js';
import type { ReasoningEffort } from '../../shared/agent-protocol.js';
export interface ImagePayload {
  base64: string;
  mimeType: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  cachedTokensAvailable: boolean;
  /** Provider 适配层归一化后必须保证 cachedTokens 是 inputTokens 的子集。 */
  cachedTokensAreInputSubset: true;
  source: 'provider';
}

export interface ModelCallResult {
  text: string;
  attempts?: number;
  usage?: ModelTokenUsage;
  requestId?: string;
  finishReason?: string;
}

export interface ModelCallOptions {
  maxTokens?: number;
  /** 思考强度（DeepSeek reasoning effort）；Provider 仅对支持该参数的供应商（DeepSeek）注入 payload。 */
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** 由 Runtime 创建，Provider 在最终 payload 边界调用。 */
  telemetry?: ModelCallTelemetry;
}

export interface StreamingModelCallOptions extends ModelCallOptions {
  /** 只接收供应商公开正文 content；Provider 不得通过此回调暴露 reasoning_content。 */
  onTextDelta: (delta: string) => void;
}

export interface MultimodalModelProvider {
  readonly providerId: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly pricing?: ModelPricing;
  healthCheck(): Promise<boolean>;
  /** 多模态：传入图片 + 文本，返回模型原始文本 */
  vision(
    text: string,
    image: ImagePayload,
    options?: ModelCallOptions
  ): Promise<ModelCallResult>;
  /** 多模态流式输出；仅通过 onTextDelta 暴露公开正文 content。 */
  visionStream(
    text: string,
    image: ImagePayload,
    options: StreamingModelCallOptions
  ): Promise<ModelCallResult>;
  /** 纯文本对话（用于第二阶段推理检索上下文） */
  chat(system: string, user: string, options?: ModelCallOptions): Promise<ModelCallResult>;
  /** 用户可见纯文本流；返回值仍包含聚合后的完整正文与 usage。 */
  chatStream(system: string, user: string, options: StreamingModelCallOptions): Promise<ModelCallResult>;
}

export function createImagePayload(buffer: Buffer, mimeType: string): ImagePayload {
  return { mimeType, base64: buffer.toString('base64') };
}
