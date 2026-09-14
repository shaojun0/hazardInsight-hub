"""输入校验工具。

校验沿用源项目 `medica-report-review/app/utils/validators.py` 的
「白名单 + 明确领域异常」写法，约束项与 cluster-engine 的 API 上限保持一致。
"""

from __future__ import annotations

from pathlib import Path

from app.core.constants import (
    MAX_ITEMS,
    MAX_TEXT_CHARS,
    MIN_ITEMS,
    SUPPORTED_UPLOAD_EXTENSIONS,
)
from app.core.errors import (
    InvalidInputError,
    TextTooLongError,
    TooManyItemsError,
    UnsupportedFileError,
)


def validate_upload_extension(filename: str) -> str:
    """校验上传文件后缀是否受支持，返回规范化后的后缀。"""

    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise UnsupportedFileError(
            f"不支持的文件类型 '{suffix or '(无后缀)'}'。"
            f"支持：{', '.join(sorted(SUPPORTED_UPLOAD_EXTENSIONS))}",
        )
    return suffix


def validate_item_count(count: int, *, minimum: int = MIN_ITEMS, maximum: int = MAX_ITEMS) -> None:
    """校验样本数量是否落在允许区间内。

    `minimum` 必须可调：`legacy-v1` 的算法至少要 2 条才算得上「聚类」，
    而 `semantic-v1` 明确支持单条（会返回 `singleton` 并如实标注低支持）。
    这条版本相关的准入规则由调用方按解析出的 profile 传进来，
    不在这里按算法名硬编码——否则新增策略时又要改这个通用校验器。
    """

    if count < minimum:
        raise InvalidInputError(f"至少需要 {minimum} 条样本才能进行聚类，当前 {count} 条。")
    if count > maximum:
        raise TooManyItemsError(f"样本数 {count} 超过服务上限 {maximum} 条，请分批处理。")


def validate_text_length(text: str, *, limit: int = MAX_TEXT_CHARS) -> None:
    """校验单条文本长度是否超出引擎上限。"""

    if len(text) > limit:
        raise TextTooLongError(
            f"单条文本长度 {len(text)} 超出上限 {limit} 字符。",
        )
