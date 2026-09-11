"""生成隐患定级测试样本表（含图片）。

从三个 BIFF `.xls` 的文本提取结果（.tmp/grading-evaluation/records.json）中分层随机抽样，
并从原始工作簿中解析嵌入图片，与行号对应后写回样本表。

默认抽样口径：B 级 10 条、C 级 20 条、D 级 20 条，共 50 条。
抽样仅在有图片的行中进行（若首次抽中无图行，则用同级别有图行替换），保证样本全部带图。

产出（datas/test）：
  - 隐患抽样_抽样50条.xlsx   抽样数据表（含内嵌图片）+ 抽样溯源表
  - 隐患抽样_抽样50条.csv    纯文本 + 图片文件名
  - images/                  50 张原图，命名 NN_隐患单号.jpg/png
"""
from __future__ import annotations

import collections
import csv
import json
import random
import sys
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xls_image_extract import extract  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = Path(r'D:\datas\隐患')
RECORDS = ROOT / '.tmp' / 'grading-evaluation' / 'records.json'
OUT_DIR = ROOT / 'datas' / 'test'

PLAN = {'B级': 10, 'C级': 20, 'D级': 20}
SEED = 20260911
REPLACE_SEED = SEED + 1
TITLE = '安全隐患信息抽样表（隐患定级测试样本 · B/C/D 分层随机抽样 · 含现场图片）'
PROVENANCE = ['sourceFile', 'sourceSheet', 'sourceRow']
IMG_COL_1B = 27            # 1 基列号，对应「主信息图片1」
DISP_MAX_W, DISP_MAX_H = 300, 240
ROW_HEIGHT_PT = 190


def load_images():
    """读取三个来源文件并解析 行号 -> 图片。"""
    table = {}
    for wb in sorted(SRC_DIR.glob('*.xls')):
        rows, stats = extract(wb)
        table[wb.name] = rows
        print(f'  图片解析 {wb.name}: blips={stats["blips"]} mapped={stats["mapped"]} skipped={stats["skipped"]}')
    return table


def sample(rows, images):
    by_level = collections.defaultdict(list)
    for r in rows:
        by_level[r['隐患级别']].append(r)

    def has_img(r):
        return r['sourceRow'] in images.get(r['sourceFile'], {})

    rng = random.Random(SEED)
    picked, replaced = [], []
    for level, n in PLAN.items():
        pool = by_level[level]
        chosen = rng.sample(pool, n)
        fixed = []
        for r in chosen:
            if has_img(r):
                fixed.append(r)
                continue
            # 同级别、有图片、未被选中且未替换过的行
            used = {x['隐患单号'] for x in chosen} | {x['隐患单号'] for x in fixed}
            cands = [c for c in pool if has_img(c) and c['隐患单号'] not in used]
            if not cands:
                sys.exit(f'{level} 无可用带图候选，无法替换 {r["隐患单号"]}')
            rep = random.Random(REPLACE_SEED).choice(cands)
            replaced.append({'原样本': r['隐患单号'], '替换为': rep['隐患单号'], '级别': level})
            fixed.append(rep)
        picked.extend(fixed)

    order = list(PLAN)
    picked.sort(key=lambda r: (order.index(r['隐患级别']), r['隐患单号']))
    return picked, replaced


