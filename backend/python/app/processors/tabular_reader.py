"""表格/结构化数据读取。

本模块由源项目 `medica-report-review` 的 `app/processors/text_parser.py`
改造而来，保留了两处可直接复用的实现：

1. `_read_shared_strings` / `_worksheet_to_rows`：用 `zipfile` + `ElementTree`
   直接读 XLSX，不额外依赖 openpyxl 的读表逻辑；
2. CSV 读取统一使用 `utf-8-sig`，兼容 Excel 导出的 BOM 头。

差异在于输出：原项目把表格渲染成 Markdown 供 LLM 阅读，这里改为返回
`list[dict]`，因为聚类服务需要的是结构化的「样本 ID + 文本 + 元数据」。
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

from app.core.errors import FileParseError

#: 表头别名 → 规范字段名。用于自动识别「哪一列是文本、哪一列是 ID」。
ID_ALIASES = {"id", "编号", "序号", "隐患单号", "单号", "编码", "code", "key"}
TEXT_ALIASES = {
    "text",
    "content",
    "描述",
    "内容",
    "文本",
    "隐患描述",
    "问题描述",
    "报告内容",
    "body",
    "description",
}

#: 会被保留为元数据的常见业务列（不做穷举，仅用于给前端更好的默认展示）。
META_HINTS = ("级别", "分类", "项目", "区域", "类型", "日期", "单位", "标准")


def read_raw_table(data: bytes, filename: str) -> tuple[list[str], list[list[str]]]:
    """按后缀读取数据文件，返回 (表头, 数据行)。

    参数:
        data: 文件二进制内容。
        filename: 原始文件名，仅用于判断后缀与报错文案。

    异常:
        FileParseError: 编码异常、结构损坏或内容为空。
    """

    suffix = Path(filename).suffix.lower()
    try:
        if suffix == ".csv":
            return _read_csv(data)
        if suffix == ".xlsx":
            return _read_xlsx(data)
        if suffix == ".txt":
            return _read_txt(data)
        if suffix == ".json":
            return _read_json(data)
    except FileParseError:
        raise
    except Exception as exc:  # noqa: BLE001 - 统一翻译为领域异常
        raise FileParseError(f"解析 {filename} 失败：{exc}") from exc
    raise FileParseError(f"不支持的数据文件：{filename}")


def read_records(data: bytes, filename: str) -> tuple[list[dict[str, str]], list[str]]:
    """读取数据文件并规范化为记录列表。

    返回:
        (记录列表, 警告列表)。每条记录至少包含规范字段 `id` 与 `text`，其余
        原始列放在 `metadata` 前缀之外的同级键里，由上层决定是否保留。
    """

    suffix = Path(filename).suffix.lower()
    if suffix == ".json":
        return _read_json_records(data)

    headers, rows = read_raw_table(data, filename)
    warnings: list[str] = []
    if not rows:
        return [], ["文件中没有数据行。"]

    id_index = _detect_column(headers, ID_ALIASES)
    text_index = _detect_column(headers, TEXT_ALIASES)

    if text_index is None:
        # 没有识别到明确的文本列时，退化为「最长的那一列」。
        text_index = _longest_column(headers, rows)
        warnings.append(
            f"未识别到文本列，已自动使用列「{headers[text_index]}」作为聚类文本。"
        )

    records: list[dict[str, str]] = []
    for row_index, row in enumerate(rows, start=1):
        text = (row[text_index] if text_index < len(row) else "").strip()
        if not text:
            continue
        raw_id = (row[id_index] if id_index is not None and id_index < len(row) else "").strip()
        record: dict[str, str] = {"id": raw_id or f"row-{row_index}", "text": text}
        for column_index, header in enumerate(headers):
            if column_index in {id_index, text_index} or not header:
                continue
            value = (row[column_index] if column_index < len(row) else "").strip()
            if value:
                record[header] = value
        records.append(record)

    if not records:
        warnings.append("所有数据行的文本列均为空，未得到可用样本。")
    return records, warnings


def _detect_column(headers: list[str], aliases: set[str]) -> int | None:
    """在表头中查找命中的列下标（先精确匹配，再包含匹配）。"""

    normalized = [header.strip().lower() for header in headers]
    for index, header in enumerate(normalized):
        if header in aliases:
            return index
    for index, header in enumerate(normalized):
        if any(alias in header for alias in aliases if len(alias) > 1):
            return index
    return None


def _longest_column(headers: list[str], rows: list[list[str]]) -> int:
    """返回平均长度最大的列下标，作为文本列的兜底推断。"""

    scores: list[float] = []
    for index in range(len(headers)):
        lengths = [len(row[index]) for row in rows if index < len(row)]
        scores.append(sum(lengths) / len(lengths) if lengths else 0.0)
    return max(range(len(headers)), key=lambda i: scores[i])


def _read_csv(data: bytes) -> tuple[list[str], list[list[str]]]:
    """读取 CSV；依次尝试 UTF-8(BOM) 与 GBK 编码。"""

    text: str | None = None
    for encoding in ("utf-8-sig", "gbk", "utf-8"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise FileParseError("CSV 编码无法识别，请另存为 UTF-8 后重试。")

    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise FileParseError("CSV 内容为空。")
    headers = [cell.strip() for cell in rows[0]]
    body = [row for row in rows[1:] if any(cell.strip() for cell in row)]
    return headers, body


def _read_txt(data: bytes) -> tuple[list[str], list[list[str]]]:
    """读取 TXT：每行作为一条样本文本。"""

    text = None
    for encoding in ("utf-8-sig", "gbk", "utf-8"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise FileParseError("TXT 编码无法识别，请另存为 UTF-8 后重试。")

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise FileParseError("TXT 内容为空。")
    return ["text"], [[line] for line in lines]


def _read_json(data: bytes) -> tuple[list[str], list[list[str]]]:
    """读取 JSON 数组，转成 (表头, 数据行)。"""

    records, _ = _read_json_records(data)
    if not records:
        raise FileParseError("JSON 中没有可用记录。")
    headers: list[str] = []
    for record in records:
        for key in record:
            if key not in headers:
                headers.append(key)
    rows = [[record.get(header, "") for header in headers] for record in records]
    return headers, rows


def _read_json_records(data: bytes) -> tuple[list[dict[str, str]], list[str]]:
    """读取 `[{...}, {...}]` 或 `{"items": [...]}` 形式的 JSON。"""

    try:
        payload = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FileParseError(f"JSON 解析失败：{exc}") from exc

    if isinstance(payload, dict):
        for key in ("items", "data", "records", "samples"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
    if not isinstance(payload, list):
        raise FileParseError("JSON 顶层必须是数组，或包含 items / data / records 字段。")

    warnings: list[str] = []
    records: list[dict[str, str]] = []
    for index, entry in enumerate(payload, start=1):
        if not isinstance(entry, dict):
            warnings.append(f"第 {index} 条不是对象，已跳过。")
            continue
        flat: dict[str, str] = {}
        for key, value in entry.items():
            if isinstance(value, (dict, list)):
                continue
            flat[str(key)] = "" if value is None else str(value)
        if flat:
            records.append(flat)
    return records, warnings


def _read_xlsx(data: bytes) -> tuple[list[str], list[list[str]]]:
    """读取 XLSX 第一个工作表，转成 (表头, 数据行)。

    实现直接解析 OOXML，避免为一个上传功能引入 openpyxl 运行时依赖。
    """

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            shared_strings = _read_shared_strings(archive)
            sheet_names = sorted(
                name for name in archive.namelist() if name.startswith("xl/worksheets/sheet")
            )
            if not sheet_names:
                raise FileParseError("XLSX 中没有工作表。")
            rows = _worksheet_to_rows(archive.read(sheet_names[0]), shared_strings)
    except FileParseError:
        raise
    except zipfile.BadZipFile as exc:
        raise FileParseError("XLSX 文件已损坏或不是有效的 Excel 文件。") from exc

    rows = [row for row in rows if any(cell.strip() for cell in row)]
    if not rows:
        raise FileParseError("XLSX 首个工作表为空。")
    width = max(len(row) for row in rows)
    headers = [cell.strip() for cell in rows[0]] + [""] * (width - len(rows[0]))
    body = [row + [""] * (width - len(row)) for row in rows[1:]]
    return headers, body


def _read_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    """读取 XLSX 的共享字符串表（Excel 把重复字符串集中存放，单元格只存索引）。"""

    try:
        xml = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ElementTree.fromstring(xml)
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings: list[str] = []
    for item in root.findall(".//x:si", namespace):
        text = "".join(node.text or "" for node in item.findall(".//x:t", namespace))
        strings.append(unescape(text))
    return strings


def _worksheet_to_rows(xml_bytes: bytes, shared_strings: list[str]) -> list[list[str]]:
    """把单个 worksheet XML 转换为二维行列数据。"""

    root = ElementTree.fromstring(xml_bytes)
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rows: list[list[str]] = []
    for row in root.findall(".//x:row", namespace):
        values: list[str] = []
        for cell in row.findall("x:c", namespace):
            cell_type = cell.attrib.get("t")
            value_node = cell.find("x:v", namespace)
            inline_node = cell.find(".//x:t", namespace)
            if value_node is not None:
                raw_value = value_node.text
            elif inline_node is not None:
                raw_value = inline_node.text
            else:
                raw_value = ""
            if cell_type == "s" and raw_value:
                index = int(raw_value)
                value = shared_strings[index] if index < len(shared_strings) else ""
            else:
                value = raw_value or ""
            values.append(value)
        rows.append(values)
    return rows
