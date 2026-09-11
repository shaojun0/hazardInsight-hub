/**
 * 轻量知识检索（keyword 匹配 + 类别加权）。
 * 预留 KnowledgeRetriever 接口以便未来替换为 BM25 / 向量检索 / ES / pgvector。
 */
import type { StandardClause, StandardType, HistoricalCase } from '../../shared/types.js';
import { createHash } from 'node:crypto';

import generalStandards from '../data/general_standards.json';
import nuclearStandards from '../data/nuclear_standards.json';
import enterpriseDocuments from '../data/enterprise_documents.json';
import historicalCases from '../data/historical_cases.json';

export interface StandardDocumentJson {
  id: string;
  type: StandardType;
  documentName: string;
  documentCode: string;
  version: string;
  status: string;
  updatedAt: string;
  category: string;
  clauses: Array<{
    id: string;
    clause: string;
    clauseTitle: string;
    content: string;
    category: string;
    keywords: string[];
  }>;
}

const ALL_DOCS: StandardDocumentJson[] = [
  ...(generalStandards as StandardDocumentJson[]),
  ...(nuclearStandards as StandardDocumentJson[]),
  ...(enterpriseDocuments as StandardDocumentJson[]),
];

/** 扁平化后的条款索引 */
export interface ClauseRecord extends StandardClause {
  docCategory: string;
}

export const CLAUSE_INDEX: ClauseRecord[] = [];
for (const doc of ALL_DOCS) {
  for (const c of doc.clauses) {
    CLAUSE_INDEX.push({
      id: c.id,
      type: doc.type,
      documentName: doc.documentName,
      documentCode: doc.documentCode,
      version: doc.version,
      clause: c.clause,
      clauseTitle: c.clauseTitle,
      content: c.content,
      category: c.category,
      keywords: c.keywords,
      docCategory: doc.category,
    });
  }
}

export const CASE_INDEX: HistoricalCase[] = historicalCases as HistoricalCase[];

const KNOWLEDGE_VERSION = createHash('sha256')
  .update(JSON.stringify({ documents: ALL_DOCS, cases: CASE_INDEX }))
  .digest('hex')
  .slice(0, 16);

export interface KnowledgeRetriever {
  searchStandards(query: string, category: string | null, top: number): Array<{ clause: ClauseRecord; score: number; relevance: number }>;
  searchCases(query: string, category: string | null, top: number): Array<{ caseRecord: HistoricalCase; score: number; similarity: number }>;
  listDocuments(type?: StandardType | 'all'): StandardDocumentJson[];
  listCases(filters: { q?: string; category?: string; grade?: string }): HistoricalCase[];
  getVersion(): string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createRetriever(): KnowledgeRetriever {
  return {
    searchStandards(query, category, top) {
      const q = normalizeQuery(query);
      const scored = CLAUSE_INDEX.map((clause) => {
        let score = 0;
        for (const kw of clause.keywords) {
          if (q.includes(kw)) score += 2;
        }
        if (category && (clause.category === category || clause.docCategory === category)) score += 3;
        // 条款标题命中加权
        for (const kw of clause.keywords) {
          if (kw.length >= 2 && q.includes(kw) && clause.clauseTitle.includes(kw)) score += 1;
        }
        return { clause, score };
      })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.clause.id.localeCompare(b.clause.id));

      const topN = scored.slice(0, top);
      return topN.map((r) => ({
        clause: r.clause,
        score: r.score,
        // 使用绝对分数带，避免“唯一弱命中也显示 95%”的相对归一化问题。
        relevance: Math.round(clamp(0.35 + r.score * 0.075, 0.4, 0.96) * 100) / 100,
      }));
    },

    searchCases(query, category, top) {
      const q = normalizeQuery(query);
      const scored = CASE_INDEX.map((c) => {
        let score = 0;
        if (category && c.category === category) score += 3;
        for (const kw of c.keywords) {
          if (q.includes(kw)) score += 1.5;
        }
        for (const kw of c.keywords) {
          if (c.description.includes(kw) && q.includes(kw)) score += 1;
        }
        // 描述片段重合（粗略）
        for (const kw of c.keywords.slice(0, 3)) {
          if (kw.length >= 2 && c.description.includes(kw) && q.includes(kw)) score += 0.5;
        }
        return { caseRecord: c, score };
      })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.caseRecord.caseId.localeCompare(b.caseRecord.caseId));

      const topN = scored.slice(0, top);
      return topN.map((r) => ({
        caseRecord: r.caseRecord,
        score: r.score,
        similarity: Math.round(clamp(0.32 + r.score * 0.075, 0.38, 0.95) * 100) / 100,
      }));
    },

    listDocuments(type) {
      const docs = type === 'all' || !type ? ALL_DOCS : ALL_DOCS.filter((d) => d.type === type);
      return docs.map((d) => ({ ...d }));
    },

    listCases(filters) {
      let list = CASE_INDEX;
      if (filters.q) {
        const q = filters.q.trim();
        list = list.filter(
          (c) =>
            c.description.includes(q) ||
            c.caseId.toLowerCase().includes(q.toLowerCase()) ||
            c.project.includes(q) ||
            c.keywords.some((k) => q.includes(k))
        );
      }
      if (filters.category && filters.category !== '全部') {
        list = list.filter((c) => c.category === filters.category);
      }
      if (filters.grade && filters.grade !== '全部') {
        list = list.filter((c) => c.grade === filters.grade);
      }
      return [...list].sort((a, b) => b.date.localeCompare(a.date));
    },

    getVersion() {
      return KNOWLEDGE_VERSION;
    },
  };
}

function normalizeQuery(query: string): string {
  return (query || '').normalize('NFKC').toLowerCase().replace(/[\s,，。；;：:、]+/g, ' ');
}
