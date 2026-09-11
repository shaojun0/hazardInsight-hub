"""Read-only BIFF extraction. pip install xlrd; raw records stay in ignored .tmp."""
import collections, hashlib, json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path('.tmp/python-libs').resolve()))
import xlrd

source = Path(sys.argv[1] if len(sys.argv) > 1 else r'D:\datas\隐患')
dest = Path('.tmp/grading-evaluation')
dest.mkdir(parents=True, exist_ok=True)
rows, books = [], []
for path in sorted(source.glob('*.xls')):
    book = xlrd.open_workbook(str(path), on_demand=True)
    for sheet in book.sheets():
        headers = sheet.row_values(1)
        records = [dict(zip(headers, sheet.row_values(i)), sourceFile=path.name, sourceSheet=sheet.name, sourceRow=i+1) for i in range(2,sheet.nrows) if sheet.cell_value(i,0)]
        rows.extend(records)
        books.append(dict(file=path.name, sheet=sheet.name, rows=len(records), columns=headers, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), labels=dict(collections.Counter(r['隐患级别'] for r in records))))
    book.release_resources()
def counts(key): return dict(collections.Counter(r[key] for r in rows).most_common())
groups = collections.defaultdict(list)
for r in rows: groups[re.sub(r'\s+|[，。；、,.!！]', '',r['隐患描述'])].append(r)
duplicates = [g for g in groups.values() if len(g)>1]
conflicts = [g for g in duplicates if len({r['隐患级别'] for r in g})>1]
category = collections.defaultdict(collections.Counter)
for r in rows: category[r['隐患分类']][r['隐患级别']]+=1
profile = dict(books=books, total=len(rows), labels=counts('隐患级别'), projects=counts('项目'), dates=counts('检查日期'),
    missing={k:sum(not str(r[k]).strip() for r in rows) for k in books[0]['columns']},
    uniqueIds=len({r['隐患单号'] for r in rows}), duplicateDescriptionGroups=len(duplicates), duplicateDescriptionRows=sum(map(len,duplicates)),
    conflictingGroups=len(conflicts), conflictingRows=sum(map(len,conflicts)),
    shortDescriptions=sum(len(r['隐患描述'])<15 for r in rows), categories=dict(sorted(category.items(),key=lambda kv:-sum(kv[1].values()))),
    abStandards=counts('A/B级判定标准'))
for name, data in [('records',rows),('profile',profile),('label-conflicts',conflicts)]:
    (dest/f'{name}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:v for k,v in profile.items() if k not in ['categories','dates','books','abStandards']},ensure_ascii=False,indent=2))
print('TOP CATEGORIES',json.dumps(list(profile['categories'].items())[:25],ensure_ascii=False))
print('A/B',json.dumps([{k:r[k] for k in ['隐患单号','隐患级别','隐患描述','A/B级判定标准']} for r in rows if r['隐患级别'] in ['A级','B级']],ensure_ascii=False))
print('CONFLICTS',json.dumps([[{k:r[k] for k in ['隐患单号','隐患级别','隐患描述','项目']} for r in g] for g in conflicts][:12],ensure_ascii=False))
