"""SemanticAutoKMeansStrategy：semantic-v1 的编排层。

一次 ``run()`` 把整条链走完（对应实施计划第 4 节的 Pipeline）：

```
准入与请求指纹 → 规范化/无效识别 → 精确去重 →
文本级 Embedding Cache（只编码未命中）→ L2 + 确定性 PCA →
有界 Auto-K → 全量 MBK → 后处理（拆分/成员判定/小簇/合并/编号）→
代表/关键词/命名/质量分 → 展开回全部原始 ID → 抽样二维展示 → 原子落盘
```

三条必须守住的约束：

* **只编码未命中项**：10 万条里新增 1 万条时，只对这 1 万条推理；
* **结构退化不加载模型**：单条唯一文本 / 全重复不需要向量，也不需要模型；
* **模型不可用时可以 cache-only**：请求向量全部命中且校验通过时允许完成，
  但只要有一条 miss 就返回 ``MODEL_UNAVAILABLE``——不拼接替代模型，
  不回退到 TF-IDF 假装正常完成。
"""

from __future__ import annotations

from dataclasses import asdict
import time
import uuid

import numpy as np

from ..artifacts.fingerprints import fingerprint
from ..artifacts.runs import RunStore
from ..artifacts.text_cache import TextEmbeddingCache, build_key
from ..clustering.auto_k import run_auto_k
from ..clustering.registry import WARNINGS
from ..config import model_fingerprint
from ..data.normalization import NORMALIZATION_VERSION, build_corpus, expand_labels
from ..errors import ClusterError
from ..evaluation.semantic_metrics import online_diagnostics
from ..features.semantic import (
    DEFAULT_PCA_DIM,
    DEFAULT_PCA_MIN_SAMPLES,
    SemanticSpace,
    build_semantic_space,
    project_2d,
)
from ..logging import event
from .semantic_digest import (
    CONFIDENCE_VERSION,
    NAMING_VERSION,
    QUALITY_VERSION,
    TOKENIZER_VERSION,
    build_semantic_digest,
)
from .strategies import SEMANTIC_VERSION, StrategyMeta

#: 二维展示点上限（服务端抽样，不让浏览器画 10 万个点）。
MAX_VISUALIZATION_POINTS = 2000

#: 坏向量判定的双阈值：超过任一即认为是大范围异常，直接失败而不是假装全噪声。
BAD_VECTOR_RATIO_LIMIT = 0.05
BAD_VECTOR_ABSOLUTE_LIMIT = 20

#: 降维默认参数（可在 profile.algorithm_params 覆盖）。
FALLBACK_PCA_DIM = DEFAULT_PCA_DIM
FALLBACK_PCA_MIN_SAMPLES = DEFAULT_PCA_MIN_SAMPLES

#: 判定 OOM 的关键词。跨 torch / 后端实现都可能出现，只做保守匹配。
_OOM_HINTS = ("out of memory", "outofmemory", "cuda error", "memoryerror")


def semantic_model_fingerprint(spec) -> str:
    """语义模型指纹：模型文件、tokenizer、pooling、prompt、max_length、归一化、输出维度。

    与 legacy ``model_fingerprint`` 语义一致，只是换了 schema 前缀——
    这样"换模型/换 tokenizer/换截断长度/换输出维度"必定让文本级缓存失效，
    而凭据（``api_key_env``）永远不参与。

    输出维度必须进指纹：维度变了却复用旧向量，会退化成"维度不符"的硬错误
    （被应用层挡住）或者更糟的静默错误（维度恰好相同但语义不同）。
    """

    payload = {k: v for k, v in spec.items() if k != "api_key_env"}
    payload["output_dimension"] = spec.get("dimension")
    return fingerprint({"schema": "semantic-model-v1", **payload})


def runtime_fingerprint(spec) -> str:
    """实际运行环境指纹：设备、精度、推理后端、batch/padding、关键依赖版本。

    严格模式下**不跨 CPU/GPU、不跨精度**混用缓存：两者的向量在数值上不保证一致，
    混用会让"同一个键对应哪个向量"变得不可解释。
    """

    versions: dict = {}
    for name in ("torch", "transformers", "sentence-transformers"):
        try:
            from importlib.metadata import version as _version

            versions[name] = _version(name)
        except Exception:  # noqa: BLE001 - 可选依赖缺失不影响指纹生成
            continue
    return fingerprint(
        {
            "schema": "semantic-runtime-v1",
            "device": spec.get("device", "cpu"),
            "dtype": spec.get("dtype", "float32"),
            "backend": spec.get("provider"),
            "pooling": spec.get("pooling"),
            "max_length": spec.get("max_length"),
            "batch_size": spec.get("batch_size"),
            "output_normalization": "l2",
            "versions": versions,
        }
    )


