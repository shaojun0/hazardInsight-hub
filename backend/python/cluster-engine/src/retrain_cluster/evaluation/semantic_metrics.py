"""semantic-v1 的在线诊断与离线评价指标。

两条线严格分开（实施计划 7.4）：

* **在线**（``online_diagnostics``）：只做能在预算内完成、且不需要真实标签的检查。
  标准 silhouette 只在固定抽样上、且只在标签数满足 ``2 ≤ K ≤ n-1`` 时计算；
  噪声 ``-1`` 不作为"一个普通主题"参与。
* **离线**（``offline_report``）：需要真实标签，用于 benchmark 与验收。
  ARI/NMI/AMI、B-cubed F1、配对 Precision/Recall/F1、噪声 P/R、稀有主题召回。

历史 ``evaluation/metrics.py`` 的 ``QbEvaluator`` 与黄金分数**完全不动**：
它依赖真实标签、权重口径也固定，混进在线流程会直接把"有监督指标"
伪装成"无监督质量分"。
"""

from __future__ import annotations

from collections import Counter
import math

import numpy as np

#: 噪声标签约定，与 clustering 各层保持一致。
NOISE_LABEL = -1

#: 判为"稀有主题"的真实簇大小上限。
RARE_TOPIC_MAX_SIZE = 5


def _contingency(predicted: np.ndarray, truth: np.ndarray) -> Counter:
    """``{(cluster, label): count}`` 的稀疏列联表。"""

    table: Counter = Counter()
    for cluster, label in zip(predicted.tolist(), truth.tolist()):
        table[(int(cluster), int(label))] += 1
    return table


def _comb2(value: int) -> int:
    """``C(n, 2)``：成对计数，避免枚举全量 N² 对。"""

    return value * (value - 1) // 2


def pairwise_scores(predicted, truth) -> dict:
    """配对 Precision / Recall / F1（用列联计数计算，不做 O(N²) 枚举）。"""

    table = _contingency(np.asarray(predicted), np.asarray(truth))
    predicted_counts: Counter = Counter()
    truth_counts: Counter = Counter()
    for (cluster, label), count in table.items():
        predicted_counts[cluster] += count
        truth_counts[label] += count
    same_predicted = sum(_comb2(count) for count in predicted_counts.values())
    same_truth = sum(_comb2(count) for count in truth_counts.values())
    true_positive = sum(_comb2(count) for count in table.values())

    def _ratio(numerator, denominator):
        return None if denominator == 0 else round(numerator / denominator, 6)

    precision = _ratio(true_positive, same_predicted)
    recall = _ratio(true_positive, same_truth)
    f1 = None
    if precision is not None and recall is not None and (precision + recall) > 0:
        f1 = round(2 * precision * recall / (precision + recall), 6)
    return {"pairwise_precision": precision, "pairwise_recall": recall, "pairwise_f1": f1}


def b_cubed_scores(predicted, truth) -> dict:
    """B-cubed Precision / Recall / F1。

    口径说明：把 ``-1`` 当作一个普通标签参与计算；"拒绝语义"下另有一份
    ``assigned_only`` 版本，只在已归簇样本上评估。两者同时报告，
    避免用"大量拒绝"换取高纯度却被当成质量提升。
    """

    predicted = np.asarray(predicted)
    truth = np.asarray(truth)
    table = _contingency(predicted, truth)
    predicted_counts: Counter = Counter()
    truth_counts: Counter = Counter()
    for (cluster, label), count in table.items():
        predicted_counts[cluster] += count
        truth_counts[label] += count
    total = int(predicted.shape[0])
    if total == 0:
        return {"b_cubed_precision": None, "b_cubed_recall": None, "b_cubed_f1": None, "assigned_only": {}}
    precision_numerator = sum(count * (count / predicted_counts[cluster]) for (cluster, _label), count in table.items())
    recall_numerator = sum(count * (count / truth_counts[label]) for (_cluster, label), count in table.items())
    precision = precision_numerator / total
    recall = recall_numerator / total
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)

    mask = predicted != NOISE_LABEL
    assigned = {}
    if mask.any():
        if mask.all():
            # 全部已归簇：``assigned_only`` 与整体是同一个集合，直接取本次结果。
            # 这里**不能**再递归调用自己——mask 全 True 时子调用的输入与本次完全相同，
            # 会一路递归到爆栈（基线阈值下 967 条零噪声时真实踩到过）。
            assigned = {
                "b_cubed_precision": round(precision, 6),
                "b_cubed_recall": round(recall, 6),
                "b_cubed_f1": round(f1, 6),
            }
        else:
            assigned = b_cubed_scores(predicted[mask], truth[mask])
            assigned.pop("assigned_only", None)
    return {
        "b_cubed_precision": round(precision, 6),
        "b_cubed_recall": round(recall, 6),
        "b_cubed_f1": round(f1, 6),
        "assigned_only": assigned,
    }


def noise_scores(predicted, truth, *, truth_noise=NOISE_LABEL) -> dict:
    """把噪声当作正类，计算 Precision / Recall。"""

    predicted = np.asarray(predicted)
    truth = np.asarray(truth)
    predicted_positive = predicted == NOISE_LABEL
    truth_positive = truth == truth_noise
    tp = int((predicted_positive & truth_positive).sum())
    fp = int((predicted_positive & ~truth_positive).sum())
    fn = int((~predicted_positive & truth_positive).sum())
    precision = None if (tp + fp) == 0 else round(tp / (tp + fp), 6)
    recall = None if (tp + fn) == 0 else round(tp / (tp + fn), 6)
    return {"noise_precision": precision, "noise_recall": recall, "noise_support": int(truth_positive.sum())}


