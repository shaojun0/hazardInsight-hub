"""通用助手。

`ensure_directory` / `slugify` / 短 ID 生成沿用源项目
`medica-report-review/app/utils/helpers.py` 的实现思路。
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path


def ensure_directory(path: Path) -> Path:
    """确保目录存在，并返回该目录路径。"""

    path.mkdir(parents=True, exist_ok=True)
    return path


def new_run_id() -> str:
    """生成短运行编号。"""

    return uuid.uuid4().hex[:12]


def slugify(value: str) -> str:
    """把任意名称转换为适合作为文件名片段的 slug（保留中文）。"""

    lowered = value.strip().lower()
    lowered = re.sub(r"[^\w\u4e00-\u9fff]+", "-", lowered)
    return lowered.strip("-") or "dataset"


def truncate(text: str, limit: int) -> tuple[str, bool]:
    """按字符数截断文本，返回 (结果, 是否发生截断)。"""

    if len(text) <= limit:
        return text, False
    return text[:limit], True
