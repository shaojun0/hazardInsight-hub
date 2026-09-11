import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {applyGradeGuardrail,GRADE_ORDER} from '../../server/grading/risk-grading.js';
import {baselineGuard} from './baseline/grade.js';
import type {Grade} from '../../shared/types.js';
import {parseReasoningResult} from '../../server/lib/schema.js';
const root='.tmp/grading-evaluation';
const records:Record<string,string>[]=JSON.parse(readFileSync(`${root}/records.json`,'utf8'));
const contexts=JSON.parse(readFileSync(`${root}/contexts.json`,'utf8'));
const grades:Grade[]=['A','B','C','D'];
function load(mode:string) {
  const results=new Map<string,any>();let errors=0, calls=0,inputTokens=0,outputTokens=0;
  for(const f of readdirSync(`${root}/${mode}`).filter(f=>f.endsWith('.json')&&f!=='manifest.json')) {
    const batch=JSON.parse(readFileSync(`${root}/${mode}/${f}`,'utf8'));
    if(!batch.results){errors+=batch.refs?.length??0;continue;}
    calls++;inputTokens+=batch.usage?.inputTokens??0;outputTokens+=batch.usage?.outputTokens??0;
    const reparsed=mode==='before'?null:parseReasoningResult(batch.raw);
    for(const r of batch.results){
      if(results.has(r.id)) throw new Error(`Duplicate benchmark ID in ${mode}: ${r.id}`);
      const c=contexts[Number(r.ref.slice(1))];
      if(mode!=='before') {
        const decisions=reparsed?.hazards.filter(h=>h.ref===r.ref)??[];
        r.originalBatchValid=r.valid;
        r.decision=decisions.length===1?decisions[0]:null;
        r.valid=!!r.decision;
      }
      if(r.decision){
        r.guard=mode==='before'?baselineGuard(r.decision):applyGradeGuardrail({...r.decision,assessment:r.decision.riskAssessment,sourceTexts:[c.description,...c.evidence],historicalGrades:[]});
        r.predicted=r.guard.grade;r.review=mode==='before'?r.decision.manualReviewRequired:r.guard.manualReviewRequired;
      }
      results.set(r.id,r);
    }
  }
  return {results,errors,calls,inputTokens,outputTokens};
}
function metrics(rows:any[]) {
  const matrix=Object.fromEntries(grades.map(g=>[g,Object.fromEntries(grades.map(p=>[p,0]))])) as Record<Grade,Record<Grade,number>>;
  for(const r of rows)matrix[r.label as Grade][r.predicted as Grade]++;
  const perGrade=Object.fromEntries(grades.map(g=>{const support=grades.reduce((s,p)=>s+matrix[g][p],0), predicted=grades.reduce((s,l)=>s+matrix[l][g],0),tp=matrix[g][g];return [g,{support,predicted,tp,precision:predicted?tp/predicted:null,recall:support?tp/support:null,f1:support+predicted?2*tp/(support+predicted):null}];}));
  const recalls=Object.values(perGrade).flatMap(x=>x.recall===null?[]:[x.recall]);
  const high=rows.filter(r=>r.label==='A'||r.label==='B');
  return {n:rows.length,agreement:rows.length?rows.filter(r=>r.label===r.predicted).length/rows.length:null,matrix,perGrade,
    balancedRecall:recalls.length?recalls.reduce((a,b)=>a+b,0)/recalls.length:null,
    highRiskCount:high.length,highRiskUnderestimated:high.filter(r=>GRADE_ORDER[r.predicted as Grade]<GRADE_ORDER[r.label as Grade]).length,
    lowRiskOvergraded:rows.filter(r=>r.label==='D'&&r.predicted!=='D').length,
    adjacentErrors:rows.filter(r=>Math.abs(GRADE_ORDER[r.predicted as Grade]-GRADE_ORDER[r.label as Grade])===1).length,
    reviewCount:rows.filter(r=>r.review).length};
}
const before=load('before'),after=load('after');
const summary:any={total:records.length,generatedAt:new Date().toISOString(),modes:{},paired:{},majorityBaseline:2532/3000};
for(const [name,run] of [['before',before],['after',after]] as const){
  const rows=[...run.results.values()];
  summary.modes[name]={attempted:rows.length,missing:records.length-rows.length,invalid:rows.filter(r=>!r.valid).length,errorRecords:run.errors,calls:run.calls,inputTokens:run.inputTokens,outputTokens:run.outputTokens,
    operational:metrics(rows),validOnly:metrics(rows.filter(r=>r.valid)),
    groupedDevelopment:metrics(rows.filter(r=>r.valid&&r.split==='development')),groupedHoldout:metrics(rows.filter(r=>r.valid&&r.split==='holdout')),
    projects:Object.fromEntries([...new Set(records.map(r=>r['项目']))].map(p=>[p,metrics(rows.filter(r=>r.valid&&records[Number(r.ref.slice(1))]['项目']===p))]))};
}
const paired=records.flatMap(r=>{const a=before.results.get(r['隐患单号']),b=after.results.get(r['隐患单号']);return a?.valid&&b?.valid?[{before:a,after:b}]:[];});
summary.paired={before:metrics(paired.map(x=>x.before)),after:metrics(paired.map(x=>x.after))};
const details=records.map((r,i)=>{const a=before.results.get(r['隐患单号']),b=after.results.get(r['隐患单号']);return {id:r['隐患单号'],sourceFile:r.sourceFile,sourceRow:r.sourceRow,project:r['项目'],category:r['隐患分类'],description:r['隐患描述'],label:r['隐患级别'][0],before:a?.predicted??null,after:b?.predicted??null,beforeValid:a?.valid??false,afterValid:b?.valid??false,review:b?.review??true,matchedRules:b?.guard?.gradingTrace?.matchedRules??[],reviewReasons:b?.guard?.gradingTrace?.reviewReasons??[],afterReason:b?.guard?.gradeReason??'模型结果缺失',split:b?.split??a?.split};});
writeFileSync(`${root}/comparison.json`,JSON.stringify(details,null,2));
const csv=(v:unknown)=>`"${String(v??'').replaceAll('"','""')}"`;
writeFileSync(`${root}/comparison.csv`,'\uFEFF'+[Object.keys(details[0]).map(csv).join(','),...details.map(d=>Object.values(d).map(v=>csv(Array.isArray(v)?v.join('；'):v)).join(','))].join('\r\n'));
writeFileSync(`${root}/summary.json`,JSON.stringify(summary,null,2));
mkdirSync('docs/grading-evaluation',{recursive:true});
writeFileSync('docs/grading-evaluation/metrics.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({total:summary.total,before:summary.modes.before.validOnly,after:summary.modes.after.validOnly,coverage:{before:summary.modes.before.attempted,after:summary.modes.after.attempted}},null,2));
