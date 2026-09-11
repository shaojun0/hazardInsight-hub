/** 安全加载 YAML/JSON Workflow，并通过权威 Zod Schema。 */
import { parseDocument } from 'yaml';
import { workflowDefinitionSchema, type WorkflowDefinition } from '../../shared/workflow-schema.js';

const MAX_SOURCE_BYTES = 1024 * 1024;

export type WorkflowSourceFormat = 'yaml' | 'json';

export interface WorkflowLoadIssue {
  path: string;
  message: string;
}

export class WorkflowLoadError extends Error {
  constructor(readonly issues: WorkflowLoadIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'WorkflowLoadError';
  }
}

export function inferWorkflowFormat(contentType: string | undefined, source: string): WorkflowSourceFormat {
  if (/ya?ml/i.test(contentType ?? '')) return 'yaml';
  return source.trimStart().startsWith('{') ? 'json' : 'yaml';
}

export function loadWorkflowSource(source: string, format: WorkflowSourceFormat): WorkflowDefinition {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new WorkflowLoadError([{ path: '$', message: 'Workflow 配置超过 1MB 上限。' }]);
  }

  let raw: unknown;
  try {
    if (format === 'json') {
      raw = JSON.parse(source);
    } else {
      const document = parseDocument(source, {
        uniqueKeys: true,
        customTags: [],
        prettyErrors: false,
      });
      if (document.errors.length) {
        throw new WorkflowLoadError(document.errors.map((error) => ({ path: '$', message: error.message })));
      }
      raw = document.toJS({ maxAliasCount: 20 });
    }
  } catch (error) {
    if (error instanceof WorkflowLoadError) throw error;
    throw new WorkflowLoadError([{ path: '$', message: `配置解析失败：${(error as Error).message}` }]);
  }

  return parseWorkflowObject(raw);
}

export function parseWorkflowObject(raw: unknown): WorkflowDefinition {
  assertSafeObjectGraph(raw);
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowLoadError(parsed.error.issues.map((issue) => ({
      path: issue.path.length ? `$.${issue.path.join('.')}` : '$',
      message: issue.message,
    })));
  }
  return parsed.data;
}

function assertSafeObjectGraph(raw: unknown): void {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: raw, depth: 0, path: '$' }];
  const seen = new WeakSet<object>();
  let values = 0;
  while (stack.length) {
    const current = stack.pop()!;
    values += 1;
    if (values > 100_000) throw new WorkflowLoadError([{ path: '$', message: 'Workflow 对象节点数超过安全上限。' }]);
    if (current.depth > 64) throw new WorkflowLoadError([{ path: current.path, message: 'Workflow 嵌套深度超过 64 层。' }]);
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) throw new WorkflowLoadError([{ path: current.path, message: 'Workflow 不允许循环引用或共享对象别名。' }]);
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => stack.push({ value, depth: current.depth + 1, path: `${current.path}.${index}` }));
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowLoadError([{ path: current.path, message: 'Workflow 只允许普通 JSON 对象。' }]);
    }
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new WorkflowLoadError([{ path: `${current.path}.${key}`, message: 'Workflow 包含禁止的对象键。' }]);
      }
      stack.push({ value, depth: current.depth + 1, path: `${current.path}.${key}` });
    }
  }
}
