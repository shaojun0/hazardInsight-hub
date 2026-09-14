"""校验工具与领域异常测试。"""

from __future__ import annotations

import pytest

from app.core.constants import MAX_ITEMS
from app.core.errors import (
    ClusterGatewayError,
    InvalidInputError,
    TextTooLongError,
    TooManyItemsError,
    UnsupportedFileError,
    error_payload,
)
from app.utils.helpers import new_run_id, slugify, truncate
from app.utils.validators import validate_item_count, validate_text_length, validate_upload_extension


def test_upload_extension_is_case_insensitive():
    """后缀比较忽略大小写，且在白名单内放行。"""

    assert validate_upload_extension("Hazards.CSV") == ".csv"
    assert validate_upload_extension("data.xlsx") == ".xlsx"


def test_upload_extension_rejects_unknown():
    """未在白名单内的类型直接拒绝，错误码可用于前端提示。"""

    with pytest.raises(UnsupportedFileError) as excinfo:
        validate_upload_extension("report.pdf")

    assert excinfo.value.code == "UNSUPPORTED_FILE"
    assert excinfo.value.status == 400


def test_upload_extension_handles_missing_suffix():
    """没有后缀的文件给出可读提示，而不是空字符串比较。"""

    with pytest.raises(UnsupportedFileError) as excinfo:
        validate_upload_extension("noextension")

    assert "(无后缀)" in excinfo.value.message


def test_item_count_lower_bound():
    """默认（legacy-v1）少于 2 条样本时拒绝。"""

    with pytest.raises(InvalidInputError):
        validate_item_count(1)


def test_item_count_allows_single_item_when_minimum_is_one():
    """semantic-v1 允许单条：它自己会返回 singleton 并如实标注低支持。

    门槛由调用方按解析出的 profile 传进来，不在校验器里按算法名硬编码。
    """

    validate_item_count(1, minimum=1)

    with pytest.raises(InvalidInputError):
        validate_item_count(0, minimum=1)


def test_item_count_upper_bound():
    """超过上限时返回 400 语义（而不是让引擎去拒绝）。"""

    with pytest.raises(TooManyItemsError) as excinfo:
        validate_item_count(MAX_ITEMS + 1)

    assert excinfo.value.status == 400


def test_item_count_accepts_boundary_values():
    """边界值都应通过：下限 2（legacy）、上限 MAX_ITEMS。"""

    validate_item_count(2)
    validate_item_count(MAX_ITEMS)


def test_text_length_limit():
    """超出长度上限时抛出 TextTooLongError。"""

    validate_text_length("隐" * 100, limit=100)

    with pytest.raises(TextTooLongError):
        validate_text_length("隐" * 101, limit=100)


def test_error_payload_shape_matches_contract():
    """领域异常能转成与前端类型一致的错误结构。"""

    payload = error_payload(InvalidInputError("样本 ID 必须唯一。"), request_id="req-1")

    assert payload == {
        "code": "INVALID_INPUT",
        "message": "样本 ID 必须唯一。",
        "requestId": "req-1",
        "detail": None,
    }


def test_gateway_error_defaults():
    """基类自带兜底错误码与 500，子类各自覆盖。"""

    base = ClusterGatewayError("出错了")
    assert base.status == 500
    assert base.code == "INTERNAL_ERROR"
    assert str(base) == "出错了"
    assert error_payload(base)["code"] == "INTERNAL_ERROR"


def test_truncate_reports_whether_it_cut():
    """truncate 返回 (结果, 是否截断)，调用方据此决定是否加警告。"""

    assert truncate("abc", 5) == ("abc", False)
    assert truncate("abcdef", 5) == ("abcde", True)


def test_slugify_keeps_readable_ascii():
    """slugify 把文件名压成安全的 ASCII 片段。"""

    assert slugify("隐患抽样_抽样50条.csv") != ""
    assert " " not in slugify("a b c.csv")


def test_new_run_id_is_unique_and_safe():
    """运行 ID 唯一且只含文件名安全字符。"""

    first = new_run_id()
    second = new_run_id()

    assert first != second
    assert first.replace("-", "").replace("_", "").isalnum()
