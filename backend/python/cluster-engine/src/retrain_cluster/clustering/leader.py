"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

Leader-Follower（领头者-跟随者）增量聚类：单趟扫描，每个点要么并入最近的已有簇
（距离小于阈值），要么自己成为新簇的中心。簇中心用增量均值维护，因此是 O(n) 复杂度。
"""

import numpy as np
from sklearn.metrics import pairwise_distances


def fit_predict(X, threshold=1.0, metric="euclidean"):
    """Leader-Follower（增量式）聚类。

    Parameters
    ----------
    X : np.ndarray, shape (n_samples, n_features)
    threshold : float
        创建新簇的距离阈值：与最近簇中心的距离小于它则归入该簇。
    metric : str
        距离度量（见 ``sklearn.metrics.pairwise_distances``）。

    Returns
    -------
    labels : np.ndarray, shape (n_samples,), dtype=np.int32
    """
    n_samples = X.shape[0]
    if n_samples == 0:
        return np.array([], dtype=np.int32)
    labels = np.full(n_samples, -1, dtype=np.int32)
    centers: list[np.ndarray] = []  # 各簇中心
    cluster_counts: list[int] = []  # 各簇已包含的点数，用于增量均值

    for i in range(n_samples):
        x = X[i : i + 1]  # 保持二维，pairwise_distances 要求 2D 输入

        if not centers:
            # 第一个点必然开启第一个簇
            centers.append(X[i].copy())
            cluster_counts.append(1)
            labels[i] = 0
            continue

        all_centers = np.array(centers)
        dists = pairwise_distances(x, all_centers, metric=metric).ravel()
        nearest = int(np.argmin(dists))

        if dists[nearest] < threshold:
            # 归入已有簇，并把中心更新为"加入该点后的新均值"
            labels[i] = nearest
            # 增量均值：new = old * (c-1)/c + x/c，避免保存全部历史点
            cluster_counts[nearest] += 1
            c = cluster_counts[nearest]
            centers[nearest] = centers[nearest] * (c - 1) / c + X[i] / c
        else:
            # 距离所有中心都过远 => 以该点为中心新建一簇
            labels[i] = len(centers)
            centers.append(X[i].copy())
            cluster_counts.append(1)

    return labels
