"""Optuna 超参搜索的执行器。

一个 trial 的完整流程：采样超参 -> 解析出 FeatureSpec -> 特征变换 -> 聚类 -> 评估打分。
搜索目标固定为最大化评估器的 ``score``（见 evaluation/metrics.py）。
"""

from dataclasses import asdict
from ..types import FeatureSpec
from ..features.pipeline import FeaturePipeline
from ..clustering.registry import get_clusterer
from ..evaluation.metrics import QbEvaluator
from .search_spaces import SPACES

# 属于"特征口径"而非"算法参数"的字段，需要从算法参数中剔除后分别保存
FEATURE_KEYS = {"beta", "pca_dim", "n_results"}


def resolve_features(algorithm, params, reduction="PCA"):
    """从采样结果中抽出特征口径，构造 FeatureSpec。

    RADBSCAN 强制使用 legacy-radbscan-v1（多一次融合后降维），其余算法用 legacy-v1。
    """
    return FeatureSpec(
        beta=params.get("beta", 1.0),
        n_results=params.get("n_results", 0),
        pca_dim=params.get("pca_dim", 0),
        reduction=reduction,
        version="legacy-radbscan-v1" if algorithm == "radbscan" else "legacy-v1",
    )


def optimize(
    algorithm,
    X,
    y,
    retriever=None,
    *,
    n_results=-1,
    pca_dim=0,
    reduction="PCA",
    n_trials=200,
    n_jobs=8,
    seed=42,
    startup_trials=15,
):
    """跑一次超参搜索，返回 Optuna study。

    n_results / pca_dim 为 -1 或负值表示"交给搜索决定"，非负值表示"固定为该值"。
    """
    import optuna

    evaluator = QbEvaluator()
    clusterer = get_clusterer(algorithm)

    def objective(trial):
        # 1) 采样超参（search_spaces 内部会根据固定值跳过相应维度的采样）
        params = SPACES[algorithm](trial, n_results=n_results, pca_dim=pca_dim)
        features = resolve_features(algorithm, params, reduction)
        # 2) 拆分：算法参数 vs 特征字段，二者用途不同
        algorithm_params = {k: v for k, v in params.items() if k not in FEATURE_KEYS}
        # 把解析后的完整配置记进 trial，便于事后精确复现最佳配置
        trial.set_user_attr("resolved_params", {**algorithm_params, **asdict(features)})
        transformed = FeaturePipeline(retriever).transform(X, features)
        metrics = evaluator(y, clusterer(transformed, **algorithm_params))
        # 把所有指标都记入 trial，方便后续导出分析
        for name, value in metrics.items():
            trial.set_user_attr(name, value)
        return metrics["score"]

    study = optuna.create_study(
        direction="maximize",
        sampler=optuna.samplers.TPESampler(n_startup_trials=startup_trials, seed=seed, multivariate=True),
    )
    study.optimize(objective, n_trials=n_trials, n_jobs=n_jobs)
    return study
