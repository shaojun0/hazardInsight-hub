"""Check embedded BIFF drawings without assuming empty picture cells mean no images."""
import sys, struct, collections, json
from pathlib import Path
sys.path.insert(0,'.tmp/python-libs')
from xlrd.compdoc import CompDoc
out=[]
for p in Path(r'D:\datas\隐患').glob('*.xls'):
    data=p.read_bytes()
    stream=CompDoc(data).get_named_stream('Workbook')
    counts=collections.Counter()
    pos=0
    while pos+4<=len(stream):
        code,size=struct.unpack_from('<HH',stream,pos)
        counts[code]+=1
        pos+=4+size
    out.append(dict(file=p.name,drawingRecords=counts[0xEC],drawingGroupRecords=counts[0xEB],objectRecords=counts[0x5D],pngSignatures=data.count(b'\x89PNG\r\n\x1a\n'),jpegSignatures=data.count(b'\xff\xd8\xff')))
Path('.tmp/grading-evaluation/drawings.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(out,ensure_ascii=False))
