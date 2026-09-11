"""特征流水线：把原始向量转成真正送入聚类算法的矩阵。

按 FeatureSpec 决定是否启用两条可选路径：
  1. 检索增强（n_results > 0）：查 k 近邻 -> 取均值 -> 与自身向量按 beta 融合；
  2. 降维（pca_dim > 0）：PCA/UMAP 降到目标维度。

另有 RADBSCAN 的特殊历史路径：它在融合之后**再降一次维**（见文件末尾）。
"""

import numpy as np
from .fusion import fuse, neighbor_means
from .reduction import DimReducer
from ..data.validation import validate_matrix
from ..errors import ClusterError


class FeaturePipeline:
    def __init__(self, retriever=None, query_batch=64):
        self.retriever = retriever
        self.query_batch = query_batch  # 分批查近邻，控制单次请求/内存占用

    def transform(self, X, spec):
        X = validate_matrix(X)
        # 只有需要降维时才实例化 reducer（否则省去一次对象构造）
        reducer = DimReducer(spec.reduction) if spec.pca_dim > 0 else None
        # PCA 的主成分数不能超过 min(样本数, 特征数)，提前报错比底层报错更清楚
        if spec.pca_dim > min(X.shape):
            raise ClusterError("INVALID_REDUCTION", "PCA dimension exceeds batch rank limit", 422)
        if spec.n_results:
            if self.retriever is None:
                raise ClusterError("KNOWLEDGE_BASE_UNAVAILABLE", "Retrieval requires a knowledge base", 503)
            means = []
            # 分批检索，累积每批的近邻均值；分批是为控制单次查询规模
            for start in range(0, len(X), self.query_batch):
                rows = X[start : start + self.query_batch]
                neighbors = self.retriever.query(rows, spec.n_results)
                # 知识库必须对每条样本都返回恰好 k 个近邻，否则结果不可信
                if len(neighbors.values) != len(rows) or any(len(v) != spec.n_results for v in neighbors.values):
                    raise ClusterError("INVALID_NEIGHBORS", "Knowledge base returned incomplete neighbors", 503)
                means.extend(neighbor_means(neighbors.values))
            R = validate_matrix(np.array(means), rows=len(X), dimension=X.shape[1])
            if reducer:
                # 自身向量与近邻均值各降维一次，在低维空间融合（与历史实验口径一致）
                result = fuse(reducer.fit_transform(X, spec.pca_dim), reducer.fit_transform(R, spec.pca_dim), spec.beta)
            else:
                result = fuse(X, R, spec.beta)
        else:
            result = X
            if reducer:
                result = reducer.fit_transform(result, spec.pca_dim)
        # 历史 RADBSCAN 仅在融合之后再做一次额外降维（保留此边界行为以复现历史结果）
        if spec.version == "legacy-radbscan-v1" and reducer and spec.n_results:
            result = reducer.fit_transform(result, spec.pca_dim)
        return validate_matrix(result, rows=len(X))