def rare_topic_recall(predicted, truth, *, max_size: int = RARE_TOPIC_MAX_SIZE) -> dict:
    """稀有主题召回：小真实主题里有多少条被收进任意有效簇（而不是判噪声）。"""

    predicted = np.asarray(predicted)
    truth = np.asarray(truth)
    counts = Counter(truth.tolist())
    rare_labels = {label for label, count in counts.items() if 0 < count <= max_size and label != NOISE_LABEL}
    if not rare_labels:
        return {"rare_topic_recall": None, "rare_topic_count": 0, "rare_topic_size": 0}
    mask = np.array([int(label) in rare_labels for label in truth.tolist()])
    accepted = int((predicted[mask] != NOISE_LABEL).sum())
    return {
        "rare_topic_recall": round(accepted / max(1, int(mask.sum())), 6),
        "rare_topic_count": len(rare_labels),
        "rare_topic_size": int(mask.sum()),
    }


def sampled_silhouette(matrix, labels, *, sample_size: int = 2000, seed: int = 42) -> float | None:
    """在固定抽样上分块计算 silhouette。

    标准 silhouette 在标签数不满足 ``2 ≤ K ≤ n-1`` 时**未定义**，
    此时返回 None 而不是硬算一个数字出来。噪声不参与。
    """

    matrix = np.ascontiguousarray(np.asarray(matrix, dtype=np.float32))
    labels = np.asarray(labels)
    mask = labels != NOISE_LABEL
    if mask.sum() < 3:
        return None
    selected = np.nonzero(mask)[0]
    if selected.shape[0] > sample_size:
        digest = np.argsort([hash((seed, int(index))) for index in selected.tolist()])
        selected = selected[digest[:sample_size]]
    sub_labels = labels[selected]
    distinct = np.unique(sub_labels)
    if distinct.shape[0] < 2 or distinct.shape[0] >= sub_labels.shape[0]:
        return None
    from sklearn.metrics import silhouette_score

    return round(float(silhouette_score(matrix[selected], sub_labels, metric="cosine")), 6)


def online_diagnostics(
    matrix,
    labels,
    *,
    sample=None,
    sample_size: int = 2000,
    seed: int = 42,
    noise_ratio: float | None = None,
) -> dict:
    """在线诊断：只产出无监督、预算可控的数字。

    刻意**不**把任何一项包装成"质量分"——质量分由 ``semantic_digest`` 的
    可解释分量给出，这里只做事实陈述。
    """

    labels = np.asarray(labels)
    live = sorted({int(label) for label in labels if int(label) != NOISE_LABEL})
    sizes = Counter(labels.tolist())
    diagnostics = {
        "cluster_count": len(live),
        "cluster_sizes": {str(label): int(sizes.get(label, 0)) for label in live},
        "noise_count": int((labels == NOISE_LABEL).sum()),
        "noise_ratio": round(
            float((labels == NOISE_LABEL).mean()) if labels.size else 0.0, 6
        )
        if noise_ratio is None
        else round(float(noise_ratio), 6),
        "silhouette_sample": None,
        "silhouette_undefined_reason": None,
    }
    if len(live) < 2:
        diagnostics["silhouette_undefined_reason"] = "single_cluster_or_all_noise"
        return diagnostics
    if matrix is None:
        diagnostics["silhouette_undefined_reason"] = "no_matrix"
        return diagnostics
    value = sampled_silhouette(matrix, labels, sample_size=sample_size, seed=seed)
    if value is None:
        diagnostics["silhouette_undefined_reason"] = "labels_do_not_satisfy_2_le_k_le_n_minus_1"
        return diagnostics
    diagnostics["silhouette_sample"] = value
    return diagnostics


def offline_report(predicted, truth, *, matrix=None, sample_size: int = 2000, seed: int = 42) -> dict:
    """离线完整报告：需要真实标签，只在 benchmark / 验收里调用。"""

    predicted = np.asarray(predicted)
    truth = np.asarray(truth)
    if predicted.shape != truth.shape:
        raise ValueError("Predicted and truth label arrays must have the same shape")
    from sklearn.metrics import adjusted_mutual_info_score, adjusted_rand_score, normalized_mutual_info_score

    report = {
        "n_samples": int(predicted.shape[0]),
        "ari": round(float(adjusted_rand_score(truth, predicted)), 6),
        "nmi": round(float(normalized_mutual_info_score(truth, predicted)), 6),
        "ami": round(float(adjusted_mutual_info_score(truth, predicted)), 6),
    }
    report.update(pairwise_scores(predicted, truth))
    report.update(b_cubed_scores(predicted, truth))
    report.update(noise_scores(predicted, truth))
    report.update(rare_topic_recall(predicted, truth))
    report["silhouette_sample"] = (
        None if matrix is None else sampled_silhouette(matrix, predicted, sample_size=sample_size, seed=seed)
    )
    return report


def macro_quality(cluster_scores) -> float | None:
    """簇质量宏平均；没有任何可评分簇时返回 None（不是 0）。"""

    values = [float(value) for value in cluster_scores if value is not None and math.isfinite(float(value))]
    return None if not values else round(float(np.mean(values)), 6)


__all__ = [
    "NOISE_LABEL",
    "RARE_TOPIC_MAX_SIZE",
    "b_cubed_scores",
    "macro_quality",
    "noise_scores",
    "offline_report",
    "online_diagnostics",
    "pairwise_scores",
    "rare_topic_recall",
    "sampled_silhouette",
]
