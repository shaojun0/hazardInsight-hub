"""数据文件解析测试（CSV / JSON / TXT / XLSX）。"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from app.core.errors import FileParseError
from app.processors.tabular_reader import read_records


def test_csv_with_chinese_headers_maps_id_and_text():
    """中文表头自动映射到 id / text，其余业务列进入元数据。"""

    csv_bytes = (
        "隐患单号,隐患描述,隐患级别\n"
        "HZ-001,现场作业区域未设置警戒围栏,A\n"
        "HZ-002,脚手架搭设缺少连墙件,B\n"
    ).encode("utf-8")

    records, warnings = read_records(csv_bytes, "hazards.csv")

    assert warnings == []
    assert [record["id"] for record in records] == ["HZ-001", "HZ-002"]
    assert records[0]["text"] == "现场作业区域未设置警戒围栏"
    assert records[0]["隐患级别"] == "A"


def test_csv_with_bom_is_decoded():
    """Excel 导出的 UTF-8 BOM 头不应污染第一个表头名。"""

    csv_bytes = "隐患描述\n配电箱未上锁\n".encode("utf-8-sig")
    records, _ = read_records(csv_bytes, "bom.csv")

    assert records[0]["text"] == "配电箱未上锁"


def test_csv_in_gbk_is_decoded():
    """GBK 编码的 CSV 能正确解码，不出现乱码。"""

    csv_bytes = "隐患描述\n模板支撑体系未验收\n".encode("gbk")
    records, _ = read_records(csv_bytes, "gbk.csv")

    assert records[0]["text"] == "模板支撑体系未验收"


def test_csv_without_recognizable_text_column_falls_back_and_warns():
    """没有可识别文本列时退化为最长列，并给出警告（不静默用错列）。"""

    csv_bytes = "编号,备注\n1,这是一段明显更长的文本内容用于聚类\n".encode("utf-8")
    records, warnings = read_records(csv_bytes, "unknown.csv")

    assert records[0]["text"].startswith("这是一段明显更长的文本内容")
    assert any("未识别到文本列" in warning for warning in warnings)


def test_rows_with_empty_text_are_skipped():
    """文本列为空的行被跳过，不产生空样本。"""

    csv_bytes = "隐患描述\n有效文本\n\n另外一条\n".encode("utf-8")
    records, _ = read_records(csv_bytes, "sparse.csv")

    assert [record["text"] for record in records] == ["有效文本", "另外一条"]


def test_json_array_records():
    """JSON 数组按对象逐条转成记录。"""

    payload = json.dumps(
        [{"id": "a", "text": "未设置警戒", "隐患级别": "A"}, {"id": "b", "text": "未挂设标识"}],
        ensure_ascii=False,
    ).encode("utf-8")

    records, _ = read_records(payload, "data.json")

    assert len(records) == 2
    assert records[0]["id"] == "a"
    assert records[0]["text"] == "未设置警戒"


def test_json_object_with_items_key():
    """`{"items": [...]}` 这种带包裹的 JSON 也能解析。"""

    payload = json.dumps({"items": [{"id": "a", "text": "文本"}]}, ensure_ascii=False).encode("utf-8")
    records, _ = read_records(payload, "wrapped.json")

    assert records[0]["text"] == "文本"


def test_json_with_invalid_top_level_raises():
    """顶层不是数组也不含 items 时给出明确错误。"""

    payload = json.dumps({"foo": 1}).encode("utf-8")

    with pytest.raises(FileParseError):
        read_records(payload, "bad.json")


def test_json_broken_syntax_raises_parse_error():
    """语法错误的 JSON 抛出 FileParseError（而不是 JSONDecodeError 冒泡成 500）。"""

    with pytest.raises(FileParseError):
        read_records(b"{not json", "broken.json")


def test_txt_lines_become_samples():
    """TXT 每行一条样本。"""

    records, _ = read_records("第一条文本\n\n第二条文本\n".encode("utf-8"), "lines.txt")

    assert [record["text"] for record in records] == ["第一条文本", "第二条文本"]
    assert records[0]["id"] == "row-1"


def test_xlsx_inline_strings_are_read():
    """XLSX 读取（自实现 OOXML 解析，用内联字符串的最小工作簿验证）。"""

    records, _ = read_records(_minimal_xlsx(), "hazards.xlsx")

    assert [record["text"] for record in records] == ["未设置警戒围栏", "缺少连墙件"]
    assert records[0]["id"] == "HZ-001"
    assert records[1]["隐患级别"] == "B"


def test_xlsx_corrupted_file_raises():
    """损坏的 XLSX 抛出 FileParseError。"""

    with pytest.raises(FileParseError):
        read_records(b"not a zip", "broken.xlsx")


def test_unsupported_extension_raises():
    """不支持的扩展名明确报错。"""

    with pytest.raises(FileParseError):
        read_records(b"x", "data.pdf")


def _minimal_xlsx() -> bytes:
    """构造一个只含内联字符串的最小 XLSX，避免测试依赖 Excel 生成物。"""

    rows = [
        ["隐患单号", "隐患描述", "隐患级别"],
        ["HZ-001", "未设置警戒围栏", "A"],
        ["HZ-002", "缺少连墙件", "B"],
    ]
    body = []
    for row_index, row in enumerate(rows, start=1):
        cells = "".join(
            f'<c r="{chr(65 + column_index)}{row_index}" t="inlineStr"><is><t>{value}</t></is></c>'
            for column_index, value in enumerate(row)
        )
        body.append(f'<row r="{row_index}">{cells}</row>')

    sheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(body)}</sheetData></worksheet>'
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
    return buffer.getvalue()
