/**
 * 判定规则解析器（TXT / CSV）。
 *
 * TXT 行格式：`<级别> <一级类目> <二级类目> [三级类目...] <编码>[*]<判定内容>`
 *   例：`b 现场作业 隧道作业 作业规程和要求 BSD07*未及时维护盾尾密封装置...`
 *
 * CSV 格式（可选表头，自适应）：
 *   表头列名识别：级别/等级/level，一级类目/二级类目/三级类目/category1..3，编码/code，判定内容/内容/text，加星/星标/starred
 *   无表头时按位置推断：第 1 列为级别，末两列为编码与判定内容（或末列合并 `编码*内容`），中间为类目。
 */
import type { GradingRule } from '../../shared/types.js';

export interface ParsedRule {
  level: string;
  categories: string[];
  code: string;
  starred: boolean;
  text: string;
}

const LEVEL_NAMES: Record<string, string> = {
  a: '基础管理类',
  b: '现场作业类',
  c: '特殊作业类',
};

const CODE_RE = /^([A-Z]{1,4}\d{2,})(\*?)(.*)$/;

function normalizeLevel(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (/^a|^基础/.test(v)) return 'a';
  if (/^b|^现场/.test(v)) return 'b';
  if (/^c|^特殊/.test(v)) return 'c';
  const first = v.charAt(0);
  return /^[a-z]$/.test(first) ? first : 'x';
}

/** 从「编码+文本」末列提取。 */
function splitCodeText(combined: string): { code: string; starred: boolean; text: string } | null {
  const m = CODE_RE.exec(combined);
  if (!m) return null;
  return { code: m[1], starred: m[2] === '*', text: (m[3] || '').trim() };
}

function normalizeCode(raw: string): { code: string; starred: boolean } {
  let code = raw.trim();
  let starred = false;
  if (code.startsWith('*')) {
    starred = true;
    code = code.slice(1);
  }
  if (code.endsWith('*')) {
    starred = true;
    code = code.slice(0, -1);
  }
  return { code, starred };
}

function toParsed(level: string, categories: string[], rawCode: string, starred: boolean, text: string): ParsedRule | null {
  const lvl = normalizeLevel(level);
  const n = normalizeCode(rawCode);
  const t = text.trim();
  if (!n.code) return null;
  return { level: lvl, categories: categories.filter(Boolean), code: n.code.toUpperCase(), starred: starred || n.starred, text: t };
}

/* ============================================================ TXT ============================================================ */

export function parseRulesText(text: string): ParsedRule[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tokensOf = (l: string) => l.split(/[\t ]+/).filter(Boolean);
  const codeIdxOf = (tokens: string[]) => tokens.findIndex((t, i) => i >= 1 && CODE_RE.test(t));

  // 第一遍：构建类目词典（供第二遍对无编码规则行切分类目/判定文本）。
  // 来源：带编码行的类目、以「其他/其它」结尾的叶子行类目、逗号路径标记行的类目与路径段。
  const dict = new Set<string>();
  for (const line of lines) {
    const tokens = tokensOf(line);
    if (tokens.length < 2) continue;
    const ci = codeIdxOf(tokens);
    if (ci > 0) {
      for (let i = 1; i < ci; i += 1) dict.add(tokens[i]);
      continue;
    }
    const last = tokens[tokens.length - 1];
    if (last === '其他' || last === '其它') {
      for (let i = 1; i < tokens.length - 1; i += 1) dict.add(tokens[i]);
      continue;
    }
    if (/[，,]/.test(last)) {
      for (let i = 1; i < tokens.length - 1; i += 1) dict.add(tokens[i]);
      for (const s of last.split(/[，,]/)) if (s) dict.add(s);
    }
  }

  const out: ParsedRule[] = [];
  for (const line of lines) {
    const tokens = tokensOf(line);
    if (tokens.length < 2) continue;
    const ci = codeIdxOf(tokens);
    if (ci > 0) {
      // 带编码行：编码 token 及其后（可跨空格，判定文本内部可能含空格）整体是「编码[星号]判定文本」
      const combined = tokens.slice(ci).join(' ');
      const split = splitCodeText(combined);
      if (!split) continue;
      const p = toParsed(tokens[0], tokens.slice(1, ci), split.code, split.starred, split.text);
      if (p) out.push(p);
      continue;
    }
    const last = tokens[tokens.length - 1];
    if (last === '其他' || last === '其它') continue; // 类目叶子行（无判定内容）
    // 无编码规则行（如 c/d 级）：按词典贪心切分类目与判定文本
    let j = 1;
    while (j < tokens.length - 1 && dict.has(tokens[j])) j += 1;
    if (j === tokens.length - 1) {
      // 仅剩末 token：判断是「类目路径标记行」还是「判定文本」
      const segs = last.split(/[，,]/).filter(Boolean);
      if (segs.length >= 2 && segs.every((s) => dict.has(s))) continue; // 类目路径标记行，跳过
      const p = toParsedNoCode(tokens[0], tokens.slice(1, j), last);
      if (p) out.push(p);
      continue;
    }
    const p = toParsedNoCode(tokens[0], tokens.slice(1, j), tokens.slice(j).join(' '));
    if (p) out.push(p);
  }
  return out;
}

