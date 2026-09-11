"""RADBSCAN：在 DBSCAN 的密度扩张之上引入"转发关系"作为跨密度间隙的桥梁。

与标准 DBSCAN 的差别只有一个：扩张种子集合除了 eps 邻域内的点，还会并入与当前点
存在 forwarding 关系的点，使原本因密度不足而无法连通的两片区域能被"桥接"起来。

注意：本文件的标签语义是论文式的（-2 表示噪声），只在返回前转成通用约定（-1），
这是为了与论文 Algorithm 1/3 的伪代码保持逐行对应，便于论文复现。
"""

from typing import Optional
import numpy as np
from sklearn.metrics import pairwise_distances


class RADBSCANOptimizer:
    def __init__(self, forwarding_matrix=None):
        self.forwarding_matrix = forwarding_matrix

    def fit_predict(
        self, X: np.ndarray, eps: float, min_pts: int, forwarding_matrix: Optional[np.ndarray] = None
    ) -> np.ndarray:
        """
        Run RADBSCAN clustering.

        Parameters
        ----------
        X : np.ndarray, shape (n_samples, n_features)
            Input data points (sentence embeddings).
        eps : float
            Neighborhood radius.
        min_pts : int
            Minimum number of points required to form a dense region (core point).
        forwarding_matrix : np.ndarray or None
            n×n boolean/float matrix of forwarding relationships. If provided,
            overrides the instance-level matrix for this call.

        Returns
        -------
        labels : np.ndarray, shape (n_samples,)
            Cluster labels. -1 indicates noise.
        """
        n = len(X)
        if n == 0:
            return np.array([], dtype=int)

        # ---- 解析转发矩阵：调用级参数优先于实例级参数 ----
        fwd = forwarding_matrix if forwarding_matrix is not None else self.forwarding_matrix
        if fwd is None:
            # 未提供转发关系时退化为标准 DBSCAN 行为（全 False 矩阵等价于没有桥接边）
            fwd = np.zeros((n, n), dtype=bool)
        else:
            fwd = np.asarray(fwd, dtype=bool)

        # ---- 成对距离矩阵：一次性算好，供后续所有区域查询复用 ----
        dist_matrix = pairwise_distances(X, metric="euclidean")

        # ---- 状态记录 ----
        # labels:  -1 = 未定义（初始）,  -2 = 噪声（论文口径）,  >=0 = 簇编号
        labels = np.full(n, -1, dtype=int)
        visited = np.zeros(n, dtype=bool)

        cluster_id = 0

        # ---- 主循环（论文 Algorithm 1）----
        for p in range(n):
            # 已处理过或已被标记为噪声的点跳过
            if visited[p] or labels[p] == -2:
                continue

            neighbor_pts, related_pts = self._region_query(p, dist_matrix, eps, fwd)

            if len(neighbor_pts) < min_pts:
                # 邻域点数不足 => 暂标记为噪声，但后续仍可能被别的核心点扩张进来
                labels[p] = -2
            else:
                cluster_id += 1
                visited[p] = True
                # 把转发相关的点并入工作邻居集合，实现跨密度间隙的桥接
                combined = np.union1d(neighbor_pts, related_pts).astype(int)
                self._expand_cluster(
                    p,
                    combined,
                    cluster_id,
                    eps,
                    min_pts,
                    dist_matrix,
                    fwd,
                    visited,
                    labels,
                )

        # 把内部的噪声标记（-2）统一转换成标准输出约定（-1）
        labels[labels == -2] = -1
        return labels

    @staticmethod
    def _region_query(p: int, dist_matrix: np.ndarray, eps: float, forwarding: np.ndarray):
        """
        返回 (邻域点下标, 转发相关点下标)。

        NeighborPts —— 距离 P 不超过 eps 的所有点（含 P 自身，距离为 0）。
        RelatedPts  —— 与 P 存在转发关系的所有点。
        """
        # 与 P 距离 <= eps 的点（包含 P 自身：距离为 0）
        neighbor_pts = np.where(dist_matrix[p] <= eps)[0]
        # 与 P 存在转发关系的点
        related_pts = np.where(forwarding[p])[0]
        return neighbor_pts, related_pts

    @staticmethod
    def _expand_cluster(
        p: int,
        neighbor_pts: np.ndarray,
        cluster_id: int,
        eps: float,
        min_pts: int,
        dist_matrix: np.ndarray,
        forwarding: np.ndarray,
        visited: np.ndarray,
        labels: np.ndarray,
    ):
        """
        基于动态增长种子列表的密度可达扩张。

        严格按论文 Algorithm 3 实现：
        - 把 P 加入簇 C
        - 对 NeighborPts 中的每个 P'：
            - 若 P' 未访问：标记已访问，并对 P' 做区域查询
            - 若 NeighborPts' 的规模 >= MinPts：把 NeighborPts' 与 RelatedPts'
              追加进主 NeighborPts 列表（使其后续会被遍历到）
            - 若 P' 尚未属于任何簇：把 P' 加入簇 C

        种子集合会随核心区域的发现动态增长；转发关系则充当跨越密度间隙的桥。
        """
        # 起始点 P 先归入当前簇
        labels[p] = cluster_id

        # 可扩张的种子列表（类似队列/栈，遍历过程中不断变长）
        seeds = list(neighbor_pts)
        idx = 0
        while idx < len(seeds):
            q = int(seeds[idx])
            idx += 1

            if not visited[q]:
                visited[q] = True
                neighbor_q, related_q = RADBSCANOptimizer._region_query(q, dist_matrix, eps, forwarding)
                if len(neighbor_q) >= min_pts:
                    # q 是核心点 —— 把它的邻域集合与转发集合并入不断增长的种子列表
                    # （只追加尚未被归簇的点，避免重复入队）
                    combined_q = np.union1d(neighbor_q, related_q).astype(int)
                    new_seeds = [int(i) for i in combined_q if labels[i] == -1 or labels[i] == -2]
                    seeds.extend(new_seeds)

            # 若 P' 尚未属于任何簇，则加入当前簇
            # （包括此前在别处被暂标为噪声 -2 的点：噪声判定可被核心点推翻）
            if labels[q] == -1 or labels[q] == -2:
                labels[q] = cluster_id


def fit_predict(X, eps, min_pts):
    """注册表入口：转发矩阵留空，等价于标准 DBSCAN 的扩张流程。"""
    return RADBSCANOptimizer().fit_predict(X, eps, min_pts)
