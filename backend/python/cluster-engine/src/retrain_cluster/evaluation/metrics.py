"""聚类质量评估。

历史实验的评估口径在这里完整保留：先算一组标准外部指标，再按固定权重合成一个
总评分 score 供 Optuna 最大化。**权重与指标组合不可改动**，否则调参结果与论文图表
将无法对应。
"""

from typing import Dict

import numpy as np
from sklearn.metrics import (
    adjusted_rand_score,
    normalized_mutual_info_score,
    v_measure_score,
    fowlkes_mallows_score,
    adjusted_mutual_info_score,
    homogeneity_score,
    completeness_score,
)


class QbEvaluator:
    """把预测标签与真实标签对比，产出一组指标与总评分。"""

    def __init__(self, min_noise_ratio: float = 0.1, target_cluster_ratio: tuple[float, float] = None):
        self.min_noise_ratio = min_noise_ratio  # 保留字段：历史阈值，当前评分逻辑不直接使用
        if target_cluster_ratio is None:
            self.target_cluster_ratio = (0.5, 1.5)

    def __call__(self, *args, **kwargs):
        """允许像函数一样直接调用，便于作为回调传入。"""
        return self.evaluate_clustering(*args, **kwargs)

    def evaluate_clustering(self, true_labels: np.ndarray, pred_labels: np.ndarray) -> Dict[str, float]:
        """计算各项指标。

        关键口径：外部指标只在**非噪声样本**上计算（噪声不属于任何簇，计入会歪曲指标），
        但噪声比例本身作为惩罚项进入总评分。
        """
        true_labels = np.asarray(true_labels)
        pred_labels = np.asarray(pred_labels)
        n_clusters = len(set(pred_labels) - {-1})  # 去掉噪声后的簇数
        n_true_clusters = len(np.unique(true_labels))
        n_noise = (pred_labels == -1).sum()
        noise_ratio = n_noise / len(pred_labels)

        results = {
            "n_clusters": n_clusters,
            "n_noise": float(n_noise),
            "noise_ratio": float(noise_ratio),
        }

        # 簇数不足 2 时无法计算任何成对指标，返回哨兵值 -1 表示"无效解"
        if n_clusters < 2:
            results["score"] = -1.0
            return results

        # 只保留被分配到簇的样本参与指标计算
        mask = pred_labels != -1
        true_masked = true_labels[mask]
        pred_masked = pred_labels[mask]

        ari = adjusted_rand_score(true_masked, pred_masked)
        nmi = normalized_mutual_info_score(true_masked, pred_masked)
        vm = v_measure_score(true_masked, pred_masked)
        fms = fowlkes_mallows_score(true_masked, pred_masked)
        ami = adjusted_mutual_info_score(true_masked, pred_masked)
        hs = homogeneity_score(true_masked, pred_masked)
        cs = completeness_score(true_masked, pred_masked)

        results["ari"] = ari
        results["nmi"] = nmi
        results["vm"] = vm
        results["fms"] = fms
        results["ami"] = ami
        results["hs"] = hs
        results["cs"] = cs
        # 簇数接近度：以 1 为最优，簇数与真实簇数相差越远得分越低
        n_clusters_score = (
            n_clusters / n_true_clusters if n_true_clusters > n_clusters else n_true_clusters / n_clusters
        )
        # 固定权重合成（历史口径，不可改动）：
        # 0.4*ARI + 0.3*NMI + 0.1*V-measure + 0.1*簇数接近度 + 0.1*(1-噪声比例)
        score = 0.4 * ari + 0.3 * nmi + 0.1 * vm + 0.1 * n_clusters_score + (1 - noise_ratio) * 0.1
        results["score"] = score
        return results