def main():
    if not RECORDS.exists():
        sys.exit(f'缺少文本提取结果：{RECORDS}\n请先运行 scripts/grading/profile_data.py')
    rows = json.loads(RECORDS.read_text(encoding='utf-8'))
    headers = [k for k in rows[0] if k not in PROVENANCE]

    print('解析原始工作簿嵌入图片 ...')
    images = load_images()
    picked, replaced = sample(rows, images)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img_dir = OUT_DIR / 'images'
    img_dir.mkdir(exist_ok=True)
    for old in img_dir.glob('*'):
        old.unlink()

    records = []
    for i, r in enumerate(picked, 1):
        imgs = images.get(r['sourceFile'], {}).get(r['sourceRow'], [])
        names = []
        for k, (raw, ext) in enumerate(imgs):
            name = f'{i:02d}_{r["隐患单号"]}' + (f'_{k + 1}' if k else '') + f'.{ext}'
            (img_dir / name).write_bytes(raw)
            names.append(name)
        records.append({'row': r, 'index': i, 'images': imgs, 'names': names})

    xlsx_path = OUT_DIR / '隐患抽样_抽样50条.xlsx'
    csv_path = OUT_DIR / '隐患抽样_抽样50条.csv'

    wb = Workbook()
    ws = wb.active
    ws.title = '抽样数据'
    ws.append([TITLE] + [''] * (len(headers) - 1))
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    ws.cell(1, 1).font = Font(bold=True, size=13)
    ws.cell(1, 1).alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[1].height = 26

    ws.append(headers)
    head_fill = PatternFill('solid', fgColor='DCE6F1')
    for c in range(1, len(headers) + 1):
        cell = ws.cell(2, c)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ws.row_dimensions[2].height = 22
    ws.freeze_panes = 'A3'

    for rec in records:
        r = rec['row']
        excel_row = 2 + rec['index']
        ws.append([str(r.get(h, '')) for h in headers])
        ws.row_dimensions[excel_row].height = ROW_HEIGHT_PT
        for k, (raw, ext) in enumerate(rec['images']):
            with PILImage.open(BytesIO(raw)) as im:
                w, h = im.size
            scale = min(DISP_MAX_W / w, DISP_MAX_H / h)
            ximg = XLImage(BytesIO(raw))
            ximg.width, ximg.height = max(1, int(w * scale)), max(1, int(h * scale))
            col = IMG_COL_1B + k
            if col > len(headers):
                break
            ximg.anchor = f'{get_column_letter(col)}{excel_row}'
            ws.add_image(ximg)

    widths = {'隐患描述': 60, '整改责任人': 20, '检查人': 18, '创建人': 18, '验证人': 18,
              '责任单位': 22, '作业区域': 26, '隐患分类': 24, 'A/B级判定标准': 34, '流程环节': 18,
              '主信息图片1': 34, '主信息图片2': 34}
    for idx, h in enumerate(headers, 1):
        ws.column_dimensions[get_column_letter(idx)].width = widths.get(h, 14)
    for row in ws.iter_rows(min_row=3, max_row=ws.max_row):
        for cell in row:
            cell.alignment = Alignment(vertical='top', wrap_text=True)

    ws2 = wb.create_sheet('抽样溯源')
    h2 = ['序号', '隐患单号', '隐患级别', '来源文件', '工作表', '原始行号', '随机种子', '图片文件']
    ws2.append(h2)
    for c in range(1, len(h2) + 1):
        ws2.cell(1, c).font = Font(bold=True)
        ws2.cell(1, c).fill = head_fill
    for rec in records:
        r = rec['row']
        ws2.append([rec['index'], r['隐患单号'], r['隐患级别'], r['sourceFile'],
                    r['sourceSheet'], r['sourceRow'], SEED, ' ; '.join(rec['names'])])
    ws2.column_dimensions['D'].width = 40
    ws2.column_dimensions['H'].width = 40
    wb.save(xlsx_path)

    with csv_path.open('w', encoding='utf-8-sig', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(headers + ['图片文件'])
        for rec in records:
            r = rec['row']
            w.writerow([r.get(h, '') for h in headers] + [' ; '.join(rec['names'])])

    dist = collections.Counter(r['隐患级别'] for r in picked)
    meta = {
        'xlsx': str(xlsx_path),
        'csv': str(csv_path),
        '图片目录': str(img_dir),
        '抽样总数': len(picked),
        '级别分布': dict(dist),
        '带图片条数': sum(1 for rec in records if rec['images']),
        '图片总数': sum(len(rec['images']) for rec in records),
        '随机种子': SEED,
        '替换记录': replaced,
    }
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
