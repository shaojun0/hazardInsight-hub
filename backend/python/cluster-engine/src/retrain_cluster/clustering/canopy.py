"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

Canopy 聚类：用双阈值（t2 强阈值 / t1 弱阈值）做粗聚类。
- 距离 < t2：直接归入当前 canopy，且**不再参与**后续计算（被"吞掉"）；
- t2 <= 距离 < t1：暂时归入当前 canopy，但保留在候选集中，后续可能被更近的 canopy 抢走；
- 距离 >= t1：不属于当前 canopy，留在候选集中。
"""

import numpy as np
from sklearn.metrics import pairwise_distances


def fit_predict(X, t1=2.0, t2=1.0, metric="euclidean"):
    """C-accelerated Canopy clustering."""
    if t2 <= 0 or t1 <= t2:
        raise ValueError(f"Need 0 < t2 < t1, got t1={t1}, t2={t2}")
    n_samples = X.shape[0]
    if n_samples == 0:
        return np.array([], dtype=np.int32)
    labels = np.full(n_samples, -1, dtype=np.int32)
    canopy_centers = []
    indices = list(range(n_samples))
    # 每轮取候选集中"最靠前"的点作为新 canopy 中心，再筛选剩余候选
    while indices:
        idx = indices[0]
        canopy_centers.append(X[idx].copy())
        cid = len(canopy_centers) - 1
        remaining = []
        for j in indices[1:]:
            d = pairwise_distances(X[idx : idx + 1], X[j : j + 1], metric=metric).flat[0]
            if d < t2:
                # 强归属：直接定标签，且不再作为其他 canopy 的候选
                labels[j] = cid
            elif d < t1:
                # 弱归属：先给标签，但保留在候选集中（后续更近的 canopy 可覆盖）
                labels[j] = cid
                remaining.append(j)
            else:
                remaining.append(j)
        labels[idx] = cid
        indices = remaining
    return labels
