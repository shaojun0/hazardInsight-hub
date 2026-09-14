"""MiniBatchKMeans 核心与"矩阵入口"适配层（``semantic_auto_kmeans``）。

本文件承担两个角色：

1. **核心方法**（``fit_mbk`` / ``assign`` / ``refine_with_cosine``）——
   供 ``SemanticAutoKMeansStrategy`` 调用，返回中心、标签与诊断，
   不需要为了拿诊断而把整条流程再跑一遍。
2. **矩阵兼容入口**（``fit_predict``）——满足底层算法注册表
   ``fit_predict(X, **params) -> labels`` 的契约，供算法发现、
   最小矩阵测试与 legacy 风格的直接调用使用。

关于命名（刻意保守，见实施计划 5.3）：

单位化输入上的欧氏 KMeans **不严格等价**于 spherical KMeans，因为中心本身
不是单位向量。因此这里的流程如实命名为"MBK 初始化聚类 + 原空间余弦修正"，
并且明确声明：余弦修正可能改变标签，修正后必须重算噪声与质量分，
不能声称"优化的是同一个 KMeans 目标"。
"""

from __future__ import annotations

import math

import numpy as np

from ..errors import ClusterError
from ..features.semantic import l2_normalize, normalize_centers

#: 余弦修正的默认轮数（"最多两轮"）。
DEFAULT_REFINE_ROUNDS = 2


def _check_matrix(matrix) -> np.ndarray:
    array = np.ascontiguousarray(np.asarray(matrix, dtype=np.float32))
    if array.ndim != 2 or array.shape[0] < 1 or not np.isfinite(array).all():
        raise ClusterError("INVALID_EMBEDDINGS", "Expected a finite 2-D numeric matrix", 422)
    return array


def fit_mbk(
    matrix,
    k: int,
    *,
    seed: int = 42,
    batch_size: int = 1024,
    max_iter: int = 100,
    n_init: int = 3,
    max_no_improvement: int = 10,
    centers=None,
) -> dict:
    """拟合 MiniBatchKMeans，返回 ``{centers, labels, k, n_empty, n_iter}``。

    两个刻意的选择：

    * ``reassignment_ratio=0``——降低低计数中心的随机迁移，让"小簇不会被
      大簇反复吞掉"这件事更可预期。
    * 传入 ``centers`` 时显式 ``n_init=1``——用样本解中心初始化全量拟合时，
      重复跑多次初始化只会引入额外随机性，没有收益。

    ``n_init`` 在 MiniBatchKMeans 里的语义是"试验初始化次数"，
    **不等于**执行同等次数的完整训练；多次完整拟合的稳定性检查
    由 Auto-K 的挑战重拟合显式完成。
    """

    matrix = _check_matrix(matrix)
    total, dimension = matrix.shape
    if not 2 <= int(k) <= total:
        raise ClusterError("INVALID_PROFILE", "n_clusters must be within [2, n_samples]", 422)

    from sklearn.cluster import MiniBatchKMeans

    # sklearn 要求 batch_size >= n_clusters，否则直接抛错；这里向上取整到下限
    effective_batch = int(max(batch_size, k, 1))
    init = "k-means++"
    init_n = max(1, int(n_init))
    if centers is not None:
        init = np.ascontiguousarray(np.asarray(centers, dtype=np.float64))
        if init.shape != (int(k), dimension):
            raise ClusterError("INVALID_PROFILE", "Initial centers do not match n_clusters/dimension", 422)
        init_n = 1

    model = MiniBatchKMeans(
        n_clusters=int(k),
        init=init,
        n_init=init_n,
        batch_size=effective_batch,
        max_iter=int(max_iter),
        max_no_improvement=None if max_no_improvement is None else int(max_no_improvement),
        random_state=int(seed),
        reassignment_ratio=0.0,
        compute_labels=False,
        tol=0.0,
    )
    model.fit(matrix)
    centers_out = np.ascontiguousarray(model.cluster_centers_, dtype=np.float32)
    labels = assign(matrix, centers_out)[0]
    empty = int(sum(1 for index in range(int(k)) if not np.any(labels == index)))
    return {
        "centers": centers_out,
        "labels": labels,
        "k": int(k),
        "n_empty": empty,
        "n_iter": int(getattr(model, "n_iter_", max_iter)),
    }


def assign(matrix, centers, *, block: int = 2048) -> tuple[np.ndarray, np.ndarray]:
    """按余弦相似度分配（分块），返回 ``(标签, 到所属中心的相似度)``。

    输入向量与中心都已归一化，因此余弦相似度就是点积。分块只保留
    ``U × K`` 的中间结果，绝不构造 ``U × U``。
    """

    matrix = _check_matrix(matrix)
    normalized_centers = normalize_centers(np.asarray(centers, dtype=np.float32))
    if normalized_centers.ndim != 2 or normalized_centers.shape[1] != matrix.shape[1]:
        raise ClusterError("INVALID_EMBEDDINGS", "Centers do not match the embedding dimension", 422)
    labels = np.empty(matrix.shape[0], dtype=np.int32)
    scores = np.empty(matrix.shape[0], dtype=np.float32)
    for start in range(0, matrix.shape[0], block):
        stop = min(start + block, matrix.shape[0])
        similarities = matrix[start:stop] @ normalized_centers.T
        best = np.argmax(similarities, axis=1)
        labels[start:stop] = best.astype(np.int32)
        scores[start:stop] = similarities[np.arange(stop - start), best].astype(np.float32)
    return labels, scores


