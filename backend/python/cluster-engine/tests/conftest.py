"""跨测试共享的 fixture 与固定用例。

``ALGORITHM_CASES`` 是"算法 → 固定参数"的唯一来源：API 测试与回归测试都从它派生，
因此改了这里就会同时影响两侧，避免两处参数悄悄漂移。
"""

from pathlib import Path
import json
import numpy as np
import pytest
from retrain_cluster.config import Settings
from retrain_cluster.types import NeighborBatch

ROOT = Path(__file__).resolve().parents[1]


class FixedEncoder:
    """确定性替身编码器：同一文本必然得到同一向量，且不依赖任何模型。

    取文本 SHA-256 摘要的前 8 字节并归一化到 [0,1]，
    足以让"不同文本得到不同向量"，同时完全免去模型加载。
    """

    def encode(self, texts):
        import hashlib

        return np.array([[int(v) / 255 for v in hashlib.sha256(text.encode()).digest()[:8]] for text in texts])


class FixedRegistry:
    """总是返回同一个 FixedEncoder 的编码器注册表替身。"""

    def get(self, spec, fingerprint):
        return FixedEncoder()


class ExactNeighbors:
    """精确最近邻检索替身：暴力计算欧氏距离，不使用近似索引。

    提供 ``manifest`` 属性是为了让检索器接口的调用方（如特征流水线）能读到元信息。
    ``query`` 同时接受 ``k`` 与 ``n_results`` 两种参数名，以兼容不同调用约定。
    """

    def __init__(self, values):
        self.values = values
        self.manifest = {"fixture": "exact-neighbors-v1"}

    def query(self, vectors, k=None, n_results=None, include=None):
        k = k or n_results
        # 展开成 (n_query, n_base) 的距离矩阵后逐行取前 k 小
        indices = np.argsort(((np.asarray(vectors)[:, None, :] - self.values[None, :, :]) ** 2).sum(axis=2), axis=1)[
            :, :k
        ]
        values = self.values[indices]
        ids = [[str(i) for i in row] for row in indices]
        # include 非空时返回类 Chroma 的字典形式，否则返回 NeighborBatch
        return {"embeddings": values} if include is not None else NeighborBatch(ids, values, "fixture")


# 跨算法回归用例使用的固定超参。每个条目都必须能在这组小 fixture 上跑通，
# 因此数值都刻意取小。放在这里（而非 tests/regression/）是因为 API 测试也要对它做参数化。
ALGORITHM_CASES = [
    ("agglomerative", {"distance_threshold": 1.0}),
    ("hdbscan", {"alpha": 1.0, "cluster_selection_epsilon": 0.1, "min_cluster_size": 3}),
    ("radbscan", {"eps": 1.0, "min_pts": 3}),
    ("optics", {"min_samples": 3, "xi": 0.05, "min_cluster_size": 0.1}),
    ("affinity_propagation", {"damping": 0.8, "preference": -5.0}),
    ("dbscan", {"eps": 1.0, "min_samples": 3, "leaf_size": 30}),
    ("chinese_whispers", {"n_neighbors": 5, "weighting": "top", "iterations": 10}),
    ("birch", {"threshold": 0.4, "branching_factor": 30}),
    ("leader", {"threshold": 1.0, "metric": "euclidean"}),
    ("canopy", {"t1": 2.0, "t2": 1.0, "metric": "euclidean"}),
    ("mean_shift", {"bandwidth": 1.0, "cluster_all": True, "max_iter": 100}),
]


@pytest.fixture
def arrays():
    """冻结的测试数据：X（向量）、y（真实标签）、knowledge（知识库向量）。"""
    with np.load(ROOT / "tests/fixtures/current-environment.npz", allow_pickle=False) as data:
        return data["X"], data["y"], data["knowledge"]


@pytest.fixture
def settings(tmp_path):
    """在临时目录里搭一份最小可用的配置（模型目录 + 一个 profile）并加载。"""
    (tmp_path / "profiles").mkdir()
    (tmp_path / "models.toml").write_text(
        """[[models]]
model_id = "fixture"
provider = "openai_compatible"
source = "fixture"
base_url = "http://127.0.0.1:9/v1"
revision = "fixture-v1"
dimension = 8
""",
        encoding="utf-8",
    )
    (tmp_path / "app.toml").write_text(
        '[app]\nmodels_file="models.toml"\nprofiles_dir="profiles"\nartifacts_dir="artifacts"\n', encoding="utf-8"
    )
    profile = {
        "profile_id": "fixture",
        "algorithm": "agglomerative",
        "model_id": "fixture",
        "algorithm_params": {"distance_threshold": 0.5},
        "features": {"n_results": 0, "pca_dim": 0},
    }
    (tmp_path / "profiles/fixture.json").write_text(json.dumps(profile), encoding="utf-8")
    return Settings.load(tmp_path / "app.toml")
