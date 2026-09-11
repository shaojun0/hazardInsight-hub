"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

Chinese Whispers：基于 k 近邻图的标签传播聚类。先用 kNN 构图（边权为距离倒数，
越近权重越大），再迭代让每个节点采用邻居中最主流的标签，直至收敛。

graph 是先验未知的，因此返回的是"标签映射"而非固定编号，这里取每个节点所属簇的
最大标签值作为其标签，与历史实现的编号口径保持一致。
"""

import numpy as np
import networkx as nx
from chinese_whispers import chinese_whispers as _cw, aggregate_clusters as _cw_aggregate


def fit_predict(X, n_neighbors=10, weighting="top", iterations=20):
    """基于 C 加速实现的 Chinese Whispers 聚类。"""
    from sklearn.neighbors import NearestNeighbors

    n_samples = X.shape[0]
    if n_samples == 0:
        return np.array([], dtype=np.int32)
    # k 不能超过 n-1（自己不算邻居）；k < 1 时无法构图，全部归为同一簇
    k = min(n_neighbors, n_samples - 1)
    if k < 1:
        return np.zeros(n_samples, dtype=np.int32)
    # 取 k+1 个近邻：第 0 个是自身，后续 [1:] 才是真正的邻居
    nn = NearestNeighbors(n_neighbors=k + 1, metric="euclidean", algorithm="kd_tree")
    nn.fit(X)
    distances, indices = nn.kneighbors(X)
    G = nx.Graph()
    G.add_nodes_from(range(n_samples))
    for i in range(n_samples):
        for j, d in zip(indices[i][1:], distances[i][1:]):
            # 边权 = 1/距离；加 1e-12 避免距离为 0（重复文本）时除零
            G.add_edge(i, j, weight=1.0 / (d + 1e-12))
    # chinese-whispers>=0.9 会原地修改图并返回它；簇标签必须用 aggregate_clusters 提取。
    # 孤立节点可能没有标签条目 -> 回退为单元素簇（即该点自成一簇）。
    _cw(G, weighting=weighting, iterations=iterations)
    label_map = _cw_aggregate(G)
    return np.array([int(max(label_map.get(i, {i}))) for i in range(n_samples)], dtype=np.int32)
