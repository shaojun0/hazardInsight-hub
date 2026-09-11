/**
 * 隐患台账（隐患防控页数据源，localStorage 持久化）。
 */
import type { Grade } from '../../shared/types';

export type LedgerStatus = 'pending' | 'processing' | 'closed';

export const STATUS_META: Record<LedgerStatus, { label: string; tone: string }> = {
  pending: { label: '待整改', tone: '#e0342f' },
  processing: { label: '整改中', tone: '#e97a1f' },
  closed: { label: '已闭环', tone: '#0e9f6e' },
};

export interface LedgerItem {
  id: string;
  source: 'camera' | 'robot' | 'workbench' | 'manual';
  title: string;
  category: string;
  description: string;
  possibleConsequence?: string;
  evidence: string[];
  rectificationTexts: string[];
  grade: Grade;
  confidence: number;
  image?: { dataUrl: string; name: string };
  foundAt: string;
  status: LedgerStatus;
  owner?: string;
  dueDate?: string;
  remark?: string;
}

const KEY = 'hazard.ledger.v1';

export function loadLedger(): LedgerItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LedgerItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(items: LedgerItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* noop */
  }
}

export function addLedgerItems(items: LedgerItem[]): LedgerItem[] {
  const all = [...items, ...loadLedger()].slice(0, 200);
  persist(all);
  return all;
}

export function updateLedgerItem(id: string, patch: Partial<LedgerItem>): LedgerItem[] {
  const all = loadLedger().map((it) => (it.id === id ? { ...it, ...patch } : it));
  persist(all);
  return all;
}

export function removeLedgerItem(id: string): LedgerItem[] {
  const all = loadLedger().filter((it) => it.id !== id);
  persist(all);
  return all;
}

export function clearLedger(): LedgerItem[] {
  persist([]);
  return [];
}
