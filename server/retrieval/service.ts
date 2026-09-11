/** RAG 服务：query normalize、版本化缓存、来源多样性与稳定 evidence bundle。 */
import { createHash } from 'node:crypto';
import { VersionedTtlCache } from '../agent/cache/versioned-cache.js';
import type { HistoricalCase } from '../../shared/types.js';
import type { ClauseRecord, KnowledgeRetriever } from './index.js';

export const RERANK_VERSION = 'deterministic-rerank-v2';

export interface KnowledgeBundle {
  query: string;
  standards: Array<{ clause: ClauseRecord; score: number; relevance: number }>;
  cases: Array<{ caseRecord: HistoricalCase; score: number; similarity: number }>;
  cacheHit: boolean;
  cacheAgeMs?: number;
  knowledgeVersion: string;
  rerankVersion: string;
}

type CachedBundle = Omit<KnowledgeBundle, 'cacheHit' | 'cacheAgeMs'>;

export class KnowledgeRetrievalService {
  private readonly cache = new VersionedTtlCache<CachedBundle>(2000, 10 * 60 * 1000);

  constructor(private readonly retriever: KnowledgeRetriever) {}

  getVersion(): string {
    return this.retriever.getVersion();
  }

  retrieve(query: string, category: string | null, standardTop = 6, caseTop = 4): KnowledgeBundle {
    const normalized = normalizeQuery(query);
    const version = this.getVersion();
    const key = createHash('sha256')
      .update(JSON.stringify({ version, rerank: RERANK_VERSION, query: normalized, category, standardTop, caseTop }))
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached.hit && cached.value) {
      return { ...cached.value, cacheHit: true, cacheAgeMs: cached.ageMs };
    }

    const rawStandards = this.retriever.searchStandards(normalized, category, Math.max(12, standardTop * 3));
    const rawCases = this.retriever.searchCases(normalized, category, Math.max(8, caseTop * 2));
    const standards = diversifyStandards(rawStandards.filter((hit) => hit.relevance >= 0.6), standardTop);
    const cases = rawCases.filter((hit) => hit.similarity >= 0.45).slice(0, caseTop);
    const value: CachedBundle = {
      query: normalized,
      standards,
      cases,
      knowledgeVersion: version,
      rerankVersion: RERANK_VERSION,
    };
    this.cache.set(key, value, `${version}:${RERANK_VERSION}`);
    return { ...value, cacheHit: false };
  }
}

function normalizeQuery(query: string): string {
  return (query || '').normalize('NFKC').toLowerCase().replace(/[\s,，。；;：:、]+/g, ' ').trim();
}

function diversifyStandards<T extends { clause: ClauseRecord; score: number; relevance: number }>(hits: T[], top: number): T[] {
  const selected: T[] = [];
  const used = new Set<string>();
  for (const type of ['general', 'nuclear', 'enterprise'] as const) {
    const hit = hits.find((item) => item.clause.type === type && !used.has(item.clause.id));
    if (hit) {
      selected.push(hit);
      used.add(hit.clause.id);
    }
  }
  for (const hit of hits) {
    if (selected.length >= top) break;
    if (used.has(hit.clause.id)) continue;
    selected.push(hit);
    used.add(hit.clause.id);
  }
  return selected.slice(0, top);
}
