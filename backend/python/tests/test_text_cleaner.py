"""文本清洗测试。"""

from __future__ import annotations

from app.processors.text_cleaner import clean_hazard_text, collapse_spaces, normalize_punctuation


def test_full_width_punctuation_is_unified():
    """全角标点统一为半角，降低分词噪声。"""

    assert normalize_punctuation("现场，未设置警戒；应当立即整改。") == "现场,未设置警戒;应当立即整改."


def test_collapse_spaces_handles_ideographic_space():
    """连续空白（含全角空格）压缩为单个空格。"""

    assert collapse_spaces("  现场\u3000\u3000  未   设置  ") == "现场 未 设置"


def test_control_and_zero_width_chars_removed():
    """控制字符与零宽字符被清除，避免污染向量。"""

    dirty = "现场\u200b未设置\ufeff警戒\u0007围栏"
    assert clean_hazard_text(dirty) == "现场未设置警戒围栏"


def test_blank_lines_collapsed_to_single_break():
    """连续空行压缩为最多一个空行。"""

    cleaned = clean_hazard_text("第一行\n\n\n\n第二行")
    assert cleaned == "第一行\n\n第二行"


def test_long_text_is_truncated_with_ellipsis():
    """超长文本按上限截断并加省略号，保证不会超出模型输入长度。"""

    cleaned = clean_hazard_text("隐" * 50, limit=10)
    assert len(cleaned) == 10
    assert cleaned.endswith("…")
    assert cleaned.startswith("隐")


def test_short_text_is_untouched():
    """未超限的文本保持原样（除规范化外）。"""

    assert clean_hazard_text("脚手架连墙件缺失") == "脚手架连墙件缺失"


def test_full_width_digits_normalized_by_nfkc():
    """NFKC 规范化把全角数字/字母转成半角。"""

    assert clean_hazard_text("１号机组Ａ区") == "1号机组A区"
