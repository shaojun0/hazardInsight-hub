"""重构后流水线的黄金簇标签基线。

在这次重构之前，"行为有没有变"这个问题是靠把新包和旧的 ``optimizer`` / ``evaluator``
包做对拍来回答的。那两个包已经删除了，于是改由**记录下来的标签摘要**来回答：
在冻结的 ``tests/fixtures/current-environment.npz`` 输入上，跨检索/pca 网格逐一记录
每个算法产出的标签摘要。

下面这些值采集自"两套实现都还在且结果一致"的最后状态，因此继承了当时的一致性。
日后若特征融合、beta 处理、历史 LabelEncoder 映射或任一算法封装发生变化，
都会在这里表现为摘要不匹配。

**重要：摘要不匹配意味着行为变了。** 正确做法是新增特征版本/实现，
而不是就地修改期望值——否则历史摘要与论文图表会失去依据。
"""

import hashlib
from functools import partial
import numpy as np
import pytest
from sklearn.metrics import adjusted_rand_score
from retrain_cluster.clustering import chinese_whispers as chinese_whispers_backend
from retrain_cluster.clustering.registry import get_clusterer
from retrain_cluster.features.pipeline import FeaturePipeline
from retrain_cluster.types import FeatureSpec
from tests.conftest import ALGORITHM_CASES, ExactNeighbors

# 被测网格：(n_results, pca_dim) 组合
GRID = [(0, 0), (1, 0), (7, 0), (0, 3), (7, 3)]

# (算法, n_results, pca_dim) -> 标签字节流的 SHA-256 前 16 位
GOLDEN = {
    ("agglomerative", 0, 0): "88b311eb96011536",
    ("agglomerative", 1, 0): "5ff13a5d019ff382",
    ("agglomerative", 7, 0): "85d7f999c3b1de0b",
    ("agglomerative", 0, 3): "ba12463ca84f8f1b",
    ("agglomerative", 7, 3): "79d44992ec01041b",
    ("hdbscan", 0, 0): "f54717a1a69a8075",
    ("hdbscan", 1, 0): "226d08a7d188c688",
    ("hdbscan", 7, 0): "f54717a1a69a8075",
    ("hdbscan", 0, 3): "f54717a1a69a8075",
    ("hdbscan", 7, 3): "f54717a1a69a8075",
    ("radbscan", 0, 0): "0be7937bd1b670e2",
    ("radbscan", 1, 0): "0be7937bd1b670e2",
    ("radbscan", 7, 0): "0be7937bd1b670e2",
    ("radbscan", 0, 3): "0be7937bd1b670e2",
    ("radbscan", 7, 3): "0be7937bd1b670e2",
    ("optics", 0, 0): "e9d17ebb44255588",
    ("optics", 1, 0): "5d0aefa47f3e68e2",
    ("optics", 7, 0): "ff6a0c406ef8a3b5",
    ("optics", 0, 3): "6b74d22549a1e02b",
    ("optics", 7, 3): "5deec2fad9e7690c",
    ("affinity_propagation", 0, 0): "f54717a1a69a8075",
    ("affinity_propagation", 1, 0): "f54717a1a69a8075",
    ("affinity_propagation", 7, 0): "f54717a1a69a8075",
    ("affinity_propagation", 0, 3): "f54717a1a69a8075",
    ("affinity_propagation", 7, 3): "f54717a1a69a8075",
    ("dbscan", 0, 0): "f54717a1a69a8075",
    ("dbscan", 1, 0): "f54717a1a69a8075",
    ("dbscan", 7, 0): "f54717a1a69a8075",
    ("dbscan", 0, 3): "f54717a1a69a8075",
    ("dbscan", 7, 3): "f54717a1a69a8075",
    ("chinese_whispers", 0, 0): "f1c1865fa5f19a01",
    ("chinese_whispers", 1, 0): "5da9b556855c7ba2",
    ("chinese_whispers", 7, 0): "3c0ffe78fff1b086",
    ("chinese_whispers", 0, 3): "ae6981722a7e104d",
    ("chinese_whispers", 7, 3): "e959640dc07a6e81",
    ("birch", 0, 0): "01afa6341854f6a5",
    ("birch", 1, 0): "fdface06aaf199e0",
    ("birch", 7, 0): "f54717a1a69a8075",
    ("birch", 0, 3): "f54717a1a69a8075",
    ("birch", 7, 3): "f54717a1a69a8075",
    ("leader", 0, 0): "f54717a1a69a8075",
    ("leader", 1, 0): "f54717a1a69a8075",
    ("leader", 7, 0): "f54717a1a69a8075",
    ("leader", 0, 3): "f54717a1a69a8075",
    ("leader", 7, 3): "f54717a1a69a8075",
    ("canopy", 0, 0): "4dd6b89701928110",
    ("canopy", 1, 0): "f54717a1a69a8075",
    ("canopy", 7, 0): "f54717a1a69a8075",
    ("canopy", 0, 3): "f54717a1a69a8075",
    ("canopy", 7, 3): "f54717a1a69a8075",
    ("mean_shift", 0, 0): "1e74a1749dfa7e4c",
    ("mean_shift", 1, 0): "1e74a1749dfa7e4c",
    ("mean_shift", 7, 0): "1e74a1749dfa7e4c",
    ("mean_shift", 0, 3): "1e74a1749dfa7e4c",
    ("mean_shift", 7, 3): "1e74a1749dfa7e4c",
}


