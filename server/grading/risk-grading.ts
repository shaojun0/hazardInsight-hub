/**
 * A/B/C/D 隐患智能定级规则。
 * 核心原则：定级不能只输出一个字母 —— 每条隐患输出 grade + gradeReason + 严重度/可能性/风险值。
 * RiskScore = Severity × Probability（1~25）作为辅助定级依据。
 */
import type { Grade } from '../../shared/types.js';
import { GRADE_DEFINITIONS } from '../../shared/grading-meta.js';
import type { RiskAssessment, GradingTrace } from '../../shared/risk-assessment.js';
import { ENTERPRISE_RULES, GRADING_POLICY_VERSION } from './policy.js';
import { riskAssessmentSchema } from '../lib/schema.js';

export { GRADE_DEFINITIONS }; // 供外部使用

export interface RiskInput {
  severityScore: number; // 1~5
  probabilityScore: number; // 1~5
}

const SEVERITY_TEXT = [
  '基本不会造成伤害',
  '可能导致轻微伤害',
  '可能导致轻伤或设备一般损坏',
  '可能导致重伤或设备重大损坏',
  '可能导致死亡或群死群伤',
];

const PROBABILITY_TEXT = [
  '几乎不发生',
  '较少发生',
  '可能发生',
  '很可能发生',
  '几乎必然发生',
];

