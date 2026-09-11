/**
 * 判定规则库 API：查询、TXT/CSV 导入、演示样本与清空。
 */
import type { GradingRule } from '../../shared/types';
import { parseRes } from './client';

export interface RulesResponse {
  data: GradingRule[];
  total: number;
}

export interface RulesImportResponse {
  ok: boolean;
  demo?: boolean;
  format?: 'txt' | 'csv';
  added: number;
  total: number;
  data: GradingRule[];
}

export async function fetchRules(): Promise<RulesResponse> {
  const res = await fetch('/api/rules');
  return parseRes<RulesResponse>(res);
}

export async function importRulesFile(file: File): Promise<RulesImportResponse> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch('/api/rules/import', { method: 'POST', body: fd });
  return parseRes<RulesImportResponse>(res);
}

export async function importDemoRules(): Promise<RulesImportResponse> {
  const res = await fetch('/api/rules/import-demo', { method: 'POST' });
  return parseRes<RulesImportResponse>(res);
}

export async function importDemoRulesCsv(): Promise<RulesImportResponse> {
  const res = await fetch('/api/rules/import-demo-csv', { method: 'POST' });
  return parseRes<RulesImportResponse>(res);
}

export async function clearRulesApi(): Promise<RulesResponse> {
  const res = await fetch('/api/rules/clear', { method: 'POST' });
  return parseRes<RulesResponse>(res);
}