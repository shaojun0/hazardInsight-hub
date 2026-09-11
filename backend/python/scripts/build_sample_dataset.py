"""从隐患抽样 CSV 生成内置示例数据集。

这是一个**离线数据准备脚本**，不参与服务运行：它的产物
`backend/python/samples/hazard_samples.json` 才是随项目分发的示例数据。
因此脚本本身不硬编码任何绝对路径，输入路径由命令行传入。

用法（在 backend/python 下执行）：

```bash
.venv/Scripts/python scripts/build_sample_dataset.py \
    --input ../../datas/test/隐患抽样_抽样50条.csv \
    --output samples/hazard_samples.json
```
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

# 允许直接以脚本方式运行（把 backend/python 加入 sys.path）
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.core.constants import MAX_TEXT_CHARS  # noqa: E402
from app.processors.text_cleaner import clean_hazard_text  # noqa: E402

#: CSV 列名 -> 示例数据里的 metadata 键。
METADATA_COLUMNS = {
    "项目": "project",
    "隐患级别": "grade",
    "隐患分类": "category",
    "排查类型": "inspectionType",
    "作业区域": "area",
}

ID_COLUMN = "隐患单号"
TEXT_COLUMN = "隐患描述"


def build(input_path: Path, output_path: Path, limit: int) -> int:
    """读取 CSV 并写出示例数据集，返回写出的样本数。"""

    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    items: list[dict] = []
    for index, row in enumerate(rows, start=1):
        text = clean_hazard_text((row.get(TEXT_COLUMN) or "").strip(), limit=MAX_TEXT_CHARS)
        if not text:
            continue
        identifier = (row.get(ID_COLUMN) or f"sample-{index}").strip()
        metadata = {
            key: (row.get(column) or "").strip()
            for column, key in METADATA_COLUMNS.items()
            if (row.get(column) or "").strip()
        }
        items.append({"id": identifier, "text": text, "metadata": metadata})
        if len(items) >= limit:
            break

    payload = {
        "dataset_id": input_path.stem,
        "source": input_path.name,
        "text_column": TEXT_COLUMN,
        "id_column": ID_COLUMN,
        "total": len(items),
        "items": items,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return len(items)


def main() -> None:
    """命令行入口。"""

    parser = argparse.ArgumentParser(description="生成聚类模块的内置示例数据集")
    parser.add_argument("--input", required=True, help="源 CSV 路径（隐患抽样）")
    parser.add_argument("--output", required=True, help="输出 JSON 路径")
    parser.add_argument("--limit", type=int, default=500, help="最多写入的样本数")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        raise SystemExit(f"输入文件不存在：{input_path}")
    count = build(input_path, Path(args.output).expanduser().resolve(), args.limit)
    print(f"已写入 {count} 条样本 -> {args.output}")


if __name__ == "__main__":
    main()