/** 无编码规则的确定性编码：FNV-1a 64 位哈希文本，避免重复导入时因编码变化而重复入库。 */
function hash64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return 'R' + h.toString(16).toUpperCase().padStart(16, '0');
}

function toParsedNoCode(level: string, categories: string[], text: string): ParsedRule | null {
  const t = text.trim();
  if (!t) return null;
  const lvl = normalizeLevel(level);
  return { level: lvl, categories: categories.filter(Boolean), code: hash64(t), starred: false, text: t };
}

/* ============================================================ CSV ============================================================ */

/** 简易 RFC4180 CSV 解析（支持引号、转义双引号、字段内换行）。 */
export function parseCsv(text: string, options: { strict?: boolean } = {}): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let closedQuote = false;
  const chars = [...text];
  const flush = () => {
    row.push(field);
    field = '';
    closedQuote = false;
  };
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (inQuotes) {
      if (c === '"') {
        if (chars[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      if (options.strict && (field !== '' || closedQuote)) throw new Error('CSV 引号位置不正确。');
      inQuotes = true;
    } else if (c === ',') {
      flush();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && chars[i + 1] === '\n') i += 1;
      flush();
      rows.push(row);
      row = [];
    } else {
      if (options.strict && closedQuote) throw new Error('CSV 引号结束后应为分隔符或换行。');
      field += c;
    }
  }
  if (options.strict && inQuotes) throw new Error('CSV 引号未闭合，请检查文件格式。');
  if (field !== '' || row.length || closedQuote) {
    flush();
    rows.push(row);
  }
  return rows.filter((r) => r.some((s) => s.trim() !== ''));
}

type HeaderMap = { level?: number; cat1?: number; cat2?: number; cat3?: number; code?: number; text?: number; starred?: number };

function classifyHeaderCell(cell: string): keyof HeaderMap | 'cat' | null {
  const v = cell.trim().toLowerCase();
  if (/^(级别|等级|级|level|lvl)$/i.test(v)) return 'level';
  if (/^(一级类目|一级分类|类目一|类目1|一级|大类|c1|category1|cat1)$/i.test(v)) return 'cat1';
  if (/^(二级类目|二级分类|类目二|类目2|二级|中类|c2|category2|cat2)$/i.test(v)) return 'cat2';
  if (/^(三级类目|三级分类|类目三|类目3|三级|小类|c3|category3|cat3)$/i.test(v)) return 'cat3';
  if (/^(编码|编号|代码|code|ruleid|rule.?id|id)$/i.test(v)) return 'code';
  if (/^(判定内容|规则内容|内容描述|内容|描述|判定|文本|text|content|description)$/i.test(v)) return 'text';
  if (/^(加星|星标|强条|星|star|starred)$/i.test(v)) return 'starred';
  if (/^(类目|分类|类别|category|cat|type|专业|directory)/i.test(v)) return 'cat';
  return null;
}

