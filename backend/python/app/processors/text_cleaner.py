"""文本清洗。

`collapse_spaces` 与「压缩连续空白」的处理方式取自源项目
`medica-report-review` 的 `app/processors/text_parser.py`，并按隐患描述文本的
特点做了扩展（去控制字符、统一全角标点、合并空行、限制长度）。
"""

from __future__ import annotations

import re
import unicodedata

from app.core.constants import MAX_TEXT_CHARS

#: 需要折叠掉的零宽字符与控制字符（保留换行与制表符由后续步骤处理）。
_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\ufeff]")

#: 连续空白（含全角空格）压缩为单个空格。
_WHITESPACE = re.compile(r"[ \t\u3000]+")

#: 连续空行压缩为单个换行。
_BLANK_LINES = re.compile(r"\n{3,}")

#: 全角标点 → 半角标点的映射，便于后续关键词切分。
_PUNCT_MAP = {
    "，": ",",
    "。": ".",
    "；": ";",
    "：": ":",
    "（": "(",
    "）": ")",
    "、": ",",
    "！": "!",
    "？": "?",
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
}


def collapse_spaces(text: str) -> str:
    """压缩连续空白字符，供后续文本清洗复用。"""

    return _WHITESPACE.sub(" ", text).strip()


def normalize_punctuation(text: str) -> str:
    """把常见全角标点替换为半角，降低分词与统计的噪声。"""

    return "".join(_PUNCT_MAP.get(char, char) for char in text)


def clean_hazard_text(text: str, *, limit: int = MAX_TEXT_CHARS) -> str:
    """清洗一条隐患描述文本。

    处理顺序：Unicode 规范化 → 去控制字符 → 统一标点 → 压缩空白与空行 →
    按长度截断。返回结果可以直接送入向量模型或分词器。
    """

    normalized = unicodedata.normalize("NFKC", text)
    without_control = _CONTROL_CHARS.sub("", normalized)
    unified = normalize_punctuation(without_control)
    collapsed = _BLANK_LINES.sub("\n\n", _WHITESPACE.sub(" ", unified)).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(0, limit - 1)].rstrip() + "…"
