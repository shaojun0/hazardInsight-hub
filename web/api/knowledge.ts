/**
 * 知识库 API：标准文档列表与历史案例检索。
 */
import type { HistoricalCase, StandardDocument, StandardType } from '../../shared/types';
import { parseRes } from './client';

export interface StandardsResponse {
  data: StandardDocument[];
  disclaimer: string;
}

export async function fetchStandards(type?: StandardType | 'all'): Promise<StandardsResponse> {
  const q = type && type !== 'all' ? `?type=${type}` : '';
  const res = await fetch(`/api/standards${q}`);
  return parseRes<StandardsResponse>(res);
}

export interface CaseFilters {
  q?: string;
  category?: string;
  grade?: string;
}

export async function fetchCases(filters: CaseFilters): Promise<{ data: HistoricalCase[] }> {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.category && filters.category !== '全部') params.set('category', filters.category);
  if (filters.grade && filters.grade !== '全部') params.set('grade', filters.grade);
  const res = await fetch(`/api/cases?${params.toString()}`);
  return parseRes<{ data: HistoricalCase[] }>(res);
}