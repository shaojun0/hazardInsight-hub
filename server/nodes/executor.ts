/** 单次 Node 执行：输入/配置/输出 Schema、timeout、标准化错误和幂等结果复用。 */
import type { NodeExecutionRequest, NodeExecutionResult, NormalizedWorkflowError } from '../../shared/node-protocol.js';
import type { NodeRegistry } from './registry.js';

export class NodeExecutor {
  private readonly idempotentResults = new Map<string, NodeExecutionResult<unknown>>();

  constructor(private readonly registry: NodeRegistry) {}

  async executeOnce(input: {
    use: string;
    request: Omit<NodeExecutionRequest<unknown, unknown>, 'input' | 'config' | 'signal'>;
    nodeInput: unknown;
    config: unknown;
    timeoutMs: number;
  }): Promise<NodeExecutionResult<unknown>> {
    const definition = this.registry.resolve(input.use);
    if (!definition?.execute) {
      return failed({
        code: definition ? 'NODE_NOT_IMPLEMENTED' : 'NODE_NOT_REGISTERED',
        category: 'validation',
        message: definition ? `Node 执行适配器尚未接入：${input.use}` : `Node 未注册：${input.use}`,
        retryable: false,
      });
    }

    const parsedInput = definition.inputSchema.safeParse(input.nodeInput);
    if (!parsedInput.success) {
      return failed({
        code: 'NODE_INPUT_INVALID',
        category: 'validation',
        message: `Node 输入未通过 Schema：${parsedInput.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        retryable: false,
      });
    }
    const parsedConfig = definition.configSchema.safeParse(input.config);
    if (!parsedConfig.success) {
      return failed({
        code: 'NODE_CONFIG_INVALID',
        category: 'validation',
        message: `Node 配置未通过 Schema：${parsedConfig.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        retryable: false,
      });
    }

    const dedupeKey = input.request.idempotencyKey;
    if (definition.capabilities.sideEffect === 'idempotent' && dedupeKey) {
      const cached = this.idempotentResults.get(dedupeKey);
      if (cached) return structuredClone(cached);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<NodeExecutionResult<unknown>>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failed({
          code: 'NODE_TIMEOUT',
          category: 'timeout',
          message: `Node 执行超过 ${input.timeoutMs}ms。`,
          retryable: definition.capabilities.supportsRetry,
        }));
      }, input.timeoutMs);
    });

    let result: NodeExecutionResult<unknown>;
    try {
      result = await Promise.race([
        definition.execute({
          ...input.request,
          input: parsedInput.data,
          config: parsedConfig.data,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error) {
      result = failed({
        code: 'NODE_INTERNAL',
        category: 'internal',
        message: (error as Error).message || 'Node 执行异常。',
        retryable: false,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result.status === 'succeeded') {
      const parsedOutput = definition.outputSchema.safeParse(result.output);
      if (!parsedOutput.success) {
        return failed({
          code: 'NODE_OUTPUT_INVALID',
          category: 'validation',
          message: `Node 输出未通过 Schema：${parsedOutput.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
          retryable: definition.capabilities.supportsRetry,
        });
      }
      result = { ...result, output: parsedOutput.data };
    }

    if (definition.capabilities.sideEffect === 'idempotent' && dedupeKey && result.status === 'succeeded') {
      this.idempotentResults.set(dedupeKey, structuredClone(result));
    }
    return result;
  }
}

function failed(error: NormalizedWorkflowError): NodeExecutionResult<never> {
  return { status: 'failed', error };
}

