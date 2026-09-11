"""HDBSCAN：对 DBSCAN 的层次化改进，能在不同密度区域自适应地发现簇。

通过构建最小生成树并在其上做簇稳定性筛选（cluster_selection_epsilon 控制合并粒度），
不需要单一全局 eps。
"""


def fit_predict(X, alpha, cluster_selection_epsilon, min_cluster_size):
    """运行 HDBSCAN，返回整数簇标签。"""
    import hdbscan

    return hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,  # 簇的最小规模
        cluster_selection_epsilon=cluster_selection_epsilon,  # 簇合并的距离容差
        alpha=alpha,  # 距离尺度敏感度
        gen_min_span_tree=True,  # 生成最小生成树（供稳定性评估使用）
        core_dist_n_jobs=-1,  # 核心距离并行计算
    ).fit_predict(X)
