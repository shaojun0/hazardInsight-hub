"""聚类服务：把编码、检索、特征、算法串成一次完整执行。

这是整个系统的编排层，也是唯一会同时接触"外部资源（模型/知识库）"和"算法"的地方。
它同时负责生成可复现所需的全部指纹与环境快照。
"""

from dataclasses import asdict
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
import time
import uuid
import numpy as np
from ..config import Catalog, model_fingerprint
from ..types import EmbeddingBatch
from ..artifacts.cache import EmbeddingCache
from ..artifacts.fingerprints import fingerprint, file_hash, array_hash
from ..artifacts.runs import RunStore
from ..clustering.registry import validate_params, WARNINGS
from ..embeddings.registry import EncoderRegistry
from ..retrieval.chroma import ChromaRetriever
from ..features.pipeline import FeaturePipeline
from ..data.validation import validate_items, validate_matrix
from ..errors import ClusterError
from ..logging import event


def environment_versions():
    """收集关键依赖的版本号，写进产物清单。

    某些包可能没装（属可选依赖），因此逐个 try 并跳过缺失项，
    而不是让整个流程因一个可选包缺失而失败。
    """
    result = {}
    for name in [
        "numpy",
        "scikit-learn",
        "optuna",
        "chromadb",
        "hdbscan",
        "chinese-whispers",
        "openai",
        "torch",
        "transformers",
    ]:
        try:
            result[name] = version(name)
        except PackageNotFoundError:
            pass
    return result


def source_fingerprint():
    """对包内全部 .py 文件取指纹，用于记录"本次运行用的是哪一版代码"。

    路径取相对于包根的相对路径，因此换机器/换目录不会改变指纹。
    """
    root = Path(__file__).resolve().parents[1]
    return fingerprint({str(p.relative_to(root)): file_hash(p) for p in sorted(root.rglob("*.py"))})


class ClusteringService:
    def __init__(self, settings, *, encoders=None, retriever_factory=None):
        self.settings = settings
        self.catalog = Catalog(settings)
        # 编码器与检索器都支持注入替身，便于测试时避免真实模型调用
        self.encoders = encoders or EncoderRegistry()
        self.retriever_factory = retriever_factory or ChromaRetriever
        self.cache = EmbeddingCache(settings.artifacts_dir / "embeddings")
        self.runs = RunStore(settings.artifacts_dir / "runs")
        self.retrievers = {}

    def embeddings(self, texts, model_id):
        """取（或计算）文本向量，返回 (向量矩阵, 模型指纹, 是否命中缓存)。"""
        spec = self.catalog.model(model_id)
        model_hash = model_fingerprint(spec)
        key = self.cache.key(texts, model_hash)
        values = self.cache.load(key, rows=len(texts), dimension=spec["dimension"])
        hit = values is not None
        if not hit:
            # 缓存未命中：调用编码器，并严格校验行数与维度
            values = self.encoders.get(spec, model_hash).encode(texts)
            values = validate_matrix(values, rows=len(texts), dimension=spec["dimension"])
            self.cache.save(key, values)
        return values, model_hash, hit

    def retriever(self, profile, model_hash):
        """按 (知识库, 模型) 缓存检索器；不启用检索时返回 None。"""
        if not profile.features.n_results:
            return None
        key = (profile.knowledge_base_id, model_hash)
        if key not in self.retrievers:
            spec = self.catalog.model(profile.model_id)
            self.retrievers[key] = self.retriever_factory(
                self.settings.artifacts_dir / "knowledge_bases",
                profile.knowledge_base_id,
                model_hash,
                spec["dimension"],
            )
        return self.retrievers[key]

    def cluster(self, request, *, enforce_api_limits=False):
        """执行一次聚类，返回结果并落盘产物。

        enforce_api_limits=True 时（API 场景）会额外受设置里的 max_samples 限制，
        因为对外服务必须防止超大批次，而 CLI/实验场景则可放宽。
        """
        started = time.monotonic()
        profile = self.catalog.profile(request["profile_id"])
        limit = min(self.settings.max_samples, profile.max_samples) if enforce_api_limits else None
        items = request["items"]
        validate_items(items, maximum=limit)
        # 参数校验会返回可调用的算法函数，顺带复用它，避免重复解析
        clusterer = validate_params(profile.algorithm, profile.algorithm_params, profile.backend)
        # hdbscan/optics 需要足够的样本才能形成邻域，样本数不足时提前报错更清晰
        if profile.algorithm in {"hdbscan", "optics"}:
            minimum = profile.algorithm_params.get("min_samples", profile.algorithm_params.get("min_cluster_size", 2))
            if minimum > len(items):
                raise ClusterError(
                    "INVALID_SAMPLE_COUNT", "Batch is smaller than the algorithm neighborhood minimum", 422
                )
        spec = self.catalog.model(profile.model_id)
        model_hash = model_fingerprint(spec)
        # 先校验索引，再发起可能计费的嵌入请求——避免"钱花了才发现知识库不可用"
        retriever = self.retriever(profile, model_hash)
        texts = [item["text"] for item in items]
        values, model_hash, hit = self.embeddings(texts, profile.model_id)
        batch = EmbeddingBatch([item["id"] for item in items], values, model_hash)
        transformed = FeaturePipeline(retriever, self.settings.query_batch).transform(batch.values, profile.features)
        pred = np.asarray(clusterer(transformed, **profile.algorithm_params))
        # 标签必须是长度正确的一维整数数组，否则结果不可信（宁可报错也不返回错数据）
        if pred.shape != (len(items),) or pred.dtype.kind not in "iu":
            raise ClusterError("INVALID_CLUSTER_OUTPUT", "Algorithm returned invalid labels", 500)
        # 组装随结果返回的行为告警，供调用方知情
        warnings = list(WARNINGS.get(profile.algorithm, []))
        if not spec.get("revision") or spec.get("revision") == "unversioned":
            warnings.append("REMOTE_MODEL_REVISION_UNPINNED")
        if profile.source_result:
            warnings.append("HISTORICAL_EMBEDDINGS_NOT_VERIFIED")
        if profile.features.pca_dim:
            warnings.append("LEGACY_SEPARATE_REDUCTION")
        result = {
            "run_id": "run_" + uuid.uuid4().hex,
            "profile_id": profile.profile_id,
            "algorithm": profile.algorithm,
            "implementation_version": profile.implementation_version,
            "n_samples": len(items),
            "n_clusters": len(set(pred) - {-1}),
            "n_noise": int((pred == -1).sum()),
            "assignments": [{"id": ident, "cluster_id": int(label)} for ident, label in zip(batch.sample_ids, pred)],
            "warnings": warnings,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
        # 清单记录"结果是怎么算出来的"：配置、模型、各阶段输入的指纹、环境版本等
        manifest = {
            "schema_version": 1,
            "run_id": result["run_id"],
            "config": asdict(profile),
            "profile_fingerprint": profile.fingerprint,
            "model": spec,
            "model_fingerprint": model_hash,
            "input_fingerprint": fingerprint(items),
            "embedding_fingerprint": array_hash(values),
            "feature_fingerprint": array_hash(transformed),
            "cache_hit": hit,
            "backend": profile.backend,
            "knowledge_base": getattr(retriever, "manifest", None),
            "source_fingerprint": source_fingerprint(),
            "environment": environment_versions(),
            "baseline_kind": "current-environment",
            "seed": None,
        }
        self.runs.save(result, manifest)
        event(
            "completed",
            run_id=result["run_id"],
            algorithm=profile.algorithm,
            n_samples=len(items),
            elapsed_ms=result["elapsed_ms"],
            cache_hit=hit,
        )
        return result