function detectHeader(row: string[]): HeaderMap | null {
  const h: HeaderMap = {};
  let recognized = 0;
  row.forEach((cell, idx) => {
    const role = classifyHeaderCell(cell);
    if (role === 'level') {
      if (h.level === undefined) {
        h.level = idx;
        recognized += 1;
      }
    } else if (role === 'cat1' || role === 'cat') {
      if (h.cat1 === undefined) {
        h.cat1 = idx;
        recognized += 1;
      } else if (h.cat2 === undefined) h.cat2 = idx;
      else if (h.cat3 === undefined) h.cat3 = idx;
    } else if (role === 'cat2') {
      h.cat2 = idx;
      recognized += 1;
    } else if (role === 'cat3') {
      h.cat3 = idx;
      recognized += 1;
    } else if (role === 'code') {
      h.code = idx;
      recognized += 1;
    } else if (role === 'text') {
      h.text = idx;
      recognized += 1;
    } else if (role === 'starred') {
      h.starred = idx;
      recognized += 1;
    }
  });
  // 判定为表头：至少识别出 级别 + (编码或内容) 中的两项
  const hasCore = h.level !== undefined && (h.code !== undefined || h.text !== undefined);
  return hasCore && recognized >= 2 ? h : null;
}

const STAR_VALUE = /^(\*|是|yes|true|1|强条)$/i;

function rowFromHeader(row: string[], h: HeaderMap): ParsedRule | null {
  const get = (idx?: number) => (idx === undefined ? '' : row[idx] || '');
  const level = get(h.level) || row[0] || '';
  const cats = [get(h.cat1), get(h.cat2), get(h.cat3)].filter(Boolean);
  const rawCode = get(h.code);
  const text = get(h.text);
  const starCol = h.starred !== undefined ? STAR_VALUE.test(get(h.starred)) : false;

  if (!rawCode && h.code === undefined) {
    // 编码列缺失：尝试将内容列/末列当作「编码*内容」合并
    const combinedField = text || row[row.length - 1] || '';
    const split = splitCodeText(combinedField);
    if (!split) return null;
    return toParsed(level, cats, split.code, split.starred || starCol, split.text);
  }
  return toParsed(level, cats, rawCode, starCol, text);
}

function rowFromPositional(row: string[]): ParsedRule | null {
  if (row.length < 3) return null;
  const level = row[0];
  const last = row[row.length - 1];
  const secondToLast = row[row.length - 2];

  // 末列形如「编码*内容」（TXT 风格合并列）
  const combined = splitCodeText(last);
  if (combined) {
    const categories = row.slice(1, row.length - 1);
    return toParsed(level, categories, combined.code, combined.starred, combined.text);
  }
  // 独立编码列 + 内容列
  const categories = row.slice(1, row.length - 2);
  return toParsed(level, categories, secondToLast, false, last);
}

export function parseRulesCsv(csvText: string): ParsedRule[] {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const header = detectHeader(rows[0]);
  const start = header ? 1 : 0;
  const out: ParsedRule[] = [];
  for (let i = start; i < rows.length; i += 1) {
    const row = rows[i].map((s) => s.trim());
    if (row.every((s) => !s)) continue;
    const p = header ? rowFromHeader(row, header) : rowFromPositional(row);
    if (p) out.push(p);
  }
  return out;
}

/* ============================================================ 输出 ============================================================ */

export function toGradingRule(parsed: ParsedRule, index: number, importedAt = new Date().toISOString()): GradingRule {
  return {
    id: `RULE-${String(index + 1).padStart(3, '0')}`,
    level: parsed.level,
    levelName: LEVEL_NAMES[parsed.level] ?? `级别 ${parsed.level.toUpperCase()}`,
    categories: parsed.categories,
    categoryPath: parsed.categories.join(' / '),
    code: parsed.code,
    starred: parsed.starred,
    text: parsed.text,
    source: 'imported',
    importedAt,
  };
}
