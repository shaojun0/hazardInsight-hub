"""语义特征空间：L2 归一化 + 确定性 PCA，以及 ``X_sem`` / ``X_fit`` 的分离。

为什么必须有两个空间（对应实施计划 4.2 节）：

* ``X_sem``（原始归一化语义向量）**负责语义决策**——噪声判定、中心语义、
  代表文本、命名、质量评分，全部基于它。它是"真相"。
* ``X_fit``（降维后的聚类空间）**只负责选 K 和快速拟合**。它只是加速近似，
  绝不能用于最终归属判定：PCA 可能把两个语义上不同的主题压到很近的位置。

因此本模块把"降维"做成一个可核查的中间步骤，并把降维状态（是否启用、
为什么跳过/回退、拟合用了多少样本）完整记录下来，写进 run manifest。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..errors import ClusterError

#: 近零范数阈值。低于它视为坏向量，不允许"归一化后伪装成正常样本"。
ZERO_NORM_EPS = 1e-8

#: 低于此样本量不做 PCA：小批次降维既不可靠也省不下多少时间。
DEFAULT_PCA_MIN_SAMPLES = 2000

#: 默认降维目标维度。
DEFAULT_PCA_DIM = 64


@dataclass
class SemanticSpace:
    """一次请求的语义空间与拟合空间的完整描述。"""

    sem: np.ndarray  # (U, D) float32，已 L2 归一化
    fit: np.ndarray  # (U, d) float32，已 L2 归一化；未降维时与 sem 同一对象
    reduction: dict = field(default_factory=dict)
    bad_rows: list[int] = field(default_factory=list)  # 近零范数的唯一文本行号

    @property
    def sem_dim(self) -> int:
        return int(self.sem.shape[1])

    @property
    def fit_dim(self) -> int:
        return int(self.fit.shape[1])


def as_float32(matrix, *, rows: int | None = None, dimension: int | None = None) -> np.ndarray:
    """校验并转成连续的 float32 有限矩阵。

    与 legacy ``validate_matrix`` 的区别只有两条：强制 float32 与内存连续。
    这两点对 10 万 × 1024 的规模很关键——float64 会把常驻内存直接翻倍。
    """

    array = np.asarray(matrix, dtype=np.float32)
    if array.ndim != 2 or not np.isfinite(array).all():
        raise ClusterError("INVALID_EMBEDDINGS", "Expected a finite 2-D numeric matrix", 422)
    if rows is not None and array.shape[0] != rows:
        raise ClusterError("INVALID_EMBEDDINGS", "Embedding row count does not match samples", 422)
    if dimension is not None and array.shape[1] != dimension:
        raise ClusterError("INVALID_EMBEDDINGS", "Embedding dimension does not match model", 422)
    return np.ascontiguousarray(array, dtype=np.float32)


def l2_normalize(matrix: np.ndarray, *, eps: float = ZERO_NORM_EPS) -> tuple[np.ndarray, list[int]]:
    """按行 L2 归一化，返回 ``(归一化矩阵, 近零范数行号)``。

    零向量保持为零向量并被显式报告——把零向量"归一化"成随机方向是最坏的
    处理方式：它会变成一个看起来正常、实际无意义的样本，污染整个簇中心。
    """

    array = np.ascontiguousarray(matrix, dtype=np.float32)
    norms = np.linalg.norm(array, axis=1)
    bad = [int(index) for index in np.nonzero(norms <= eps)[0]]
    safe = np.where(norms <= eps, 1.0, norms).astype(np.float32)
    normalized = array / safe[:, None]
    return np.ascontiguousarray(normalized, dtype=np.float32), bad


def _pca_fit_indices(total: int, fit_samples) -> np.ndarray:
    """确定性抽取拟合样本的下标（等距抽样，与内容无关，但完全可复现）。"""

    if fit_samples is None or fit_samples >= total:
        return np.arange(total, dtype=int)
    step = total / float(fit_samples)
    return np.unique(np.floor(np.arange(fit_samples, dtype=np.float64) * step).astype(int))


def build_semantic_space(
    matrix,
    *,
    pca_dim: int = DEFAULT_PCA_DIM,
    pca_min_samples: int = DEFAULT_PCA_MIN_SAMPLES,
    fit_samples: int = 20000,
    random_state: int = 42,
    rows: int | None = None,
    dimension: int | None = None,
) -> SemanticSpace:
    """归一化向量并（可选地）构造确定性聚类空间。

    降维只在**固定样本**上拟合一次，然后分批变换全量——绝不"对全量 fit"，
    否则同一份数据在不同批次大小下会得到不同结果。

    降维被跳过或回退时，``reduction["status"]`` 会说明原因，而不是静默返回原空间。
    """

    sem_raw = as_float32(matrix, rows=rows, dimension=dimension)
    sem, bad_rows = l2_normalize(sem_raw)
    total = int(sem.shape[0])
    source_dim = int(sem.shape[1])

    info = {
        "status": "disabled",
        "source_dim": source_dim,
        "fit_dim": source_dim,
        "pca_dim": int(pca_dim),
        "fit_samples": 0,
        "random_state": int(random_state),
        "reason": None,
        "whiten": False,
    }

    if pca_dim <= 0 or total < 2 or source_dim < 2:
        info["reason"] = "not_requested" if pca_dim <= 0 else "insufficient_shape"
        return SemanticSpace(sem=sem, fit=sem, reduction=info, bad_rows=bad_rows)

    if total < pca_min_samples:
        info["reason"] = "below_min_samples"
        return SemanticSpace(sem=sem, fit=sem, reduction=info, bad_rows=bad_rows)

    fit_indices = _pca_fit_indices(total, fit_samples)
    n_components = int(min(pca_dim, source_dim, fit_indices.shape[0] - 1))
    if n_components < 2:
        info["reason"] = "insufficient_rank"
        return SemanticSpace(sem=sem, fit=sem, reduction=info, bad_rows=bad_rows)

    try:
        from sklearn.decomposition import PCA

        # 随机化 SVD 必须显式固定 random_state / 迭代次数，否则不同运行结果不同
        model = PCA(
            n_components=n_components,
            svd_solver="randomized",
            random_state=random_state,
            n_oversamples=10,
            iterated_power=4,
            whiten=False,
        )
        model.fit(sem[fit_indices])
        projected = _transform_batches(model, sem)
        projected, projected_bad = l2_normalize(projected)
    except (ValueError, np.linalg.LinAlgError, FloatingPointError) as exc:  # pragma: no cover - 数值退化
        info["status"] = "fallback"
        info["reason"] = f"pca_failed:{type(exc).__name__}"
        return SemanticSpace(sem=sem, fit=sem, reduction=info, bad_rows=bad_rows)

    if projected_bad or not np.isfinite(projected).all():
        # 近零投影 = 秩退化，降维空间已不可信，回退原始语义空间
        info["status"] = "fallback"
        info["reason"] = "zero_projection"
        return SemanticSpace(sem=sem, fit=sem, reduction=info, bad_rows=bad_rows)

    info.update({"status": "applied", "fit_dim": int(projected.shape[1]), "fit_samples": int(fit_indices.shape[0])})
    return SemanticSpace(sem=sem, fit=projected, reduction=info, bad_rows=bad_rows)


def _transform_batches(model, matrix: np.ndarray, *, batch_rows: int = 8192) -> np.ndarray:
    """分批变换，避免一次性构造全量中间矩阵。"""

    total = matrix.shape[0]
    if total <= batch_rows:
        return model.transform(matrix).astype(np.float32)
    output = np.empty((total, model.n_components_), dtype=np.float32)
    for start in range(0, total, batch_rows):
        block = matrix[start : start + batch_rows]
        output[start : start + batch_rows] = model.transform(block).astype(np.float32)
    return output


def project_2d(matrix: np.ndarray, *, random_state: int = 42) -> np.ndarray:
    """把向量投影到二维，仅用于散点展示。

    调用方必须已经做过确定性抽样：这里只负责"给定矩阵 → 给定坐标"，
    不做抽样决策，避免可视化逻辑分散在两处。
    """

    array = as_float32(matrix)
    if array.shape[1] < 2 or array.shape[0] < 2:
        raise ClusterError("INVALID_REDUCTION", "Not enough rows or dimensions for 2-D projection", 422)
    from sklearn.decomposition import PCA

    model = PCA(n_components=2, svd_solver="randomized", random_state=random_state, whiten=False)
    return model.fit_transform(array).astype(np.float32)


def cosine_to_centers(matrix: np.ndarray, centers: np.ndarray, *, block: int = 2048) -> np.ndarray:
    """分块计算 ``U × K`` 的余弦相似度。

    输入必须已归一化，此时余弦相似度就是点积，中心需另行归一化。
    分块的意义是**内存**：U × K 在 10 万 × 256 时是 1 MiB 级别，可控；
    而 U × U 是 37 GiB，绝不能出现。因此这里只允许"对 K 个中心"的块计算。
    """

    matrix = np.ascontiguousarray(matrix, dtype=np.float32)
    centers = np.ascontiguousarray(centers, dtype=np.float32)
    output = np.empty((matrix.shape[0], centers.shape[0]), dtype=np.float32)
    for start in range(0, matrix.shape[0], block):
        stop = min(start + block, matrix.shape[0])
        output[start:stop] = matrix[start:stop] @ centers.T
    return output


def normalize_centers(centers: np.ndarray) -> np.ndarray:
    """归一化中心；零中心保持为零（调用方需自行处理"空中心"）。"""

    array = np.ascontiguousarray(centers, dtype=np.float32)
    if array.size == 0:
        return array
    norms = np.linalg.norm(array, axis=1)
    safe = np.where(norms <= ZERO_NORM_EPS, 1.0, norms).astype(np.float32)
    return np.ascontiguousarray(array / safe[:, None], dtype=np.float32)
