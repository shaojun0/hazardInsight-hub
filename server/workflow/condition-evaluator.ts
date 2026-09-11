/** 受限 Condition AST 求值；不使用 eval、动态函数或模板执行。 */
import { isDeepStrictEqual } from 'node:util';
import type { ConditionExpr, JsonPrimitive } from '../../shared/workflow-schema.js';
import { readStatePath } from './state.js';

export function evaluateCondition(condition: ConditionExpr, state: Record<string, unknown>): boolean {
  if ('all' in condition) return condition.all.every((item) => evaluateCondition(item, state));
  if ('any' in condition) return condition.any.some((item) => evaluateCondition(item, state));
  if ('not' in condition) return !evaluateCondition(condition.not, state);
  if ('exists' in condition) return readStatePath(state, condition.exists.path).found;
  if ('eq' in condition) {
    const result = readStatePath(state, condition.eq.path);
    return result.found && isDeepStrictEqual(result.value, condition.eq.value);
  }
  if ('in' in condition) {
    const result = readStatePath(state, condition.in.path);
    return result.found && condition.in.values.some((value) => isDeepStrictEqual(value, result.value as JsonPrimitive));
  }
  if ('gt' in condition) return numericValue(state, condition.gt.path, (value) => value > condition.gt.value);
  if ('gte' in condition) return numericValue(state, condition.gte.path, (value) => value >= condition.gte.value);
  if ('lt' in condition) return numericValue(state, condition.lt.path, (value) => value < condition.lt.value);
  if ('lte' in condition) return numericValue(state, condition.lte.path, (value) => value <= condition.lte.value);
  return false;
}

function numericValue(state: Record<string, unknown>, path: string, compare: (value: number) => boolean): boolean {
  const result = readStatePath(state, path);
  return result.found && typeof result.value === 'number' && Number.isFinite(result.value) && compare(result.value);
}
