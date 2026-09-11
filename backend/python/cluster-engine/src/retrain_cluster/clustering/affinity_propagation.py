"""Legacy-v1 Python kernel. Numerical behavior intentionally preserved.

仿射传播（Affinity Propagation）：在样本间反复传递"吸引度/归属度"消息，
自动选出若干样本作为簇中心，无需预先指定簇数。

注意 ``random_state=42`` 固定随机种子：AP 初始化含随机性，固定后结果可复现。
"""

import numpy as np


def fit_predict(X, damping=0.5, preference=None):
    """运行仿射传播，返回整数簇标签。"""
    if X.shape[0] == 0:
        return np.array([], dtype=np.int32)

    from sklearn.cluster import AffinityPropagation

    model = AffinityPropagation(
        damping=damping,  # 阻尼系数，越大越稳定但收敛越慢
        preference=preference,  # 偏好值：越负选出的簇中心越少；None 表示用相似度中位数
        affinity="euclidean",
        random_state=42,  # 固定种子以保证可复现
    )
    labels = model.fit_predict(X)
    return labels