@pytest.fixture(autouse=True)
def deterministic_chinese_whispers(monkeypatch):
    """Chinese Whispers 本身含随机性，这里固定种子使其行为可复现。

    未安装 chinese-whispers 时跳过这组用例（importorskip）。
    """
    chinese_whispers = pytest.importorskip("chinese_whispers")
    monkeypatch.setattr(chinese_whispers_backend, "_cw", partial(chinese_whispers.chinese_whispers, seed=42))


def digest(labels):
    """把标签数组压成短摘要：转 int64 后对字节流取 SHA-256 的前 16 位。"""
    return hashlib.sha256(np.asarray(labels, dtype=np.int64).tobytes()).hexdigest()[:16]


def cluster(arrays, algorithm, params, k, pca):
    """在给定 (k, pca) 组合下跑一遍算法，返回标签。"""
    X, _, database = arrays
    # beta 固定为 0.37，确保融合路径被真实走到（不是退化情形）
    features = FeatureSpec(
        beta=0.37,
        n_results=k,
        pca_dim=pca,
        version="legacy-radbscan-v1" if algorithm == "radbscan" else "legacy-v1",
    )
    features_matrix = FeaturePipeline(ExactNeighbors(database)).transform(X, features)
    return get_clusterer(algorithm)(features_matrix, **params)


def test_golden_table_covers_the_whole_grid():
    """元测试：确保基线表完整覆盖"所有算法 × 整个网格"，没有遗漏条目。"""
    assert len(GOLDEN) == len(ALGORITHM_CASES) * len(GRID)
    assert set(GOLDEN) == {(algorithm, k, pca) for algorithm, _ in ALGORITHM_CASES for k, pca in GRID}


@pytest.mark.parametrize("k,pca", GRID)
@pytest.mark.parametrize("algorithm,params", ALGORITHM_CASES)
def test_labels_match_recorded_golden(arrays, algorithm, params, k, pca):
    """核心断言：当前实现的标签摘要必须与记录的基线完全一致。"""
    labels = cluster(arrays, algorithm, params, k, pca)
    assert len(labels) == 64
    assert digest(labels) == GOLDEN[(algorithm, k, pca)]


def test_recovered_partition_is_the_fixture_ground_truth(arrays):
    """端到端健全性检查：用 DBSCAN 应当 100% 还原 fixture 的真实划分。"""
    X, y, database = arrays
    features = FeatureSpec(beta=0.37, n_results=0, pca_dim=0)
    features_matrix = FeaturePipeline(ExactNeighbors(database)).transform(X, features)
    labels = get_clusterer("dbscan")(features_matrix, eps=1.0, min_samples=3, leaf_size=30)
    assert sorted(set(labels.tolist())) == [0, 1, 2, 3]
    assert adjusted_rand_score(y, labels) == 1.0
