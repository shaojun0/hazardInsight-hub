"""特征融合：把"自身向量"与"检索到的近邻信息"按权重混合。

这是检索增强聚类的关键一步——让每条样本的特征不仅描述自己，也携带其语义近邻的
上下文，从而缓解短文本信息量不足的问题。
"""

import numpy as np


def fuse(original, reference, beta):
    """按 beta 做凸组合：

    ``beta=1`` 退化为纯原始向量（不启用检索增强），``beta=0`` 则完全使用近邻均值。
    要求 beta 落在 [0, 1]（由 FeatureSpec 保证），因此结果不会外推发散。
    """
    return beta * original + (1 - beta) * reference


def neighbor_means(neighbors):
    """对每个样本的 k 个近邻向量取均值。

    逐样本调用 ``np.mean`` 而非在更高维上一次求平均：这是为了保留历史实验的
    数值累加路径（浮点求和顺序会影响末位精度，进而影响聚类标签）。
    """
    return np.array([np.mean(row, axis=0) for row in neighbors])
