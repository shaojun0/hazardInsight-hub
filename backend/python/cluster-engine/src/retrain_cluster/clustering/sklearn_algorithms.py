"""直接委托给 sklearn 的三个算法。

这些实现没有任何自定义逻辑，只是统一成 ``fit_predict(X, **params)`` 的注册表约定，
并延迟导入 sklearn（避免顶层导入开销与依赖耦合）。
"""


def agglomerative(X, distance_threshold):
    """层次聚类（Ward 联结）。

    ``n_clusters=None`` + ``distance_threshold`` 表示：不指定簇数，
    而是把距离超过阈值的簇合并截断，簇数由数据自身决定。
    """
    from sklearn.cluster import AgglomerativeClustering

    return AgglomerativeClustering(n_clusters=None, distance_threshold=distance_threshold, linkage="ward").fit_predict(
        X
    )


def birch(X, threshold, branching_factor):
    """BIRCH：用聚类特征树（CF Tree）增量式压缩数据后再聚类。

    threshold 控制叶节点半径上限，branching_factor 控制每个节点的最大子节点数。
    """
    from sklearn.cluster import Birch

    return Birch(threshold=threshold, branching_factor=branching_factor, n_clusters=None).fit_predict(X)


def optics(X, min_samples, xi, min_cluster_size):
    """OPTICS：按可达距离排序后从中提取密度簇，可视为 DBSCAN 的多阈值推广。

    min_cluster_size 可为 (0,1] 的比例或 >=2 的绝对数量。
    """
    from sklearn.cluster import OPTICS

    return OPTICS(min_samples=min_samples, xi=xi, min_cluster_size=min_cluster_size).fit_predict(X)
