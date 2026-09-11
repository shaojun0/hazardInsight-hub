"""降维封装（PCA / UMAP）。

带一层以 "数据内容哈希 + 目标维度" 为键的缓存：同一次实验中同一批数据往往会被
反复降维（例如 Optuna 每个 trial 都跑一次），缓存可避免重复拟合。
"""

from ..artifacts.fingerprints import array_hash


class DimReducer:
    def __init__(self, algorithm="PCA"):
        """按名称解析降维实现（延迟导入，避免在顶层拖入 umap 这类重量级依赖）。"""
        if algorithm == "PCA":
            from sklearn.decomposition import PCA

            self.model = PCA
        elif algorithm == "UMAP":
            from umap import UMAP

            self.model = UMAP
        else:
            raise ValueError("Unknown reduction algorithm")
        self.cache = {}

    def fit_transform(self, X, dimension):
        """降维到 dimension 维；命中缓存则直接复用上次结果。"""
        key = (array_hash(X), dimension)
        if key not in self.cache:
            self.cache[key] = self.model(n_components=dimension).fit_transform(X)
        return self.cache[key]
