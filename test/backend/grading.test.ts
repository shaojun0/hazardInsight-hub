import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGradeGuardrail, gradeFromRisk, worstGrade } from '../../server/grading/risk-grading.js';
import type { RiskAssessment } from '../../shared/risk-assessment.js';
import type { Grade } from '../../shared/types.js';
import {parseReasoningResult} from '../../server/lib/schema.js';

function assessment(text='人员正在无防护的6米临边作业'): RiskAssessment {
  return {facts:[{id:'F1',text}],scenarios:[{accident:'坠落',severityScore:5,probabilityScore:3,
    severityBasis:['F1'],probabilityBasis:['F1'],exposure:'present',exposureBasis:['F1'],
    barrier:'failed',barrierBasis:['F1'],immediateDanger:false,immediateBasis:[]}],ruleChecks:[],informationGaps:[]};
}
function grade(a:RiskAssessment, candidate:Grade='B', sources=a.facts.map(f=>f.text)) {
  return applyGradeGuardrail({grade:candidate,gradeReason:'模型给出的自由理由',severityScore:5,probabilityScore:3,historicalGrades:[],assessment:a,sourceTexts:sources});
}
test('death consequence alone never establishes A',()=>{
  assert.equal(gradeFromRisk({severityScore:5,probabilityScore:1}),'C');
  assert.equal(grade(assessment()).grade,'B');
});
test('actual exposure + failed critical barrier + imminent serious harm establishes A',()=>{
  const a=assessment();a.scenarios[0].probabilityScore=4;
  const g=grade(a,'A');assert.equal(g.grade,'A');assert.equal(g.manualReviewRequired,false);
  assert.ok(g.gradingTrace.matchedRules.includes('A-IMMEDIATE:S1'));
});
test('removing exposure or effective isolation removes the A gate',()=>{
  const a=assessment('设备已停用断电上锁，隔离区无人进入');
  Object.assign(a.scenarios[0],{probabilityScore:1,exposure:'none',barrier:'intact'});
  assert.equal(grade(a,'C').grade,'C');
});
test('same accident word can accompany a supported minor records issue',()=>{
  const a=assessment('防触电培训记录日期填写错误');
  Object.assign(a.scenarios[0],{severityScore:1,probabilityScore:2,exposure:'not_applicable',barrier:'not_applicable'});
  const g=grade(a,'D');assert.equal(g.grade,'D');assert.equal(g.manualReviewRequired,false);
});
test('unknown exposure does not claim confirmed low risk or automatically escalate a bounded minor defect',()=>{
  const a=assessment('灭火器箱体标签磨损');Object.assign(a.scenarios[0],{severityScore:2,probabilityScore:1,exposure:'unknown',barrier:'unknown'});
  const g=grade(a,'D');assert.equal(g.grade,'D');assert.equal(g.gradingTrace.status,'provisional');
});
test('invented facts do not validate a rule and preserve high candidate for review',()=>{
  const a=assessment();a.ruleChecks=[{ruleId:'BGC10',conditions:[{id:'height',status:'met',factIds:['F1']},{id:'barrier',status:'met',factIds:['F1']}]}];
  const g=grade(a,'A',['标高6米处的栏杆标签模糊']);assert.equal(g.manualReviewRequired,true);
  assert.equal(g.grade,'A');assert.ok(!g.gradingTrace.matchedRules.includes('BGC10'));
  assert.ok(!g.gradeReason.includes(a.facts[0].text));
});
test('rule incomplete / unknown never produces an enterprise lower bound',()=>{
  const a=assessment('实际落差约5米，防护缺失');Object.assign(a.scenarios[0],{severityScore:3,probabilityScore:2});
  a.ruleChecks=[{ruleId:'BGC10',conditions:[{id:'height',status:'unknown',factIds:[]},{id:'barrier',status:'met',factIds:['F1']}]}];
  const g=grade(a,'C');assert.equal(g.grade,'C');assert.ok(!g.gradingTrace.matchedRules.includes('BGC10'));assert.equal(g.manualReviewRequired,true);
});
test('enterprise conditions are conjunctive and preserve B lower bound',()=>{
  const a=assessment('实际落差6米，临边防护缺失');Object.assign(a.scenarios[0],{severityScore:3,probabilityScore:2});
  a.ruleChecks=[{ruleId:'BGC10',conditions:[{id:'height',status:'met',factIds:['F1']},{id:'barrier',status:'met',factIds:['F1']}]}];
  const g=grade(a);assert.equal(g.grade,'B');assert.ok(g.gradingTrace.matchedRules.includes('BGC10'));
});
test('unknown rule codes and duplicate conditions never acquire grade authority',()=>{
  const a=assessment();a.ruleChecks=[{ruleId:'A999',conditions:[{id:'x',status:'met',factIds:['F1']}]}];
  const g=grade(a);assert.equal(g.grade,'B');assert.equal(g.manualReviewRequired,true);
  a.ruleChecks=[{ruleId:'BGC10',conditions:[{id:'height',status:'met',factIds:['F1']},{id:'height',status:'met',factIds:['F1']}]}];
  assert.ok(!grade(a).gradingTrace.matchedRules.includes('BGC10'));
});
test('cross-scenario severity/probability multiplication is forbidden',()=>{
  const a=assessment();Object.assign(a.scenarios[0],{probabilityScore:1,barrier:'intact',exposure:'none'});
  a.scenarios.push({...a.scenarios[0],severityScore:1,probabilityScore:5});
  const g=grade(a,'C');assert.equal(g.grade,'C');assert.equal(g.riskScore,5);
});
test('contradictory barrier and imminent danger require review',()=>{
  const a=assessment();Object.assign(a.scenarios[0],{barrier:'intact',immediateDanger:true,immediateBasis:['F1']});
  assert.equal(grade(a).manualReviewRequired,true);
});
test('legacy provider output remains compatible but is provisional',()=>{
  const g=applyGradeGuardrail({grade:'B',gradeReason:'旧模型',severityScore:4,probabilityScore:3,historicalGrades:[]});
  assert.equal(g.grade,'B');assert.equal(g.manualReviewRequired,true);
});
test('history does not vote against current facts; explanation replaces stale model reason',()=>{
  const a=assessment();const g=grade(a);
  assert.ok(!g.gradeReason.includes('模型给出的自由理由'));
  assert.equal(worstGrade(['D','B','C']),'B');
});
test('malformed candidate does not erase unrelated valid decisions; ambiguous documents fail closed',()=>{
  const valid={ref:'H0',grade:'B',gradeReason:'说明',severityScore:4,probabilityScore:3,
    rectification:[{kind:'immediate',text:'隔离区域'},{kind:'corrective',text:'修复屏障'}]};
  const parsed=parseReasoningResult(JSON.stringify({hazards:[valid,{...valid,ref:'H1',severityScore:'未知'}]}));
  assert.equal(parsed?.hazards.length,1);assert.equal(parsed?.hazards[0].ref,'H0');assert.equal(parsed?.needManualReview,true);
  assert.equal(parseReasoningResult('{"hazards":[]} {"hazards":[]}'),null);
});