def _looks_like_oom(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(hint in text for hint in _OOM_HINTS)


def _degenerate_space(count: int) -> SemanticSpace:
    """结构退化（单条唯一文本）时的占位语义空间。

    刻意不加载模型：一条文本既不需要选 K，也不需要任何语义比较。
    用 1 维全 1 向量表示"只有它自己"，因此它与自身中心的余弦恒为 1。
    """

    matrix = np.ones((max(1, count), 1), dtype=np.float32)
    return SemanticSpace(
        sem=matrix,
        fit=matrix,
        reduction={
            "status": "disabled",
            "source_dim": 1,
            "fit_dim": 1,
            "pca_dim": 0,
            "fit_samples": 0,
            "random_state": 42,
            "reason": "structural_degenerate",
            "whiten": False,
        },
        bad_rows=[],
    )


class SemanticAutoKMeansStrategy:
    """semantic-v1 的唯一策略实现（当前服务于 ``semantic_auto_kmeans``）。"""

    def __init__(self, *, profile, settings, catalog, encoders, text_cache=None) -> None:
        self.profile = profile
        self.settings = settings
        self.catalog = catalog
        self.encoders = encoders
        self.cache = text_cache or TextEmbeddingCache(settings.artifacts_dir / "text_embeddings")
        self.runs = RunStore(settings.artifacts_dir / "runs")
        self.calibration = catalog.calibration(getattr(profile, "calibration_id", None))
        self.meta = StrategyMeta(
            implementation_version=SEMANTIC_VERSION,
            algorithms=(profile.algorithm,),
            supports_single_item=True,
            supports_cache_only=True,
            calibration_version=getattr(self.calibration, "version", None),
            features={"version": profile.features.version, "n_results": profile.features.n_results},
        )

    # ------------------------------------------------------------------ 向量

    def _vectors(
        self,
        corpus,
        *,
        warnings: list[str],
        timings: dict,
    ) -> tuple[np.ndarray, dict]:
        """取回唯一文本的向量，返回 ``(矩阵, 缓存/运行统计)``。

        行为要点：

        * 先批量查缓存，只对 miss 调编码器；命中率按"读盘查询结果"计算，
          不从后续内部二次读取推导；
        * 模型不可用但**全量命中**时走 cache-only，并在告警里明确说明；
        * 有一条 miss 又没有可用模型时直接 ``MODEL_UNAVAILABLE``。
        """

        spec = self.catalog.model(self.profile.model_id)
        model_hash = semantic_model_fingerprint(spec)
        runtime = runtime_fingerprint(spec)
        preprocessing = f"{NORMALIZATION_VERSION}+l2"

        keys = [
            build_key(
                normalized_text=entry.embedding_text,
                preprocessing_version=preprocessing,
                model_fingerprint=model_hash,
                runtime_fingerprint=runtime,
            )
            for entry in corpus.unique
        ]

        started = time.monotonic()
        hits, misses = self.cache.lookup(keys)
        timings["cache_lookup_ms"] = round((time.monotonic() - started) * 1000, 3)

        stats = {
            "embedding_cache_hits": len(hits),
            "embedding_cache_misses": len(misses),
            "embedding_cache_hit_ratio": round(len(hits) / max(1, len(keys)), 6),
            "cache_only": False,
            "effective_device": spec.get("device", "cpu"),
            "fallback_reason": None,
            "model_fingerprint": model_hash,
            "runtime_fingerprint": runtime,
        }

        if misses:
            started = time.monotonic()
            encoded, fallback = self._encode(spec, model_hash, [keys.index(key) for key in misses], corpus, warnings)
            timings["embedding_ms"] = round((time.monotonic() - started) * 1000, 3)
            stats["fallback_reason"] = fallback
            for position, key in enumerate(misses):
                hits[key] = encoded[position]
            self.cache.commit({key: hits[key] for key in misses}, dimension=int(encoded.shape[1]))
        else:
            timings["embedding_ms"] = 0.0
            # 全量命中：即使模型当前不可用，也可以在不伪造向量的前提下完成
            stats["cache_only"] = True
            warnings.append("EMBEDDING_CACHE_ONLY")
            event("semantic_cache_only", profile_id=self.profile.profile_id, unique=corpus.unique_count)

        matrix = np.stack([hits[key] for key in keys]).astype(np.float32)
        return matrix, stats

    def _encode(self, spec, model_hash, positions, corpus, warnings) -> tuple[np.ndarray, str | None]:
        """编码 miss 文本；GPU OOM 时有界回退到同模型 CPU。"""

        texts = [corpus.unique[index].embedding_text for index in positions]
        try:
            encoder = self.encoders.get(spec, model_hash)
        except ClusterError:
            # 模型不可用且存在 miss：明确失败，绝不拼接替代向量
            raise ClusterError(
                "MODEL_UNAVAILABLE",
                "Embedding model is unavailable and the text cache does not cover every input",
                503,
            ) from None

        fallback: str | None = None
        try:
            values = encoder.encode(texts)
        except Exception as exc:  # noqa: BLE001 - 需要区分 OOM 与其他失败
            if not _looks_like_oom(exc) or spec.get("device", "cpu") == "cpu":
                raise ClusterError("EMBEDDING_FAILED", "Embedding inference failed", 500) from exc
            # 整个请求切到同模型 CPU FP32：不混用两种设备的向量，保证版本可复现
            cpu_spec = {**spec, "device": "cpu"}
            cpu_hash = model_fingerprint(cpu_spec)
            warnings.append("GPU_OOM_CPU_FALLBACK")
            fallback = "gpu_oom_cpu_fallback"
            event("semantic_device_fallback", profile_id=self.profile.profile_id, reason=fallback)
            encoder = self.encoders.get(cpu_spec, cpu_hash)
            values = encoder.encode(texts)

        matrix = np.ascontiguousarray(np.asarray(values, dtype=np.float32))
        if matrix.ndim != 2 or matrix.shape[0] != len(texts):
            raise ClusterError("INVALID_EMBEDDINGS", "Encoder returned an unexpected matrix shape", 500)
        return matrix, fallback

    # ------------------------------------------------------------------ 执行

    def run(self, items, *, enforce_api_limits: bool = False) -> dict:
        """执行一次 semantic-v1 聚类，返回结果并原子落盘产物。"""

        started = time.monotonic()
        timings: dict[str, float] = {}
        profile = self.profile
        params = dict(profile.algorithm_params)
        calibration = self.calibration
        if calibration is None:
            raise ClusterError("INVALID_PROFILE", "semantic-v1 profile requires a calibration", 422)
        warnings = list(WARNINGS.get(profile.algorithm, []))
        if getattr(calibration, "status", "experimental") != "validated":
            warnings.append("SEMANTIC_CALIBRATION_EXPERIMENTAL")

        # ① 规范化 / 无效识别 / 精确去重
        stage = time.monotonic()
        corpus = build_corpus(
            items,
            max_chars=self.settings.max_text_length,
            # long_text 的字符代理阈值属于"展示/诊断口径"，与阈值一起放在校准配置里，
            # 不放进 profile 的预算参数——否则同一份校准会随 profile 漂移。
            long_text_chars=int(calibration.naming.get("long_text_chars", 512)),
        )
        timings["normalize_ms"] = round((time.monotonic() - stage) * 1000, 3)

        limit = min(self.settings.max_samples, profile.max_samples) if enforce_api_limits else profile.max_samples
        if corpus.total == 0:
            raise ClusterError("EMPTY_DATASET", "No items to cluster", 422)
        if corpus.total > limit:
            raise ClusterError("INVALID_SAMPLE_COUNT", "Sample count exceeds the configured limits", 422)
        if corpus.unique_count == 0:
            raise ClusterError("NO_VALID_TEXT", "No valid text to cluster after normalization", 422)
        if corpus.invalid_count:
            warnings.append("INVALID_TEXT_EXCLUDED")
        if corpus.long_text_count:
            warnings.append("LONG_TEXT_MAY_BE_TRUNCATED_BY_MODEL")
        if corpus.duplicate_count:
            warnings.append("EXACT_DUPLICATES_MERGED")

        # ② 向量：结构退化（单条唯一文本）时完全不加载模型
        if corpus.unique_count == 1:
            space = _degenerate_space(1)
            cache_stats = {
                "embedding_cache_hits": 0,
                "embedding_cache_misses": 0,
                "embedding_cache_hit_ratio": None,
                "cache_only": True,
                "effective_device": "none",
                "fallback_reason": None,
                "model_fingerprint": None,
                "runtime_fingerprint": None,
            }
            warnings.append("STRUCTURAL_DEGENERATE_NO_MODEL")
        else:
            matrix, cache_stats = self._vectors(corpus, warnings=warnings, timings=timings)
            stage = time.monotonic()
            space = build_semantic_space(
                matrix,
                pca_dim=int(params.get("pca_dim", FALLBACK_PCA_DIM)),
                pca_min_samples=int(params.get("pca_min_samples", FALLBACK_PCA_MIN_SAMPLES)),
                random_state=int(params.get("seed", 42)),
                dimension=self.catalog.model(profile.model_id)["dimension"],
            )
            timings["semantic_space_ms"] = round((time.monotonic() - stage) * 1000, 3)
            # 大范围坏向量说明模型/编码环节出了问题，直接失败而不是"假装全是噪声"
            bad = len(space.bad_rows)
            if bad and (bad > BAD_VECTOR_ABSOLUTE_LIMIT or bad / max(1, corpus.unique_count) > BAD_VECTOR_RATIO_LIMIT):
                raise ClusterError(
                    "INVALID_EMBEDDINGS",
                    f"{bad} of {corpus.unique_count} embeddings are near-zero norm",
                    500,
                )
            if bad:
                warnings.append("ISOLATED_INVALID_EMBEDDINGS")

        # ③ 有界 Auto-K + 全量拟合 + 后处理 + 规范编号
        stage = time.monotonic()
        thresholds = calibration.thresholds()
        outcome = run_auto_k(
            space,
            unique_keys=[entry.key for entry in corpus.unique],
            frequencies=[entry.frequency for entry in corpus.unique],
            texts=[entry.text for entry in corpus.unique],
            k_cap=int(params.get("k_cap", 256)),
            seed=int(params.get("seed", 42)),
            sample_size=int(params.get("sample_size", 8192)),
            validation_size=int(params.get("validation_size", 2048)),
            max_iter=int(params.get("max_iter", 100)),
            batch_size=int(params.get("batch_size", 1024)),
            n_init=int(params.get("n_init", 3)),
            t_sem=thresholds["t_sem"],
            t_pair=thresholds["t_pair"],
            t_merge=thresholds["t_merge"],
            t_margin=thresholds["t_margin"],
            t_single=thresholds["t_single"],
            min_cluster_unique=int(params.get("min_cluster_unique", 5)),
            split_budget=int(params.get("split_budget", 8)),
            merge_rounds=int(params.get("merge_rounds", 2)),
            refine_rounds=int(params.get("refine_rounds", 2)),
            scaling=dict(calibration.scaling),
            weights=dict(calibration.weights),
        )
        timings["auto_k_ms"] = round((time.monotonic() - stage) * 1000, 3)
        unique_labels = np.asarray(outcome["labels"], dtype=np.int32)
        if outcome["status"] == "no_coherent_topics":
            warnings.append("NO_COHERENT_TOPICS")

        # ④ 可读化：代表文本、关键词、命名、置信度、质量分
        stage = time.monotonic()
        digest = build_semantic_digest(
            corpus=corpus,
            labels=unique_labels,
            states=outcome["states"],
            space=space,
            centers=outcome["centers"],
            calibration={
                "t_sem": thresholds["t_sem"],
                "t_margin": thresholds["t_margin"],
                "confidence_weights": dict(calibration.confidence_weights),
                "quality_weights": dict(calibration.quality_weights),
                "scaling": dict(calibration.scaling),
            },
            top_keywords=int(calibration.naming.get("top_keywords", 8)),
            representatives=int(calibration.naming.get("representatives", 3)),
            keyword_vocab_limit=int(calibration.naming.get("vocab_limit", 30000)),
            selected_k=outcome["auto_k"].selected_k,
        )
        timings["digest_ms"] = round((time.monotonic() - stage) * 1000, 3)
        warnings.extend(item for item in digest["aggregate"].get("warnings", []) if item not in warnings)

        # ⑤ 抽样二维展示（确定性；坐标不参与任何聚类计算）
        stage = time.monotonic()
        visualization = self._visualization(space, unique_labels, corpus)
        timings["visualization_ms"] = round((time.monotonic() - stage) * 1000, 3)
        if len(visualization) < corpus.unique_count:
            warnings.append("VISUALIZATION_SAMPLED")

        # ⑥ 展开回全部原始 ID 并统计
        expanded = expand_labels(corpus, unique_labels)
        assignments: list[dict | None] = [None] * corpus.total
        for unique_index, entry in enumerate(corpus.unique):
            label = int(unique_labels[unique_index])
            for occurrence in entry.occurrences:
                assignments[occurrence.index] = {"id": occurrence.sample_id, "cluster_id": label}
        for entry in corpus.invalid:
            # 无效项保留原始 ID，固定 -1；"无效"身份由 detail 的 assignment_status 表达
            assignments[entry.index] = {"id": entry.sample_id, "cluster_id": -1}
        assignments_out = [item for item in assignments if item is not None]
        live = sorted({int(label) for label in unique_labels if int(label) >= 0})
        diagnostics = online_diagnostics(
            space.sem,
            unique_labels,
            sample_size=MAX_VISUALIZATION_POINTS,
            noise_ratio=digest["aggregate"]["noise_ratio"],
        )
        non_noise = sum(cluster["size"] for cluster in digest["clusters"] if cluster["cluster_id"] != -1)
        sizes = [cluster["size"] for cluster in digest["clusters"] if cluster["cluster_id"] != -1]
        summary = {
            "cluster_count": len(live),
            "noise_count": corpus.total - non_noise,
            "invalid_count": corpus.invalid_count,
            "duplicate_count": corpus.duplicate_count,
            "unique_count": corpus.unique_count,
            "total_samples": corpus.total,
            "coverage": digest["aggregate"]["coverage"],
            "noise_ratio": digest["aggregate"]["noise_ratio"],
            "selected_k": outcome["auto_k"].selected_k,
            "final_k": len(live),
            "auto_k_status": outcome["status"],
            "largest_cluster_size": max(sizes) if sizes else 0,
            "smallest_cluster_size": min(sizes) if sizes else 0,
            "avg_cluster_size": round(sum(sizes) / len(sizes), 4) if sizes else 0.0,
            "quality_score": digest["aggregate"]["macro_quality"],
            "weighted_quality_score": digest["aggregate"]["weighted_quality"],
            "overall_quality": digest["aggregate"]["overall_quality"],
            "quality_version": QUALITY_VERSION,
            "confidence_version": CONFIDENCE_VERSION,
            "naming_version": NAMING_VERSION,
            "tokenizer_version": TOKENIZER_VERSION,
            "normalization_version": NORMALIZATION_VERSION,
            "calibration_version": calibration.version,
            "calibration_status": calibration.status,
            "effective_model_id": profile.model_id if corpus.unique_count > 1 else None,
            "device": cache_stats["effective_device"],
            "implementation_version": SEMANTIC_VERSION,
            "seed": int(params.get("seed", 42)),
            "stage_timings": timings,
            "visualization_sample_count": len(visualization),
            "visualization_total_count": corpus.unique_count,
            "diagnostics": diagnostics,
            "reduction": space.reduction,
            "auto_k": outcome["auto_k"].as_dict(),
            "postprocess": {
                "merge_log": outcome["postprocess"]["merge_log"],
                "split_log": outcome["postprocess"]["split_log"],
                "small_cluster_log": outcome["postprocess"]["small_cluster_log"],
                "refine_log": outcome["postprocess"]["refine_log"],
                "empty_clusters": outcome["postprocess"]["empty_clusters"],
                "numbering": outcome["postprocess"]["numbering"],
            },
            "result_cache_hit": False,  # 结果缓存属阶段 3，当前恒为冷计算
        }
        summary.update(
            {
                key: cache_stats[key]
                for key in (
                    "embedding_cache_hits",
                    "embedding_cache_misses",
                    "embedding_cache_hit_ratio",
                    "cache_only",
                    "fallback_reason",
                )
            }
        )
        summary.update(
            {
                "model_fingerprint": cache_stats["model_fingerprint"],
                "runtime_fingerprint": cache_stats["runtime_fingerprint"],
            }
        )

        result = {
            "run_id": "run_" + uuid.uuid4().hex,
            "profile_id": profile.profile_id,
            "algorithm": profile.algorithm,
            "implementation_version": SEMANTIC_VERSION,
            "n_samples": corpus.total,
            "n_clusters": len(live),
            "n_noise": int(sum(1 for label in expanded if label == -1)),
            "assignments": assignments_out,
            "warnings": warnings,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "semantic": {
                "summary": summary,
                "clusters": digest["clusters"],
                "items": digest["items"],
                "visualization": visualization,
                "aggregate": digest["aggregate"],
            },
        }

        manifest = {
            "schema_version": 2,
            "run_id": result["run_id"],
            "implementation_version": SEMANTIC_VERSION,
            "config": asdict(profile),
            "profile_fingerprint": profile.fingerprint,
            "model": self.catalog.model(profile.model_id) if corpus.unique_count > 1 else None,
            "model_fingerprint": cache_stats["model_fingerprint"],
            "runtime_fingerprint": cache_stats["runtime_fingerprint"],
            "calibration": calibration.as_dict(),
            "calibration_source_fingerprint": calibration.source_fingerprint,
            "normalization_version": NORMALIZATION_VERSION,
            "input_fingerprint": fingerprint(
                [{"id": item.get("id"), "text": item.get("text")} for item in items]
            ),
            "unique_text_fingerprint": corpus.sample_key_fingerprint(),
            "auto_k": outcome["auto_k"].as_dict(),
            "postprocess": result["semantic"]["summary"]["postprocess"],
            "stage_timings": timings,
            "cache": {key: cache_stats[key] for key in cache_stats if "fingerprint" not in key},
            "feature_space": space.reduction,
            "backend": profile.backend,
            "knowledge_base": None,
            "source_fingerprint": _source_fingerprint(),
            "environment": _environment_versions(),
            "baseline_kind": "semantic-v1-current-environment",
            "seed": int(params.get("seed", 42)),
        }
        self.runs.save(result, manifest)
        event(
            "completed",
            run_id=result["run_id"],
            algorithm=profile.algorithm,
            n_samples=corpus.total,
            unique=corpus.unique_count,
            elapsed_ms=result["elapsed_ms"],
            final_k=len(live),
            cache_only=cache_stats["cache_only"],
        )
        return result

    def _visualization(self, space, labels, corpus) -> list[dict]:
        """确定性分层抽样后投影到二维；最多 ``MAX_VISUALIZATION_POINTS`` 个点。

        抽样优先覆盖每个有效簇（含 1 个点的小簇），再补噪声；簇内按文本键排序，
        因此"打乱输入顺序"不会改变抽样集合。坐标不影响聚类，图上必须标注"抽样展示"。
        """

        total = space.sem.shape[0]
        if total < 2 or space.sem.shape[1] < 2:
            return []
        live = sorted({int(label) for label in labels if int(label) >= 0})
        per_cluster = max(1, MAX_VISUALIZATION_POINTS // max(1, len(live) + 1))
        selected: list[int] = []
        for label in live:
            members = sorted(
                (index for index in range(total) if int(labels[index]) == label),
                key=lambda index: corpus.unique[index].key,
            )
            selected.extend(members[:per_cluster])
        remaining = MAX_VISUALIZATION_POINTS - len(selected)
        if remaining > 0:
            noise = sorted(
                (index for index in range(total) if int(labels[index]) < 0),
                key=lambda index: corpus.unique[index].key,
            )
            selected.extend(noise[:remaining])
        if len(selected) > MAX_VISUALIZATION_POINTS:
            selected = selected[:MAX_VISUALIZATION_POINTS]
        if len(selected) < 2:
            selected = sorted(range(total), key=lambda index: corpus.unique[index].key)[:MAX_VISUALIZATION_POINTS]
        matrix = space.fit[np.asarray(selected)]
        try:
            coords = project_2d(matrix)
        except ClusterError:
            return []
        return [
            {
                "id": corpus.unique[index].primary_id,
                "x": round(float(coords[position][0]), 6),
                "y": round(float(coords[position][1]), 6),
                "cluster_id": int(labels[index]),
            }
            for position, index in enumerate(selected)
        ]


def _source_fingerprint() -> str:
    """包内源码指纹：区分"同一个 profile、不同代码版本"的运行。"""

    from pathlib import Path

    from ..artifacts.fingerprints import file_hash

    root = Path(__file__).resolve().parents[1]
    return fingerprint({str(path.relative_to(root)): file_hash(path) for path in sorted(root.rglob("*.py"))})


def _environment_versions() -> dict:
    """关键依赖版本；缺失的可选依赖跳过而不是让整个记录失败。"""

    from importlib.metadata import PackageNotFoundError, version

    result: dict = {}
    for name in ("numpy", "scikit-learn", "torch", "transformers", "sentence-transformers", "jieba"):
        try:
            result[name] = version(name)
        except PackageNotFoundError:
            pass
    return result


__all__ = [
    "BAD_VECTOR_ABSOLUTE_LIMIT",
    "BAD_VECTOR_RATIO_LIMIT",
    "MAX_VISUALIZATION_POINTS",
    "SemanticAutoKMeansStrategy",
    "runtime_fingerprint",
    "semantic_model_fingerprint",
]
