/** Workflow State 的安全路径读取与受限 Patch。 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue, StatePatchOperation } from '../../shared/workflow-schema.js';

export interface WorkflowNodeState {
  status: string;
  output?: unknown;
  error?: unknown;
  attempts: number;
}

export interface WorkflowState {
  input: Record<string, unknown>;
  data: Record<string, unknown>;
  nodes: Record<string, WorkflowNodeState>;
  approvals: Record<string, unknown>;
  meta: Record<string, unknown>;
}

const BLOCKED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function readStatePath(root: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  const parsed = parseStatePath(path);
  if (!parsed) return { found: false };
  let current: unknown = root[parsed.namespace];
  if (!parsed.segments.length) return current === undefined ? { found: false } : { found: true, value: current };
  for (const segment of parsed.segments) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false };
    current = record[segment];
  }
  return { found: true, value: current };
}

export function setStatePath(root: Record<string, unknown>, path: string, value: unknown, mode: 'add' | 'replace'): void {
  const parsed = parseStatePath(path);
  if (!parsed || parsed.namespace === 'input' || parsed.namespace === 'nodes' || parsed.namespace === 'output') {
    throw new Error(`禁止写入 State 路径：${path}`);
  }
  if (!parsed.segments.length) throw new Error(`禁止替换 namespace 根：${path}`);
  let current = root[parsed.namespace];
  if (!current || typeof current !== 'object') throw new Error(`State 父路径不存在：${path}`);
  for (let index = 0; index < parsed.segments.length - 1; index += 1) {
    const segment = parsed.segments[index];
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        throw new Error(`State 数组路径不存在：${path}`);
      }
      current = current[arrayIndex];
    } else {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        if (mode === 'add') record[segment] = {};
        else throw new Error(`State 父路径不存在：${path}`);
      }
      current = record[segment];
    }
    if (!current || typeof current !== 'object') throw new Error(`State 父路径不是容器：${path}`);
  }

  const last = parsed.segments.at(-1)!;
  if (Array.isArray(current)) {
    if (mode === 'add' && last === '-') {
      current.push(structuredClone(value));
      return;
    }
    const arrayIndex = Number(last);
    if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
      throw new Error(`State 数组路径不存在：${path}`);
    }
    current[arrayIndex] = structuredClone(value);
    return;
  }

  const record = current as Record<string, unknown>;
  if (mode === 'replace' && !Object.prototype.hasOwnProperty.call(record, last)) {
    throw new Error(`replace 目标不存在：${path}`);
  }
  record[last] = structuredClone(value);
}

export function applyStatePatch(state: WorkflowState, operations: StatePatchOperation[]): void {
  const root = state as unknown as Record<string, unknown>;
  for (const operation of operations) {
    if (operation.op === 'test') {
      const actual = readStatePath(root, operation.path);
      if (!actual.found || !isDeepStrictEqual(actual.value, operation.value)) {
        throw new Error(`State test 失败：${operation.path}`);
      }
      continue;
    }
    setStatePath(root, operation.path, operation.value as JsonValue, operation.op);
  }
}

function parseStatePath(path: string): { namespace: string; segments: string[] } | null {
  const match = path.match(/^([a-z]+)#(\/.*)?$/);
  if (!match) return null;
  const pointer = match[2] ?? '';
  const segments = pointer
    ? pointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    : [];
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) return null;
  return { namespace: match[1], segments };
}

