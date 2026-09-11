"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

DBSCAN：基于密度可达性的聚类，能发现任意形状的簇并把稀疏点判为噪声（-1）。
本文件只是对 sklearn 实现的薄封装，参数与历史实验保持完全一致。
"""

import numpy as np


def fit_predict(X, eps=0.5, min_samples=5, leaf_size=30):
    """运行 DBSCAN，返回整数簇标签（-1 为噪声）。"""
    if X.shape[0] == 0:
        return np.array([], dtype=np.int32)

    from sklearn.cluster import DBSCAN

    model = DBSCAN(
        eps=eps,  # 邻域半径
        min_samples=min_samples,  # 成为核心点所需的最小邻居数（含自身）
        leaf_size=leaf_size,  # 树结构叶子大小，影响速度不影响结果
        algorithm="auto",  # 由 sklearn 自动选择最优的邻居搜索算法
        n_jobs=-1,  # 使用全部 CPU 核心
    )
    labels = model.fit_predict(X)
    return labels
