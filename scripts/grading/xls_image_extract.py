"""从 BIFF8 `.xls` 中提取嵌入图片，并按 ClientAnchor 建立「Excel 行号 -> 图片」映射。

背景：这类导出的隐患台账把照片作为工作簿级绘图（Drawing）嵌入，
`主信息图片1/2` 单元格本身为空，图片位置只存在于 Escher 结构的 ClientAnchor 中。
图片二进制存放在全局绘图组（MSODRAWINGGROUP + 大量 CONTINUE 记录）的 BStoreContainer 里。

实测结构（三个源文件一致）：
  - 全局绘图组：若干 0x00EB 记录 + 后续 0x003C(CONTINUE) 记录，内含 N 个 BSE(0xF007)，每个内嵌一个 BLIP
  - 工作表绘图：每个图片一个 102 字节 Escher 块，出现形式有两种
      * 0x00EC(MSODRAWING) 独立记录，紧接 0x005D(OBJ)
      * 0x005D(OBJ) 记录之后跟一条 0x003C(CONTINUE)，载荷即该 Escher 块
  - ClientAnchor(0xF010) 载荷 18 字节：Flag(2) + ColL/RowT/ColR/RowB（各 4 字节，0 基）
  - 图片索引取 OfficeArtFOPT(0xF00B) 的 pib 属性（opid & 0x3FFF == 0x0104），1 基
"""
from __future__ import annotations

import struct
from collections import defaultdict
from pathlib import Path

import olefile

CONTINUE = 0x003C
MSODRAWINGGROUP = 0x00EB
MSODRAWING = 0x00EC
OBJ = 0x005D

T_FOPT = 0xF00B
T_ANCHOR = 0xF010
T_BSE = 0xF007
T_BLIP = {0xF01A: 'emf', 0xF01B: 'wmf', 0xF01C: 'pict', 0xF01D: 'jpeg',
          0xF01E: 'png', 0xF01F: 'dib', 0xF029: 'tiff'}
INST_BLIP = {0x46A: 'jfif', 0x46B: 'jpeg', 0x6E0: 'png', 0x7A9: 'dib',
             0x216: 'wmf', 0x3D4: 'emf', 0x542: 'tiff'}

JPG_SIG = b'\xff\xd8\xff'
PNG_SIG = b'\x89PNG\r\n\x1a\n'


def _hdr(buf: bytes, p: int):
    v = struct.unpack_from('<H', buf, p)[0]
    t = struct.unpack_from('<H', buf, p + 2)[0]
    n = struct.unpack_from('<I', buf, p + 4)[0]
    return v & 0x0F, v >> 4, t, n


def _ewalk(buf: bytes, p: int, end: int, depth: int, acc: list):
    """递归遍历 Escher 记录；容器(ver==0xF)下钻。"""
    while p + 8 <= end:
        v, i, t, n = _hdr(buf, p)
        if p + 8 + n > end:
            break
        acc.append((depth, v, i, t, p + 8, n))
        if v == 0xF:
            _ewalk(buf, p + 8, p + 8 + n, depth + 1, acc)
        p += 8 + n
    return acc


def _records(stream: bytes):
    pos, recs = 0, []
    while pos + 4 <= len(stream):
        code, size = struct.unpack_from('<HH', stream, pos)
        recs.append((code, size, pos + 4))
        pos += 4 + size
    return recs


def _image_bytes(data: bytes):
    k = data.find(JPG_SIG)
    if k >= 0:
        return data[k:], 'jpg'
    k = data.find(PNG_SIG)
    if k >= 0:
        return data[k:], 'png'
    return b'', ''


def extract(workbook: Path):
    """返回 (row_to_images: dict[int, list[(bytes, ext)]], stats: dict)。

    row 为 1 基 Excel 行号（与 xlrd 的 sourceRow 一致）。
    """
    st = olefile.OleFileIO(str(workbook))
    try:
        stream = st.openstream('Workbook').read()
    finally:
        st.close()
    recs = _records(stream)

    # 1) 拼接全局绘图组
    dgg = bytearray()
    link = None
    for code, size, dp in recs:
        if code == MSODRAWINGGROUP:
            dgg += stream[dp:dp + size]
            link = 'eb'
        elif code == CONTINUE and link == 'eb':
            dgg += stream[dp:dp + size]
        else:
            link = 'x'

    # 2) 每个 BSE 内嵌一个 BLIP
    blips = []
    for _d, _v, _i, t, ds, n in _ewalk(dgg, 0, len(dgg), 0, []):
        if t != T_BSE:
            continue
        seg = dgg[ds:ds + n]
        for off in list(range(36, 40)) + list(range(0, 80)):
            if off + 8 > len(seg):
                continue
            _v2, i2, t2, n2 = _hdr(seg, off)
            if t2 in T_BLIP and off + 8 + n2 <= len(seg):
                blips.append({'inst': i2, 'data': bytes(seg[off + 8:off + 8 + n2])})
                break

    # 3) 收集每个图片的 Escher 块（两种承载形式）
    chunks = []
    for idx, (code, size, dp) in enumerate(recs):
        if code == MSODRAWING:
            chunks.append(stream[dp:dp + size])
        elif code == CONTINUE and idx > 0 and recs[idx - 1][0] == OBJ and 80 <= size <= 400:
            chunks.append(stream[dp:dp + size])

    row_to_images: dict[int, list[tuple[bytes, str]]] = defaultdict(list)
    stats = {'blips': len(blips), 'chunks': len(chunks), 'mapped': 0, 'skipped': 0, 'cols': defaultdict(int)}
    for ch in chunks:
        row_t0 = pib = col_l = None
        for _d, _v, _i, t, ds, n in _ewalk(ch, 0, len(ch), 0, []):
            if t == T_ANCHOR and n >= 18:
                col_l, row_t0, _col_r, _row_b = struct.unpack_from('<4I', ch, ds + 2)
            elif t == T_FOPT:
                o = 0
                while o + 6 <= n:
                    opid = struct.unpack_from('<H', ch, ds + o)[0]
                    val = struct.unpack_from('<I', ch, ds + o + 2)[0]
                    if (opid & 0x3FFF) == 0x0104:
                        pib = val
                    o += 6
        if row_t0 is None or pib is None or not (1 <= pib <= len(blips)):
            stats['skipped'] += 1
            continue
        raw, ext = _image_bytes(blips[pib - 1]['data'])
        if not raw:
            stats['skipped'] += 1
            continue
        row_to_images[row_t0 + 1].append((raw, ext))
        stats['mapped'] += 1
        stats['cols'][col_l] += 1
    stats['cols'] = dict(stats['cols'])
    return dict(row_to_images), stats


def dump(workbook: Path, out_dir: Path, row_to_images=None):
    """把某工作簿的图片落盘为 row{N}_{k}.{ext}。"""
    if row_to_images is None:
        row_to_images, _ = extract(workbook)
    out_dir.mkdir(parents=True, exist_ok=True)
    for row, imgs in row_to_images.items():
        for k, (raw, ext) in enumerate(imgs):
            (out_dir / f'row{row}_{k}.{ext}').write_bytes(raw)
    return len(row_to_images)


if __name__ == '__main__':
    import sys
    src = Path(sys.argv[1] if len(sys.argv) > 1 else r'D:\datas\隐患')
    dest = Path(sys.argv[2] if len(sys.argv) > 2 else r'.tmp/grading-evaluation/images')
    for wb in sorted(src.glob('*.xls')):
        rows, st = extract(wb)
        n = dump(wb, dest / wb.stem, rows)
        print(f'{wb.name}: {st} -> {n} rows written')