def recompute_centers(matrix, labels, k: int) -> tuple[np.ndarray, list[int]]:
    """按当前标签重算中心（语义空间均值 + 归一化）。

    返回 ``(中心, 空簇编号)``。空簇保留零中心并在结果里显式报告——
    legacy 的"用随机点填满 K"做法会让结果看起来完整、实际毫无依据。
    """

    matrix = _check_matrix(matrix)
    centers = np.zeros((int(k), matrix.shape[1]), dtype=np.float32)
    empty: list[int] = []
    for index in range(int(k)):
        members = matrix[labels == index]
        if members.shape[0] == 0:
            empty.append(index)
            continue
        centers[index] = members.mean(axis=0)
    normalized = normalize_centers(centers)
    return normalized, empty


def refine_with_cosine(
    matrix,
    centers,
    labels,
    *,
    rounds: int = DEFAULT_REFINE_ROUNDS,
    block: int = 2048,
) -> dict:
    """在原始归一化语义空间上做有界余弦分配/中心更新。

    这是"修正"而不是"继续优化 KMeans"：每一轮都可能改变标签，
    所以调用方必须在轮次结束后重新计算噪声、凝聚与质量分。
    """

    current_centers = normalize_centers(np.asarray(centers, dtype=np.float32))
    current_labels = np.asarray(labels, dtype=np.int32)
    history: list[dict] = []
    rounds = max(0, int(rounds))
    for round_index in range(rounds):
        new_labels, scores = assign(matrix, current_centers, block=block)
        changed = int((new_labels != current_labels).sum())
        current_labels = new_labels
        current_centers, empty = recompute_centers(matrix, current_labels, current_centers.shape[0])
        history.append({"round": round_index + 1, "changed": changed, "empty_clusters": empty})
        if changed == 0:
            # 已收敛，剩余轮次不会带来任何变化
            break
    return {
        "centers": current_centers,
        "labels": current_labels,
        "rounds": len(history),
        "history": history,
    }


def fit_predict(
    X,
    *,
    k_cap: int = 256,
    seed: int = 42,
    sample_size: int = 8192,
    validation_size: int = 2048,
    max_iter: int = 100,
    batch_size: int = 1024,
    n_init: int = 3,
    pca_dim: int = 64,
    pca_min_samples: int = 2000,
    min_cluster_unique: int = 5,
    split_budget: int = 8,
    merge_rounds: int = 2,
    refine_rounds: int = DEFAULT_REFINE_ROUNDS,
    t_sem: float = 0.80,
    t_pair: float = 0.85,
    t_merge: float = 0.88,
    t_margin: float = 0.03,
    n_clusters: int | None = None,
):
    """矩阵兼容入口：``fit_predict(X, **params) -> labels``。

    这是给算法注册表、最小矩阵测试与"只想拿标签"的调用方用的薄适配层，
    内部委托给完整的 Auto-K 流程（``clustering.auto_k``）。它**不重复实现**
    任何算法：Auto-K、后处理、规范编号全部复用同一份实现，
    Strategy 也走同一份，因此不存在"矩阵入口与线上入口行为不一致"的问题。

    ``t_sem`` 等阈值只在直接调用本函数时生效；线上语义路径的阈值一律
    来自 ``configs/semantic-calibration-v1.json``，不由此处传入。
    """

    # 局部导入：auto_k 依赖本模块的 fit_mbk/assign，顶层互相导入会成环
    from .auto_k import run_auto_k

    matrix = _check_matrix(X)
    if matrix.shape[0] < 2:
        raise ClusterError("INVALID_SAMPLE_COUNT", "At least 2 rows are required", 422)

    from ..features.semantic import build_semantic_space

    space = build_semantic_space(matrix, pca_dim=int(pca_dim), pca_min_samples=int(pca_min_samples), random_state=int(seed))
    outcome = run_auto_k(
        space,
        unique_keys=[f"row-{index}" for index in range(matrix.shape[0])],
        k_cap=int(k_cap),
        seed=int(seed),
        sample_size=int(sample_size),
        validation_size=int(validation_size),
        forced_k=n_clusters,
        max_iter=int(max_iter),
        batch_size=int(batch_size),
        n_init=int(n_init),
        t_sem=float(t_sem),
        t_pair=float(t_pair),
        t_merge=float(t_merge),
        t_margin=float(t_margin),
        min_cluster_unique=int(min_cluster_unique),
        split_budget=int(split_budget),
        merge_rounds=int(merge_rounds),
        refine_rounds=int(refine_rounds),
    )
    return outcome["labels"]


def j_to_score(j: float) -> float:
    """把内部组合分映射到 [0, 1]，仅用于诊断展示，不改变任何排序。"""

    if not math.isfinite(j):
        return 0.0
    return float(min(1.0, max(0.0, (j + 0.2) / 1.2)))


__all__ = [
    "DEFAULT_REFINE_ROUNDS",
    "fit_mbk",
    "assign",
    "recompute_centers",
    "refine_with_cosine",
    "fit_predict",
    "j_to_score",
    "l2_normalize",
]
