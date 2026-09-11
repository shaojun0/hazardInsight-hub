"""Reproducible label consistency audit; review candidates are not relabelled."""
import collections, difflib, json, re
from pathlib import Path
root=Path('.tmp/grading-evaluation')
rows=json.loads((root/'records.json').read_text(encoding='utf8'))
def normalize(s): return re.sub(r'[\s，。；、：,.!！:;]+','',s)
texts=[normalize(r['隐患描述']) for r in rows]
shingles=[{s[i:i+3] for i in range(len(s)-2)} for s in texts]
index=collections.defaultdict(set)
for i,terms in enumerate(shingles):
    for t in terms: index[t].add(i)
pairs=[]
for i,terms in enumerate(shingles):
    if not terms: continue
    candidates=collections.Counter(j for t in terms for j in index[t] if j>i and rows[j]['隐患级别']!=rows[i]['隐患级别'])
    for j,intersection in candidates.items():
        jac=intersection/len(terms|shingles[j])
        if jac>=.45:
            ratio=difflib.SequenceMatcher(None,texts[i],texts[j]).ratio()
            if ratio>=.60: pairs.append(dict(similarity=ratio,jaccard=jac,records=[{k:rows[v][k] for k in ['隐患单号','项目','隐患级别','隐患描述','隐患分类','sourceFile','sourceRow']} for v in [i,j]]))
pairs.sort(key=lambda p:-p['similarity'])
projects={p:dict(collections.Counter(r['隐患级别'] for r in rows if r['项目']==p)) for p in sorted({r['项目'] for r in rows})}
features={}
for term in ['垃圾','标识','记录','未固定','破损','裸露','临边','安全带','动火','无灭火器','无法正常使用','未按方案','隔离失效','有限空间','混放']:
    subset=[r for r in rows if term in r['隐患描述']]
    features[term]=dict(collections.Counter(r['隐患级别'] for r in subset))
audit=dict(projects=projects,descriptionLength={g:{'count':len(v:=[len(r['隐患描述']) for r in rows if r['隐患级别']==g]),'median':sorted(v)[len(v)//2],'min':min(v),'max':max(v)} for g in ['B级','C级','D级']},
    featureAssociations=features,nearConflictPairs=pairs,abLabelConflicts=[r for r in rows if r['A/B级判定标准'] and r['隐患级别']!='B级'])
(root/'quality-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in audit.items() if k not in ['nearConflictPairs','abLabelConflicts']},ensure_ascii=False))
print('NEAR PAIRS',len(pairs),json.dumps(pairs[:14],ensure_ascii=False))
