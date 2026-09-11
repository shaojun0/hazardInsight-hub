/** Text-stage benchmark: labels and post-inspection fields never enter prompts.
 * Usage: node --import tsx scripts/grading/evaluate.ts before|after [limit] [concurrency]
 * Freeze the before run before changing production prompts. Resume through hashed batch files.
 */
import { loadEnvFile } from 'node:process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRetriever } from '../../server/retrieval/index.js';
import { KnowledgeRetrievalService } from '../../server/retrieval/service.js';
import { RuleMatcher } from '../../server/rules/matcher.js';
import { AgentContextBuilder } from '../../server/agent/context/context-builder.js';
import { reasoningResultSchema, safeParseModelJson } from '../../server/lib/schema.js';
import { applyGradeGuardrail } from '../../server/grading/risk-grading.js';
import type { ReasoningContext } from '../../server/lib/prompt.js';
import { buildReasoningSystemPrompt as baselineSystem, buildReasoningUserPrompt as baselineUser } from './baseline/prompt.js';
import { reasoningResultSchema as baselineSchema } from './baseline/schema.js';
import { baselineGuard } from './baseline/grade.js';
try { loadEnvFile('.env'); } catch {}
const { resolveProvider } = await import('../../server/providers/index.js');
const mode = process.argv[2] ?? 'before';
const root = '.tmp/grading-evaluation';
const out = `${root}/${mode}`;
mkdirSync(out, { recursive: true });
const provider = resolveProvider().provider;
const records: Record<string, string>[] = JSON.parse(readFileSync(`${root}/records.json`, 'utf8'));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const kb = new KnowledgeRetrievalService(createRetriever());
const matcher = new RuleMatcher();
const builder = new AgentContextBuilder();
const bundleFor = (batch: ReasoningContext['perHazard']) => {
  const bundle=builder.reasoningPrompt({perHazard:batch},{modelName:provider.name,ruleSetVersion:matcher.getVersion()});
  if (mode==='before') {bundle.system=baselineSystem();bundle.user=baselineUser({perHazard:batch});}
  return bundle;
};
// Remove explicit outcome phrases only; B-class work permits describe activity, not hazard labels.
const clean = (s: string) => s.replace(/(?:属[于]?|判定为|定为|认定为)?\s*[ABCD]\s*级隐患/g, '').replace(/隐患等级[为：:]?\s*[ABCD]级?/g, '');
const contextsPath = `${root}/contexts.json`;
let contexts: ReasoningContext['perHazard'];
if (existsSync(contextsPath)) contexts = JSON.parse(readFileSync(contextsPath, 'utf8'));
else {
  contexts = records.map((r, index) => {
    const description = clean(r['隐患描述']);
    const category = r['隐患分类'];
    const ref = `H${index}`;
    const bundle = kb.retrieve(`${category} ${description}`, category, 6, 4);
    return { ref, category, title: description.slice(0, 50), description, confidence: 0.8,
      evidence: [description], possibleConsequence: '待根据事实分析，尚未提供事故后果',
      standards: bundle.standards.map(({ clause: c }, i) => ({ key: `${ref}-S${i}`, doc: c.documentName, code: c.documentCode, clause: c.clause, title: c.clauseTitle, content: c.content })),
      cases: bundle.cases.map(({ caseRecord: c }, i) => ({ key: `${ref}-C${i}`, caseId: c.caseId, category: c.category, grade: c.grade, description: c.description, keywords: c.keywords })),
      rules: matcher.match(`${category} ${description}`, category, 5).map(({ rule: r }, i) => ({key: `${ref}-R${i}`,code:r.code,level:r.level,levelName:r.levelName,categoryPath:r.categoryPath,text:r.text,starred:r.starred})),
    };
  });
  writeFileSync(contextsPath, JSON.stringify(contexts));
}
const limit = Number(process.argv[3]) || records.length;
const startIndex=Number(process.argv[5])||0;
if(startIndex%5!==0) throw new Error('Start index must align to batch size 5');
let batches = Array.from({ length: Math.ceil((Math.min(limit,records.length)-startIndex)/5) }, (_, i) => contexts.slice(startIndex+i*5, Math.min(startIndex+i*5+5,limit)));
if(process.argv[6]==='errors') batches=batches.filter(batch=>{const b=bundleFor(batch);return existsSync(`${out}/${hash(b.system+b.user).slice(0,24)}.error.json`);});
let next = 0, completed = 0, failed = 0;
const system = bundleFor([]).system;
writeFileSync(`${out}/system.txt`,system);
writeFileSync(`${out}/manifest.json`,JSON.stringify({mode,model:provider.name,promptHash:hash(system),knowledgeVersion:kb.getVersion(),ruleVersion:matcher.getVersion(),createdAt:new Date().toISOString(),count:Math.min(limit,records.length),batchSize:5,contextHash:hash(JSON.stringify(contexts)),input:'description+category only; same frozen RAG; excludes vision, labels, AB standard and closure fields'},null,2));
async function worker() {
  while (next<batches.length) {
    const batch=batches[next++];
    const bundle=bundleFor(batch);
    const key=hash(bundle.system+bundle.user).slice(0,24), path=`${out}/${key}.json`;
    if (existsSync(path)) {completed+=batch.length; continue;}
    try {
      const result=await provider.chatStream(bundle.system,bundle.user,{maxTokens:mode==='before'?8000:4000+batch.length*2400,reasoningEffort:'low',signal:AbortSignal.timeout(120000),onTextDelta:()=>{}});
      const parsed=safeParseModelJson(result.text,mode==='before'?baselineSchema:reasoningResultSchema);
      const results=batch.map(c=>{
        const decisions=parsed?.hazards.filter(h=>h.ref===c.ref)??[];
        const d=decisions.length===1?decisions[0]:null;
        const i=Number(c.ref.slice(1)),r=records[i];
        const guard=d?(mode==='before'?baselineGuard(d):applyGradeGuardrail({...d,historicalGrades:[],...({assessment:(d as any).riskAssessment,sourceTexts:[c.description,...c.evidence]} as any)})):null;
        return {id:r['隐患单号'],ref:c.ref,sourceFile:r.sourceFile,sourceRow:r.sourceRow,label:r['隐患级别'][0],
          split:parseInt(hash(clean(r['隐患描述']).replace(/\s+/g,'')).slice(0,8),16)%5===0?'holdout':'development',
          valid:!!d,predicted:guard?.grade??'C',review:guard?(guard as any).manualReviewRequired??d?.manualReviewRequired:true,
          rawGrade:d?.grade??null,decision:d,guard};
      });
      writeFileSync(path,JSON.stringify({key,usage:result.usage,finishReason:result.finishReason,results,raw:result.text},null,2));
      completed+=batch.length;
    } catch(e) { failed+=batch.length; writeFileSync(`${out}/${key}.error.json`,JSON.stringify({refs:batch.map(x=>x.ref),error:(e as Error).message})); }
    console.log(JSON.stringify({mode,completed,failed,total:Math.min(limit,records.length),time:new Date().toISOString()}));
  }
}
await Promise.all(Array.from({length:Number(process.argv[4])||6},worker));
