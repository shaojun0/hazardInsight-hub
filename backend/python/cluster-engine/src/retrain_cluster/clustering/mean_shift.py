"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

Mean Shift：把每个点沿密度梯度方向反复漂移到局部密度峰值，最终收敛到同一峰值的点归为一簇。
簇数由带宽（bandwidth）隐式决定，无需预先指定。

该算法只在 CLI/实验路径暴露，不通过 API 提供（见 registry.API_ALGORITHMS）。
"""

import numpy as np


def fit_predict(X, bandwidth=None, cluster_all=True, max_iter=300):
    """运行 Mean Shift，返回整数簇标签。"""
    if X.shape[0] == 0:
        return np.array([], dtype=np.int32)

    from sklearn.cluster import MeanShift

    model = MeanShift(
        bandwidth=bandwidth,  # 核带宽；None 时由 sklearn 估计
        cluster_all=cluster_all,  # True 表示把离群点也分配到最近簇，不产生噪声标签
        max_iter=max_iter,  # 单点漂移的最大迭代次数
        bin_seeding=True,  # 先对点做粗分箱再取种子，可显著加速
        n_jobs=-1,
    )
    labels = model.fit_predict(X)
    return labels
