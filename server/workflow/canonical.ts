/** 稳定 JSON 序列化与内容寻址 hash。 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) output[key] = sortValue(input[key]);
  return output;
}

