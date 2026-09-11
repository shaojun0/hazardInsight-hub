/**
 * 导入判定规则匹配。
 * level(a/b/c) 是业务 taxonomy，不映射到风险 A/B/C/D；星标规则只触发人工复核，不直接覆盖风险矩阵。
 */
import type { GradingRule, RuleReference } from '../../shared/types.js';
import { getRules, getRuleSetVersion } from './index.js';

interface ConceptGroup {
  terms: string[];
  /** 具体对象/致因权重大；线路、高处等宽泛概念只能作为辅助命中。 */
  weight: number;
}

const CONCEPT_GROUPS: ConceptGroup[] = [
  { terms: ['插排', '插座', '接线板', '插头'], weight: 4 },
  { terms: ['电源线', '电线', '电缆', '线路', '导线'], weight: 1 },
  { terms: ['过载', '超负荷', '负荷', '发热'], weight: 4 },
  { terms: ['短路'], weight: 3 },
  { terms: ['裸露', '破皮', '老化', '绝缘破损', '未进行绝缘防护'], weight: 3 },
  { terms: ['触电', '带电', '漏电'], weight: 2 },
  { terms: ['液体', '水瓶', '水杯', '进水', '受潮'], weight: 5 },
  { terms: ['配电箱', '开关箱', '电箱'], weight: 5 },
  { terms: ['安全带', '系挂', '挂点'], weight: 5 },
  { terms: ['脚手板', '钢跳板', '满铺', '铺满', '板面'], weight: 5 },
  { terms: ['脚手架', '架体'], weight: 2 },
  { terms: ['临边', '洞口', '防护栏杆', '挡脚板'], weight: 5 },
  { terms: ['坠落', '高处'], weight: 2 },
  { terms: ['起重', '吊装', '吊具'], weight: 5 },
  { terms: ['消防', '灭火器', '消防通道'], weight: 4 },
  { terms: ['动火', '焊接', '气瓶'], weight: 4 },
  { terms: ['易燃', '可燃'], weight: 4 },
  { terms: ['通道', '堵塞'], weight: 3 },
  { terms: ['杂物', '废物', '垃圾', '整洁有序'], weight: 4 },
  { terms: ['材料', '堆放', '码放'], weight: 4 },
  { terms: ['机械', '设备防护', '防护罩'], weight: 5 },
  { terms: ['有限空间', '受限空间'], weight: 5 },
];

const CATEGORY_ALIASES: Record<string, string[]> = {
  临时用电: ['临时用电', '配电箱', '电缆线路', '安全电压'],
  文明施工: ['文明施工', '现场工作环境'],
  高处作业: ['高处作业', '安全带'],
  脚手架: ['脚手架'],
  临边洞口: ['临边', '洞口'],
  起重吊装: ['起重', '吊装'],
  动火作业: ['动火', '焊接'],
  消防: ['消防'],
  通道堵塞: ['通道'],
  材料堆放: ['材料', '堆放'],
  有限空间: ['有限空间', '受限空间'],
};

export interface MatchedRule {
  key: string;
  rule: GradingRule;
  relevance: number;
  requiresReview: boolean;
}

export class RuleMatcher {
  getVersion(): string {
    return getRuleSetVersion();
  }

  match(query: string, category: string | null, top = 5): MatchedRule[] {
    const normalized = query.normalize('NFKC').toLowerCase();
    return getRules()
      .map((rule) => ({ rule, score: scoreRule(rule, normalized, category) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.rule.code.localeCompare(b.rule.code))
      .slice(0, top)
      .map((entry, index) => ({
        key: `R${index}`,
        rule: entry.rule,
        relevance: Math.round(Math.min(0.96, 0.32 + entry.score * 0.07) * 100) / 100,
        requiresReview: entry.rule.starred,
      }));
  }
}

export function toRuleReference(match: MatchedRule, reason: string): RuleReference {
  return {
    ruleId: match.rule.id,
    code: match.rule.code,
    level: match.rule.level,
    levelName: match.rule.levelName,
    categoryPath: match.rule.categoryPath,
    text: match.rule.text,
    starred: match.rule.starred,
    relevance: match.relevance,
    reason,
  };
}

function scoreRule(rule: GradingRule, query: string, category: string | null): number {
  let categoryScore = 0;
  if (category) {
    if (rule.categories.some((item) => item === category)) categoryScore += 1.5;
    else if (
      rule.categoryPath.includes(category)
      || category.includes(rule.categories.at(-1) ?? '\u0000')
      || (CATEGORY_ALIASES[category] ?? []).some((alias) => rule.categoryPath.includes(alias))
    ) categoryScore += 0.75;
  }
  const ruleText = `${rule.categoryPath} ${rule.text}`.toLowerCase();
  let conceptScore = 0;
  let exactTermBonus = 0;
  let matchedConcepts = 0;
  for (const group of CONCEPT_GROUPS) {
    const queryTerms = group.terms.filter((term) => query.includes(term.toLowerCase()));
    const ruleTerms = group.terms.filter((term) => ruleText.includes(term.toLowerCase()));
    if (queryTerms.length && ruleTerms.length) {
      matchedConcepts += 1;
      conceptScore += group.weight;
      if (queryTerms.some((term) => ruleTerms.includes(term))) exactTermBonus += 1;
    }
  }
  // 只有具体对象/致因命中才召回；类目或单个“线路/高处”等宽泛概念不足以注入 Prompt。
  if (conceptScore < 3 || (categoryScore === 0 && (matchedConcepts < 2 || conceptScore < 10))) return 0;
  return categoryScore + conceptScore + exactTermBonus + (rule.starred ? 0.5 : 0);
}
