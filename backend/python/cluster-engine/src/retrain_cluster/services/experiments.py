"""实验服务：跑一次完整的"调参 + 留出集评估"实验并导出产物。

与 ClusteringService 的区别：这里在**训练集**上搜索超参，再把最优配置应用回
**测试集**做最终评估。产物目录含 5 个文件：manifest / profile（可直接复用的配置档）
/ best（最优 trial）/ trials（全部 trial）/ test（测试集指标与预测）。
"""

from dataclasses import asdict, replace
import time
import uuid
from ..types import FeatureSpec
from ..data.loaders import load_reference, load_labels
from ..optimization.runner import optimize, FEATURE_KEYS
from ..features.pipeline import FeaturePipeline
from ..clustering.registry import get_clusterer
from ..evaluation.metrics import QbEvaluator
from ..artifacts.runs import atomic_json
from ..artifacts.fingerprints import array_hash
from .clustering import ClusteringService, environment_versions, source_fingerprint


class ExperimentService:
    def __init__(self, settings):
        self.settings = settings
        # 复用 ClusteringService 的编码/检索/缓存能力
        self.pipeline = ClusteringService(settings)

    def run(self, profile_id, *, n_results=-1, pca_dim=0, n_trials=None, n_jobs=None, seed=None):
        started = time.monotonic()
        # 命令行/调用方传入的参数覆盖配置文件默认值；为 None 表示沿用配置
        config = dict(self.settings.experiment)
        for name, value in [("n_trials", n_trials), ("n_jobs", n_jobs), ("seed", seed)]:
            if value is not None:
                config[name] = value
        profile = self.pipeline.catalog.profile(profile_id)
        train, test = load_reference(config["reference"]), load_labels(config["test"])
        X, model_hash, _ = self.pipeline.embeddings(train.texts, profile.model_id)
        testX, _, _ = self.pipeline.embeddings(test.texts, profile.model_id)
        # 调参阶段必须启用检索（n_results >= 1），否则无法搜索 beta；-1 在此解释为"取 1"
        retrieval_profile = replace(
            profile, features=replace(profile.features, n_results=max(0, n_results) if n_results != -1 else 1)
        )
        retriever = self.pipeline.retriever(retrieval_profile, model_hash)
        run_id = "run_" + uuid.uuid4().hex
        out = self.settings.artifacts_dir / "runs" / run_id
        out.mkdir(parents=True, exist_ok=False)
        # 先写 running 状态的清单，实验中途失败时也能看出"跑过但没成"
        manifest = {
            "schema_version": 1,
            "run_id": run_id,
            "status": "running",
            "kind": "experiment",
            "baseline_kind": "current-environment",
            "config": config,
            "profile": asdict(profile),
            "train_source": train.source_fingerprint,
            "test_source": test.source_fingerprint,
            "embedding_fingerprints": {"train": array_hash(X), "test": array_hash(testX)},
            "model_fingerprint": model_hash,
            "environment": environment_versions(),
            "source_fingerprint": source_fingerprint(),
            "search": {"n_results": n_results, "pca_dim": pca_dim},
        }
        atomic_json(out / "manifest.json", manifest)
        try:
            study = optimize(
                profile.algorithm,
                X,
                train.labels,
                retriever,
                n_results=n_results,
                pca_dim=pca_dim,
                reduction=profile.features.reduction,
                **{name: config[name] for name in ["n_trials", "n_jobs", "seed", "startup_trials"]},
            )
            # 最优 trial 里保存的是"解析后的完整配置"，这里拆回特征口径与算法参数两部分
            resolved = dict(study.best_trial.user_attrs["resolved_params"])
            feature_fields = FEATURE_KEYS | {"reduction", "version"}
            features = FeatureSpec(**{k: v for k, v in resolved.items() if k in feature_fields})
            params = {k: v for k, v in resolved.items() if k not in feature_fields}
            # 用最优配置在留出测试集上复算一次，得到最终评估结果
            transformed = FeaturePipeline(retriever).transform(testX, features)
            pred = get_clusterer(profile.algorithm)(transformed, **params)
            metrics = QbEvaluator()(test.labels, pred)
            # 导出一个"可直接用于线上聚类"的配置档
            exported = replace(
                profile,
                profile_id=f"{profile.algorithm}-{run_id}",
                features=features,
                algorithm_params=params,
                source_result=None,
                source_sha256=None,
            )
            atomic_json(out / "profile.json", asdict(exported))
            atomic_json(
                out / "best.json",
                {
                    "sampled_params": study.best_params,  # 采样器给出的原始值
                    "resolved_params": resolved,  # 解析后的完整配置（含固定的 n_results/pca_dim）
                    "metrics": study.best_trial.user_attrs,
                },
            )
            atomic_json(
                out / "trials.json",
                [
                    {
                        "number": t.number,
                        "state": t.state.name,
                        "value": t.value,
                        "params": t.params,
                        "attributes": t.user_attrs,
                    }
                    for t in study.trials
                ],
            )
            atomic_json(out / "test.json", {"metrics": metrics, "sample_ids": test.sample_ids, "labels": pred})
            manifest.update(status="completed", elapsed_seconds=time.monotonic() - started)
        except Exception:
            # 失败也要把状态写回清单，避免留下永远处于 running 的"僵尸产物"
            manifest.update(status="failed")
            atomic_json(out / "manifest.json", manifest)
            raise
        atomic_json(out / "manifest.json", manifest)
        return {"run_id": run_id, "directory": str(out), "test_metrics": metrics}
