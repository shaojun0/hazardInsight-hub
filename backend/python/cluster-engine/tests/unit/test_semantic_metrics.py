"""离线评价指标的回归测试。

这些算子只被 benchmark/验收调用，不在线上请求路径上，因此**很容易长期不被执行到**。
下面每条都对应一个真实踩过的坑，而不是为了覆盖率凑数。
"""

from __future__ import annotations

import numpy as np
import pytest

from retrain_cluster.evaluation.semantic_metrics import (
    NOISE_LABEL,
    b_cubed_scores,
    noise_scores,
    offline_report,
    pairwise_scores,
    rare_topic_recall,
)


def test_b_cubed_terminates_when_there_is_no_noise_at_all():
    """零噪声时不能递归调用自己。

    曾经的写法是"有已归簇样本就再算一遍仅已归簇版本"，而零噪声时
    子调用的输入与本次完全相同，于是一路递归到 RecursionError。
    基线阈值下 967 条全归簇时必然触发。
    """

    predicted = np.array([0, 0, 1, 1])
    truth = np.array([0, 0, 1, 1])
    result = b_cubed_scores(predicted, truth)
    assert result["b_cubed_f1"] == pytest.approx(1.0)
    # 全部已归簇时，"仅已归簇"与整体是同一集合，数值必须一致
    assert result["assigned_only"]["b_cubed_f1"] == pytest.approx(result["b_cubed_f1"])


def test_b_cubed_treats_noise_as_a_label_but_also_reports_assigned_only():
    """``-1`` 参与整体计算，同时给出"只看已归簇样本"的另一份口径。"""

    predicted = np.array([0, 0, 1, NOISE_LABEL, NOISE_LABEL])
    truth = np.array([0, 0, 1, 1, 2])
    result = b_cubed_scores(predicted, truth)
    assert result["b_cubed_f1"] is not None
    # 仅已归簇版本错把两条真值不同的样本放在同一个噪声簇里，整体分数必然更低
    assert result["assigned_only"]["b_cubed_f1"] == pytest.approx(1.0)
    assert result["b_cubed_f1"] < result["assigned_only"]["b_cubed_f1"]


def test_b_cubed_handles_the_empty_input():
    result = b_cubed_scores(np.array([], dtype=np.int64), np.array([], dtype=np.int64))
    assert result == {
        "b_cubed_precision": None,
        "b_cubed_recall": None,
        "b_cubed_f1": None,
        "assigned_only": {},
    }


def test_degenerate_solutions_are_penalised():
    """全判噪声、全并一簇这两种退化解都拿不到高分——因此无需额外的惩罚项。"""

    truth = np.array([0, 0, 1, 1, 2, 2, 3, 3])
    all_noise = b_cubed_scores(np.full(truth.shape, NOISE_LABEL), truth)["b_cubed_f1"]
    one_cluster = b_cubed_scores(np.zeros(truth.shape, dtype=np.int64), truth)["b_cubed_f1"]
    imperfect = b_cubed_scores(np.array([0, 0, 1, 1, 2, 2, 3, 3]), truth)["b_cubed_f1"]

    assert all_noise < 0.5
    assert one_cluster < 0.5
    assert imperfect == pytest.approx(1.0)


def test_pairwise_and_noise_scores_agree_with_by_hand_counts():
    predicted = np.array([0, 0, 1, 1, NOISE_LABEL])
    truth = np.array([0, 0, 1, 1, 1])
    pairwise = pairwise_scores(predicted, truth)
    # 预测里成对：(0,1) 与 (2,3) 各 1 对，共 2 对，全部判对 → precision 1.0；
    # 真值里成对：标签0 的 1 对 + 标签1 的 C(3,2)=3 对，共 4 对 → recall 2/4
    assert pairwise["pairwise_precision"] == pytest.approx(1.0)
    assert pairwise["pairwise_recall"] == pytest.approx(0.5)

    noise = noise_scores(predicted, truth)
    # 预测了一条噪声，但真值里没有噪声 → 误报 1 条，召回无分母
    assert noise["noise_precision"] == pytest.approx(0.0)
    assert noise["noise_recall"] is None
    assert noise["noise_support"] == 0


def test_rare_topic_recall_counts_only_small_true_topics():
    predicted = np.array([0, 0, NOISE_LABEL, 1, 1, 1])
    truth = np.array([0, 0, 1, 1, 1, 1])
    result = rare_topic_recall(predicted, truth, max_size=2)
    # 真值里只有标签0 是小主题（2 条，上限 2），其中两条都被收进有效簇
    assert result["rare_topic_count"] == 1
    assert result["rare_topic_size"] == 2
    assert result["rare_topic_recall"] == pytest.approx(1.0)


def test_rare_topic_recall_is_none_when_no_small_topic_exists():
    """没有小主题时返回 None 而不是 0——"不适用"与"全丢"是两件事。"""

    predicted = np.array([0, 0, 0, 1, 1, 1])
    truth = np.array([0, 0, 0, 1, 1, 1])
    result = rare_topic_recall(predicted, truth, max_size=2)
    assert result == {"rare_topic_recall": None, "rare_topic_count": 0, "rare_topic_size": 0}


def test_offline_report_rejects_shape_mismatch():
    with pytest.raises(ValueError):
        offline_report(np.array([0, 1]), np.array([0, 1, 2]))


def test_offline_report_bundles_every_metric_family():
    predicted = np.array([0, 0, 1, 1, NOISE_LABEL])
    truth = np.array([0, 0, 1, 2, 2])
    report = offline_report(predicted, truth)
    for key in (
        "ari",
        "nmi",
        "ami",
        "pairwise_f1",
        "b_cubed_f1",
        "noise_precision",
        "rare_topic_recall",
        "silhouette_sample",
    ):
        assert key in report, key
    assert report["n_samples"] == 5