/** Numeric-only auxiliary matrix. A requires scenario evidence, never a score alone. */
export function gradeFromRisk(input: RiskInput): Grade {
  const sev = clampScore(input.severityScore);
  const prob = clampScore(input.probabilityScore);
  const score = sev * prob;
  if (score >= 9 && sev >= 4) return 'B';
  if (score >= 6 || sev >= 3) return 'C';
  return 'D';
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function buildGradeReason(input: RiskInput, historicalGrades: Grade[]): { grade: Grade; reason: string } {
  const sev = clampScore(input.severityScore);
  const prob = clampScore(input.probabilityScore);
  const score = sev * prob;
  const grade = gradeFromRisk({ severityScore: sev, probabilityScore: prob });
  const def = GRADE_DEFINITIONS[grade];

  const lines: string[] = [];
  lines.push(
    `严重度 ${sev}/5（${SEVERITY_TEXT[sev - 1]}）× 可能性 ${prob}/5（${PROBABILITY_TEXT[prob - 1]}）＝ 风险值 ${score}。`
  );
  lines.push(`仅按辅助风险矩阵计算为 ${grade} 级（${def.label}），尚需核验事实与完整规则：${def.rule}`);
  if (historicalGrades.length) {
    lines.push(`历史相似案例定级（${historicalGrades.join('/')} 级）仅供对照，不改变当前矩阵结果。`);
  }
  return { grade, reason: lines.join('') };
}

/**
 * 定级护栏：以机器风险规则为权威，校验并修正模型给出的等级。
 * 返回 { grade, severityScore, probabilityScore, riskScore, gradeReason, adjusted }
 */
export function applyGradeGuardrail(input: {
  grade: Grade;
  gradeReason: string;
  severityScore: number;
  probabilityScore: number;
  historicalGrades: Grade[];
  assessment?: RiskAssessment;
  /** Current observation only. Never include inferred consequence or retrieved case text. */
  sourceTexts?: string[];
}): {
  grade: Grade;
  severityScore: number;
  probabilityScore: number;
  riskScore: number;
  gradeReason: string;
  adjusted: boolean;
  manualReviewRequired: boolean;
  gradingTrace: GradingTrace;
} {
  let sev = clampScore(input.severityScore);
  let prob = clampScore(input.probabilityScore);
  const reviewReasons: string[] = [];
  const matchedRules: string[] = [];
  const conflictingRules: string[] = [];
  const verifiedFacts: Array<{id:string;text:string}> = [];
  let ruleGrade = gradeFromRisk({ severityScore: sev, probabilityScore: prob });
  const parsed = riskAssessmentSchema.safeParse(input.assessment);
  const assessment = parsed.success ? parsed.data : undefined;
  if (!assessment) {
    reviewReasons.push('缺少有效结构化风险事实，分数不能单独支持最终定级');
    // Legacy output must not silently erase an already reported high-risk candidate.
    ruleGrade = worstGrade([input.grade, ruleGrade])!;
  } else {
    const normalized = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
    const sourceTexts = (input.sourceTexts ?? []).map(normalized);
    const facts = new Map<string,string>();
    for (const f of assessment.facts) {
      if (facts.has(f.id) || !sourceTexts.some(s => s.includes(normalized(f.text)))) {
        reviewReasons.push(`事实${f.id}重复或不是当前输入的原文片段`);
      } else { facts.set(f.id,f.text); verifiedFacts.push(f); }
    }
    const grounded = (ids: string[]) => ids.length>0 && ids.every(id=>facts.has(id));
    const invalidFacts = reviewReasons.length>0;
    const scenarios = assessment.scenarios.map((s, index) => {
      let grade = gradeFromRisk(s);
      const supported = !invalidFacts && grounded(s.severityBasis) && grounded(s.probabilityBasis)
        && grounded(s.barrierBasis) && grounded(s.exposureBasis)
        && (s.immediateDanger!==true || grounded(s.immediateBasis));
      if (!supported) reviewReasons.push(`场景${index+1}缺少有效的后果/可能性/屏障/暴露证据引用`);
      if (s.exposure==='unknown' || s.barrier==='unknown' || s.immediateDanger===null) reviewReasons.push(`场景${index+1}存在未知关键风险因素`);
      const exposed = s.exposure==='present' || s.exposure==='multiple';
      if (supported && s.severityScore>=4 && s.barrier==='failed' && exposed && (s.probabilityScore>=4 || s.immediateDanger===true)) {
        grade='A'; matchedRules.push(`A-IMMEDIATE:S${index+1}`);
      } else if (supported && s.severityScore>=4 && s.barrier==='failed' && s.probabilityScore>=3 && (exposed || s.exposure==='possible')) {
        grade='B'; matchedRules.push(`B-CRITICAL:S${index+1}`);
      } else {
        // Numeric score is auxiliary: unsupported B needs review; physical critical loss cannot become D.
        if (grade==='B') reviewReasons.push(`场景${index+1}分数较高但未证实B级完整条件`);
        // Missing information increases review requirements, not the physical risk itself.
        if (grade==='D' && (s.barrier==='failed' || !supported)) grade='C';
        matchedRules.push(`MATRIX-${grade}:S${index+1}`);
      }
      if (s.immediateDanger===true && (s.barrier==='intact' || s.exposure==='none')) {
        conflictingRules.push(`场景${index+1}立即危险与有效屏障/无暴露冲突`);
      }
      if ((s.exposure==='not_applicable' || s.barrier==='not_applicable') && (s.severityScore>=3 || s.immediateDanger===true)) {
        conflictingRules.push(`场景${index+1}实质事故后果与不适用的暴露/屏障冲突`);
      }
      if (!supported) grade=worstGrade([grade,input.grade])!;
      return {...s,grade};
    });
    scenarios.sort((a,b)=>GRADE_ORDER[b.grade]-GRADE_ORDER[a.grade] || b.severityScore*b.probabilityScore-a.severityScore*a.probabilityScore);
    ruleGrade=scenarios[0].grade; sev=scenarios[0].severityScore; prob=scenarios[0].probabilityScore;
    const seenRules = new Set<string>();
    for (const check of assessment.ruleChecks) {
      const rule=ENTERPRISE_RULES.find(r=>r.id===check.ruleId);
      if (!rule || seenRules.has(check.ruleId)) { reviewReasons.push(`未知或重复企业规则${check.ruleId}`); continue; }
      seenRules.add(check.ruleId);
      const ids=check.conditions.map(c=>c.id);
      if (new Set(ids).size!==ids.length || ids.some(id=>!(id in rule.conditions))) {reviewReasons.push(`${rule.id}条件重复或未知`);continue;}
      const byId=new Map(check.conditions.map(c=>[c.id,c]));
      const fullMatch=!invalidFacts && rule.alternatives.some(option=>option.every(id=> {
        const c=byId.get(id);return c?.status==='met' && grounded(c.factIds);
      }));
      if (fullMatch) {ruleGrade=worstGrade([ruleGrade,rule.minimumGrade])!;matchedRules.push(rule.id);}
      else {
        const conclusivelyExcluded=rule.alternatives.every(option=>option.some(id=>{const c=byId.get(id);return c?.status==='not_met' && grounded(c.factIds);}));
        if (!conclusivelyExcluded) reviewReasons.push(`${rule.id}必要条件缺失或未获事实支持，不能直接认定`);
      }
    }
    reviewReasons.push(...assessment.informationGaps);
    // Conflicting/ungrounded evidence is provisional; retain the highest reported candidate until review.
    if (invalidFacts || conflictingRules.length) ruleGrade=worstGrade([ruleGrade,input.grade])!;
  }
  if (ruleGrade!==input.grade) conflictingRules.push(`模型候选${input.grade}与策略结果${ruleGrade}不一致`);
  const manualReviewRequired=reviewReasons.length>0 || conflictingRules.length>0;
  const gradingTrace: GradingTrace = {policyVersion:GRADING_POLICY_VERSION,assessment,candidateLevel:input.grade,finalLevel:ruleGrade,
    status:manualReviewRequired?'provisional':'supported',matchedRules,conflictingRules,reviewReasons:[...new Set(reviewReasons)]};
  const adjusted = ruleGrade !== input.grade;

  const reasonParts: string[] = [];
  // Do not concatenate an obsolete model grade/reason into the authoritative explanation.
  if (verifiedFacts.length) reasonParts.push(`已核对输入原文：${verifiedFacts.map(f=>`[${f.id}]${f.text}`).join('；')}。`);
  const def = GRADE_DEFINITIONS[ruleGrade];
  reasonParts.push(
    `风险复核：严重度 ${sev}/5 × 可能性 ${prob}/5 ＝ 辅助风险值 ${sev * prob}，${manualReviewRequired?'暂定':'判定'}为 ${ruleGrade} 级（${def.label}）。依据：${matchedRules.join('、') || '信息不足的兼容复核'}。`
  );
  if (adjusted) {
    reasonParts.push(`AI 原始定级为 ${input.grade} 级，经系统风险规则复核调整为 ${ruleGrade} 级。`);
  }
  if (input.historicalGrades.length) {
    reasonParts.push(`历史相似案例定级（${input.historicalGrades.join('/')} 级）供参考。`);
  }
  if (manualReviewRequired) reasonParts.push(`需复核：${[...gradingTrace.reviewReasons,...conflictingRules].join('；')}。`);

  return {
    grade: ruleGrade,
    severityScore: sev,
    probabilityScore: prob,
    riskScore: sev * prob,
    gradeReason: reasonParts.join(''),
    adjusted,
    manualReviewRequired,
    gradingTrace,
  };
}

/** 同一级内部排序权重，用于综合风险等级计算（取最高等级）。 */
export const GRADE_ORDER: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 };

export function worstGrade(grades: Grade[]): Grade | null {
  if (!grades.length) return null;
  let worst: Grade = grades[0];
  for (const g of grades) {
    if (GRADE_ORDER[g] > GRADE_ORDER[worst]) worst = g;
  }
  return worst;
}
