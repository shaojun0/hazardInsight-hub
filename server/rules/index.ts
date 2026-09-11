/**
 * 规则库存储：持久化导入的判定规则到项目根 `.rules-imported.json`（gitignore）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { GradingRule } from '../../shared/types.js';
import { parseRulesCsv, parseRulesText, toGradingRule, type ParsedRule } from './parser.js';

const RULES_FILE = resolve(process.cwd(), '.rules-imported.json');

function loadFromDisk(): GradingRule[] {
  try {
    if (existsSync(RULES_FILE)) {
      const parsed = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
      if (Array.isArray(parsed)) return parsed as GradingRule[];
    }
  } catch {
    // 文件损坏时忽略
  }
  return [];
}

let activeRules = loadFromDisk();

function versionOf(rules: GradingRule[]): string {
  return createHash('sha256')
    .update(JSON.stringify(rules.map(({ id, code, level, categories, starred, text }) => ({ id, code, level, categories, starred, text }))))
    .digest('hex')
    .slice(0, 16);
}

let activeRuleVersion = versionOf(activeRules);

function save(rules: GradingRule[]): void {
  activeRules = rules;
  activeRuleVersion = versionOf(rules);
  try {
    writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  } catch {
    // 落盘失败不影响内存
  }
}

export function getRules(): GradingRule[] {
  return [...activeRules];
}

export function clearRules(): GradingRule[] {
  save([]);
  return [];
}

/** 解析并按编码去重后追加导入。 */
function importParsed(parsed: ParsedRule[]): { rules: GradingRule[]; added: number; total: number } {
  const existing = getRules();
  if (!parsed.length) return { rules: existing, added: 0, total: existing.length };

  const seen = new Set(existing.map((r) => r.code));
  const now = new Date().toISOString();
  let added = 0;
  for (const p of parsed) {
    if (seen.has(p.code)) continue;
    seen.add(p.code);
    existing.push(toGradingRule(p, existing.length, now));
    added += 1;
  }
  save(existing);
  return { rules: existing, added, total: existing.length };
}

export function importRulesText(text: string): { rules: GradingRule[]; added: number; total: number } {
  return importParsed(parseRulesText(text));
}

export function importRulesCsv(csvText: string): { rules: GradingRule[]; added: number; total: number } {
  return importParsed(parseRulesCsv(csvText));
}

/** 当前生效规则内容版本；导入/清空后自动变化，用于 context/retrieval cache key。 */
export function getRuleSetVersion(): string {
  return activeRuleVersion;
}
