"""分类语料解析的回归测试。

这里钉住的全是**启发式**——它们没有"正确答案"可推导，只能靠固定用例防止
以后被人无意改坏。每条启发式对应一条失败模式：

* 分类名漏进描述 → 描述被污染、标签变浅；
* 占位叶子（``其他``）当成描述 → 上百条同文本、不同标签的样本进聚类；
* 分类定义行当成描述 → 描述其实是分类路径，毫无语义；
* 量值（``15m``）被当分类 → 描述开头被削掉一段。

读真实数据的用例在文件缺失时跳过，这样把 ``datas/`` 摘出去也能跑测试。
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from retrain_cluster.data.category_corpus import (
    LEVEL1,
    PLACEHOLDER_LEAVES,
    build_vocabulary,
    load_category_corpus,
    looks_like_category,
    parse_category_table,
    split_of,
)

ROOT = Path(__file__).resolve().parents[2]
RULES = ROOT.parents[2] / "datas" / "rules" / "规则.txt"


def _table(*rows: str) -> tuple[list[dict], Counter]:
    return parse_category_table([f"c {row}" for row in rows])


def test_multi_level_rows_keep_their_categories_and_text():
    """三级分类 + 描述：分类进 categories，描述完整保留（含内部空格）。"""

    records, dropped = _table(
        "现场作业 爆破作业 作业控制区 爆破警戒距离不得低于300m，爆破单位根据现场条件编制警戒方案。",
        "现场作业 爆破作业 作业控制区 每次爆破工作开始前应设置安全警戒线。",
        "现场作业 爆破作业 作业控制区 警戒线内不得留有人员。",
        "现场环境和条件 现场物项存放 材料堆场及周边5m范围内管理混乱",
    )
    assert not dropped
    first = records[0]
    assert first["categories"] == ["现场作业", "爆破作业", "作业控制区"]
    assert first["text"].startswith("爆破警戒距离")
    assert records[-1]["categories"] == ["现场环境和条件", "现场物项存放"]


def test_placeholder_leaves_are_dropped():
    """``其他``/``其它`` 是占位叶子，不是描述。"""

    records, dropped = _table(
        "现场作业 动火作业 作业许可 其他",
        "现场施工机械、器具 起重设备 流动式起重机 其它",
        "现场作业 其它 未按规定上报作业信息",
    )
    assert dropped["占位叶子"] == 2
    assert len(records) == 1
    assert records[0]["text"] == "未按规定上报作业信息"


def test_taxonomy_definition_rows_are_dropped():
    """末段是逗号连接的分类路径时，该行是分类定义而不是隐患描述。"""

    records, dropped = _table(
        "现场环境和条件 环保检查 噪声污染防治 设备噪声管控 环保检查,噪声污染防治,设备噪声管控",
    )
    assert dropped["分类定义行"] == 1
    assert records == []


def test_rare_category_is_pulled_back_out_of_the_text():
    """只出现一次的分类名进不了词表，必须靠漏词修正退回分类位。

    这条正是"分类名漏进描述"的失败模式：漏判会让描述以分类名开头、标签变浅。
    """

    records, _ = _table(
        "现场作业 爆破作业 爆破作业单位资质 爆破作业单位应具有相应资质。",
        "现场作业 爆破作业 爆破作业单位资质 爆破作业人员应持证上岗。",
        "现场作业 爆破作业 爆破作业单位资质 资质等级应符合承接范围。",
        # 下面这条的三级分类只出现一次，词表里没有它
        "现场作业 爆破作业 单位资质与报备 爆破单位资质符合要求并到公安部门备案。",
    )
    last = records[-1]
    assert last["categories"] == ["现场作业", "爆破作业", "单位资质与报备"]
    assert last["text"] == "爆破单位资质符合要求并到公安部门备案。"


def test_numeric_quantity_is_not_mistaken_for_a_category():
    """``15m`` 是描述的一部分：它短、无句读，但不该被退回分类位。"""

    records, _ = _table(
        "现场作业 高处作业 作业许可 15m 以上的高处作业办理高处作业许可证。",
        "现场作业 高处作业 作业许可 作业票应由作业负责人办理。",
        "现场作业 高处作业 作业许可 作业票应在有效期内使用。",
    )
    first = records[0]
    assert first["categories"] == ["现场作业", "高处作业", "作业许可"]
    assert first["text"].startswith("15m 以上的高处作业")


def test_vocabulary_needs_repetition_and_ignores_position_one():
    """词表只统计位置 2/3，且出现次数不够的 token 不进词表。"""

    tokenized = [
        "c 现场作业 A B 描述一".split(),
        "c 现场作业 A B 描述二".split(),
        "c 现场作业 A C 描述三".split(),
    ]
    vocabulary = build_vocabulary(tokenized, minimum=2)
    assert "现场作业" not in vocabulary[2]
    assert "A" in vocabulary[2]
    # 位置 3：B 出现两次进词表，C 只出现一次不进
    assert vocabulary[3] == {"B"}


def test_category_likeness_guards_length_punctuation_and_leading_digit():
    assert looks_like_category("防火花措施")
    assert looks_like_category("单位资质与报备")
    assert not looks_like_category("15m")
    assert not looks_like_category("")
    assert not looks_like_category("爆破单位资质符合要求，并到公安部门备案。")
    assert not looks_like_category("这是一个超过十二个字的分类名示例")


def test_labels_follow_the_category_depth(tmp_path):
    """深度不足时标签降级而不是编造：一级分类下 ``l3`` 必须是 None。"""

    path = tmp_path / "rules.txt"
    path.write_text(
        "\n".join(
            [
                "a 基础管理 其它 A01将建设项目发包给不具备安全生产条件的施工企业。",
                "c 基础管理 作业组织与安排 未按规定上报作业信息",
                "c 现场作业 动火作业 作业许可 作业票应在有效期内使用。",
                "c 现场作业 动火作业 作业许可 作业票应由作业负责人办理。",
                "c 现场作业 动火作业 作业许可 作业票不得跨区域使用。",
            ]
        ),
        encoding="utf-8",
    )
    corpus = load_category_corpus(path)
    by_text = {item["text"]: item for item in corpus["items"]}

    two_level = by_text["未按规定上报作业信息"]
    assert two_level["depth"] == 2
    assert two_level["labels"] == {
        "l1": "基础管理",
        "l2": "基础管理/作业组织与安排",
        "l3": None,
    }

    three_level = by_text["作业票应由作业负责人办理。"]
    assert three_level["depth"] == 3
    assert three_level["labels"]["l2"] == "现场作业/动火作业"
    assert three_level["labels"]["l3"] == "现场作业/动火作业/作业许可"


def test_split_is_deterministic_and_uses_both_sides():
    """切分必须可复现，且两侧都要有样本——否则留出复核形同虚设。"""

    labels = [split_of(f"R{index:05d}") for index in range(400)]
    assert labels == [split_of(f"R{index:05d}") for index in range(400)]
    assert set(labels) == {"calibration", "holdout"}
    assert 0.2 < labels.count("holdout") / len(labels) < 0.4


@pytest.mark.skipif(not RULES.is_file(), reason="datas/rules/规则.txt 不存在")
def test_real_rules_file_is_parsed_without_obvious_damage():
    """真实数据的不变量：规模够用、分类合法、没有占位文本混进来。"""

    corpus = load_category_corpus(RULES)
    items = corpus["items"]
    assert len(items) >= 900
    assert corpus["label_field"] == "l2"

    for item in items:
        assert item["text"].strip()
        assert item["text"] not in PLACEHOLDER_LEAVES
        assert item["labels"]["l1"] in LEVEL1
        assert item["labels"]["l2"].startswith(item["labels"]["l1"])
        assert 1 <= item["depth"] <= 4
    # 同一 id 只能出现一次，否则预测与真值对不上
    assert len({item["id"] for item in items}) == len(items)

    distribution = Counter(item["labels"]["l2"] for item in items)
    assert len(distribution) >= 60
    assert sum(1 for value in distribution.values() if value >= 5) >= 40
