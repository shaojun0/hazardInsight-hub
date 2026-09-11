"""簇摘要测试。

`build_digest` 只做展示加工（代表样本、关键词、元数据分布、置信度归一），
不参与聚类决策，因此用合成向量即可完整覆盖。
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core.errors import ClusteringError
from app.services.cluster_digest import build_digest


def _vectors(rows: list[list[float]]) -> np.ndarray:
    return np.asarray(rows, dtype=np.float64)


def test_clusters_are_grouped_and_labelled():
    """两个明显分离的簇被分别聚合，噪声单独成组。"""

    clusters, items = build_digest(
        sample_ids=["a", "b", "c", "d"],
        texts=["脚手架连墙件缺失", "脚手架连墙件未设置", "配电箱未上锁", "无关样本"],
        labels=np.asarray([0, 0, 1, -1]),
        vectors=_vectors(
            [
                [1.0, 0.0, 0.0],
                [0.99, 0.1, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ]
        ),
        metadata=[{"隐患级别": "A"}, {"隐患级别": "A"}, {"隐患级别": "B"}, {"隐患级别": "C"}],
        top_keywords=3,
        representatives=2,
    )

    by_id = {cluster["cluster_id"]: cluster for cluster in clusters}

    assert set(by_id) == {0, 1, -1}
    assert by_id[0]["size"] == 2
    assert by_id[1]["size"] == 1
    assert by_id[-1]["label"] == "未归簇（噪声）"
    assert by_id[0]["label"] == "类别 0"
    assert len(items) == 4


def test_noise_is_sorted_last():
    """明细默认排序把噪声放最后，前端表格无需再排。"""

    _, items = build_digest(
        sample_ids=["a", "b", "c"],
        texts=["文本一", "文本二", "文本三"],
        labels=np.asarray([-1, 0, 0]),
        vectors=_vectors([[1.0, 0.0], [0.0, 1.0], [0.1, 0.9]]),
        metadata=[{}, {}, {}],
        top_keywords=2,
        representatives=1,
    )

    assert items[-1]["cluster_id"] == -1
    assert [item["cluster_id"] for item in items[:2]] == [0, 0]


def test_confidence_is_normalized_to_unit_interval():
    """置信度被归一化到 0~1，便于前端做视觉区分。"""

    _, items = build_digest(
        sample_ids=["a", "b", "c"],
        texts=["文本一", "文本二", "文本三"],
        labels=np.asarray([0, 0, 0]),
        vectors=_vectors([[1.0, 0.0], [0.9, 0.44], [0.5, 0.87]]),
        metadata=[],
        top_keywords=2,
        representatives=3,
    )

    confidences = [item["confidence"] for item in items]
    assert min(confidences) == pytest.approx(0.0)
    assert max(confidences) == pytest.approx(1.0)
    assert all(0.0 <= value <= 1.0 for value in confidences)


def test_representatives_are_closest_to_centroid():
    """代表样本取与质心最接近的那条，而不是随便取前 N 条。"""

    clusters, _ = build_digest(
        sample_ids=["edge-a", "center", "edge-b"],
        texts=["只有一条孤立描述", "现场作业区域未设置警戒围栏", "另一条孤立描述"],
        labels=np.asarray([0, 0, 0]),
        vectors=_vectors([[1.0, 0.0], [0.9, 0.44], [0.44, 0.9]]),
        metadata=[],
        top_keywords=2,
        representatives=1,
    )

    assert clusters[0]["representative_samples"][0]["id"] == "center"


def test_metadata_distribution_counts_values():
    """元数据分布按取值计数，且只保留出现的取值。"""

    clusters, _ = build_digest(
        sample_ids=["a", "b", "c"],
        texts=["一", "二", "三"],
        labels=np.asarray([0, 0, 0]),
        vectors=_vectors([[1.0, 0.0], [1.0, 0.0], [0.9, 0.1]]),
        metadata=[{"隐患级别": "A"}, {"隐患级别": "A"}, {"隐患级别": "B"}],
        top_keywords=2,
        representatives=1,
    )

    distribution = clusters[0]["metadata_distribution"]["隐患级别"]
    assert distribution[0] == {"value": "A", "count": 2}
    assert distribution[1] == {"value": "B", "count": 1}


def test_keywords_are_extracted_for_clusters_and_items():
    """关键词抽取对簇与单条样本都生效（jieba 未安装时退化为字符 n-gram）。"""

    clusters, items = build_digest(
        sample_ids=["a", "b"],
        texts=["脚手架连墙件缺失导致架体失稳", "脚手架连墙件未按要求设置"],
        labels=np.asarray([0, 0]),
        vectors=_vectors([[1.0, 0.0], [1.0, 0.05]]),
        metadata=[],
        top_keywords=3,
        representatives=1,
    )

    assert clusters[0]["keywords"]
    assert items[0]["keywords"]


def test_cohesion_is_reported_for_cluster():
    """簇内平均余弦相似度被回报，用于判断簇的紧致程度。"""

    clusters, _ = build_digest(
        sample_ids=["a", "b"],
        texts=["一", "二"],
        labels=np.asarray([0, 0]),
        vectors=_vectors([[1.0, 0.0], [1.0, 0.0]]),
        metadata=[],
        top_keywords=1,
        representatives=1,
    )

    assert clusters[0]["cohesion"] == pytest.approx(1.0)


def test_length_mismatch_is_rejected():
    """样本数与标签数不一致时必须报错，而不是产出错位的结果。"""

    with pytest.raises(ClusteringError):
        build_digest(
            sample_ids=["a", "b"],
            texts=["一", "二"],
            labels=np.asarray([0]),
            vectors=_vectors([[1.0, 0.0], [0.0, 1.0]]),
            metadata=[],
            top_keywords=1,
            representatives=1,
        )


def test_internal_arrays_are_not_leaked():
    """内部中间数组（similarities / distances）不进入响应结构。"""

    clusters, _ = build_digest(
        sample_ids=["a"],
        texts=["一"],
        labels=np.asarray([0]),
        vectors=_vectors([[1.0, 0.0]]),
        metadata=[],
        top_keywords=1,
        representatives=1,
    )

    assert "similarities" not in clusters[0]
    assert "distances" not in clusters[0]
