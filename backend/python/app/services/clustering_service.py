"""聚类网关服务：把 cluster-engine 的算法能力包装成 HazardInsight 的接口契约。

分工严格遵循"不重复实现算法"的原则：

* **算法、向量化、检索增强、特征融合、降维、参数校验** —— 全部调用
  `retrain_cluster` 的既有实现，网关一行算法都没有重写；
* **网关只负责**：加载引擎、解析 profile 元信息、把上传文件规范成样本、
  调用引擎执行、把引擎结果加工成前端需要的结构（统计 / 簇摘要 / 二维坐标）。

引擎结果文件的落盘（`artifacts/runs/<run_id>/`）由引擎自己完成，
网关不干预，从而保留完整的可复现追溯链。
"""

from __future__ import annotations

import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import GatewaySettings, get_settings
from app.core.constants import (
    AUTO_PROFILE_ALGORITHM_PREFERENCE,
    MAX_ITEMS,
    MAX_TEXT_CHARS,
    NOISE_CLUSTER_ID,
)
from app.core.errors import (
    ClusterGatewayError,
    ClusteringError,
    EngineUnavailableError,
    InvalidInputError,
    ProfileUnavailableError,
    SampleDatasetError,
    ServiceBusyError,
)
from app.core.logger import get_logger
from app.processors.tabular_reader import read_records
from app.processors.text_cleaner import clean_hazard_text
from app.services.cluster_digest import build_digest
from app.utils.helpers import truncate
from app.utils.validators import validate_item_count

logger = get_logger(__name__)

#: 本地模型校验（逐个文件算 SHA-256）代价较高，因此结果在进程内缓存。
_MODEL_READY_TTL_SECONDS = 600.0

#: profile 可用性缓存有效期。
_PROFILE_STATUS_TTL_SECONDS = 600.0


def _from_engine_error(exc: Exception) -> ClusterGatewayError:
    """把 cluster-engine 的 `ClusterError` 转成网关错误，保留其错误码与状态码。"""

    error = ClusterGatewayError(str(getattr(exc, "message", exc)))
    error.code = getattr(exc, "code", "CLUSTERING_FAILED")
    error.status = getattr(exc, "status", 500)
    return error


class ClusteringGatewayService:
    """单例式的聚类网关服务。

    引擎的加载是惰性且带锁的：配置缺失或依赖未安装时，健康检查会明确报告
    `degraded`，而不是在首个请求时抛出难以理解的导入错误。
    """

    def __init__(self, settings: GatewaySettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._engine: Any = None
        self._engine_settings: Any = None
        self._catalog: Any = None
        self._engine_error: str | None = None
        self._load_lock = threading.Lock()

        # 单飞：聚类是 CPU/内存密集型任务，同一时刻只允许一个请求进入引擎。
        self._run_lock = threading.Lock()

        # 元信息缓存，避免每次列表请求都重新校验 1.3GB 本地模型
        # 注意：这里的名字不能叫 `_model_ready`，否则会遮蔽同名的 `_model_ready()` 方法
        # （实例属性优先于类方法查找，调用时会变成 "dict object is not callable"）。
        self._model_ready_cache: dict[str, tuple[bool, str | None, float]] = {}
        self._profile_cache: tuple[float, list[dict[str, Any]]] | None = None
        self._cache_lock = threading.Lock()

    # ------------------------------------------------------------------ 引擎加载

    def preload(self) -> None:
        """在后台线程预热引擎与模型校验，让首个请求不必等待磁盘校验。

        本地模型校验需要逐个文件计算 SHA-256（约 1.3GB），放在启动时做一次，
        后续 10 分钟内的健康检查与 profile 列表都可直接命中缓存。
        """

        def warm() -> None:
            try:
                self._load_engine()
                if self._engine is None:
                    return
                for model_id in self._catalog.models:
                    self._model_ready(model_id)
                self.list_profiles()
                logger.info("聚类引擎预热完成")
            except Exception as exc:  # noqa: BLE001 - 预热失败不应影响服务启动
                logger.warning("聚类引擎预热失败：%s", exc)

        threading.Thread(target=warm, name="cluster-preload", daemon=True).start()

    def invalidate_caches(self) -> None:
        """清空元信息缓存，强制下次请求重新校验模型与 profile。"""

        with self._cache_lock:
            self._model_ready_cache.clear()
            self._profile_cache = None

    def _load_engine(self) -> None:
        """惰性加载 cluster-engine（配置、Catalog、ClusteringService）。"""

        if self._engine is not None or self._engine_error is not None:
            return
        with self._load_lock:
            if self._engine is not None or self._engine_error is not None:
                return
            config_path = self.settings.engine_config_path
            if not config_path.is_file():
                self._engine_error = f"未找到聚类引擎配置：{config_path}"
                logger.error("%s", self._engine_error)
                return
            try:
                from retrain_cluster.config import Catalog, Settings as EngineSettings
                from retrain_cluster.services.clustering import ClusteringService

                engine_settings = EngineSettings.load(str(config_path))
                self._catalog = Catalog(engine_settings)
                self._engine_settings = engine_settings
                self._engine = ClusteringService(engine_settings)
                logger.info(
                    "聚类引擎已加载：%d 个 profile，%d 个模型",
                    len(self._catalog.profiles),
                    len(self._catalog.models),
                )
            except Exception as exc:  # noqa: BLE001 - 依赖缺失/配置错误都要转成明确状态
                self._engine_error = (
                    f"聚类引擎加载失败：{exc}。请在 backend/python 下执行 "
                    f"pip install -r requirements.txt 后重试。"
                )
                logger.error("%s", self._engine_error)

    def _require_engine(self) -> Any:
        """取回引擎实例；不可用时抛 `EngineUnavailableError`。"""

        self._load_engine()
        if self._engine is None:
            raise EngineUnavailableError(self._engine_error or "聚类引擎不可用。")
        return self._engine

    # ------------------------------------------------------------------ 元信息

    def _model_ready(self, model_id: str) -> tuple[bool, str | None]:
        """校验模型可用性（带进程内缓存）。返回 (是否可用, 不可用原因)。"""

        now = time.monotonic()
        with self._cache_lock:
            cached = self._model_ready_cache.get(model_id)
            if cached and now - cached[2] < _MODEL_READY_TTL_SECONDS:
                return cached[0], cached[1]
        ready, reason = True, None
        try:
            from retrain_cluster.embeddings.registry import check_model

            check_model(self._catalog.model(model_id))
        except Exception as exc:  # noqa: BLE001 - 依赖缺失/校验和不符都在此收敛
            ready, reason = False, getattr(exc, "code", "MODEL_UNAVAILABLE")
            logger.warning("模型 %s 不可用：%s", model_id, exc)
        with self._cache_lock:
            self._model_ready_cache[model_id] = (ready, reason, now)
        return ready, reason

    def _profile_status(self, profile: Any) -> tuple[bool, str | None]:
        """判断某个 profile 当前能否执行。

        复用引擎的 `validate_params` / `check_model` / `read_manifest` 三个校验点，
        但把最贵的模型校验按 `model_id` 缓存，避免 20 个 profile 重复校验同一份
        1.3GB 权重（引擎自带的 `/api/v1/profiles` 每次都全量校验，较慢）。
        """

        try:
            from retrain_cluster.clustering.registry import validate_params
            from retrain_cluster.config import model_fingerprint
            from retrain_cluster.retrieval.chroma import read_manifest

            validate_params(profile.algorithm, profile.algorithm_params, profile.backend)
            model = self._catalog.model(profile.model_id)
            ready, reason = self._model_ready(profile.model_id)
            if not ready:
                return False, reason
            if profile.features.n_results:
                read_manifest(
                    self._catalog.settings.artifacts_dir / "knowledge_bases",
                    profile.knowledge_base_id,
                    model_fingerprint(model),
                    model["dimension"],
                )
            return True, None
        except Exception as exc:  # noqa: BLE001
            return False, getattr(exc, "code", "PROFILE_UNAVAILABLE")

    def list_profiles(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        """列出引擎中可通过 API 使用的 profile 及其可用状态。"""

        self._require_engine()
        now = time.monotonic()
        with self._cache_lock:
            if not refresh and self._profile_cache and now - self._profile_cache[0] < _PROFILE_STATUS_TTL_SECONDS:
                return self._profile_cache[1]

        from retrain_cluster.clustering.registry import API_ALGORITHMS, WARNINGS

        profiles: list[dict[str, Any]] = []
        for profile in self._catalog.profiles.values():
            if profile.algorithm not in API_ALGORITHMS:
                continue
            available, reason = self._profile_status(profile)
            profiles.append(
                {
                    "profile_id": profile.profile_id,
                    "algorithm": profile.algorithm,
                    "model_id": profile.model_id,
                    "knowledge_base_id": profile.knowledge_base_id,
                    "features": asdict(profile.features),
                    "algorithm_params": profile.algorithm_params,
                    "implementation_version": profile.implementation_version,
                    "max_samples": min(MAX_ITEMS, profile.max_samples),
                    "available": available,
                    "unavailable_reason": reason,
                    "warnings": list(WARNINGS.get(profile.algorithm, [])),
                }
            )
        profiles.sort(
            key=lambda item: (
                not item["available"],
                item["features"].get("n_results", 0),
                item["algorithm"],
            )
        )
        with self._cache_lock:
            self._profile_cache = (now, profiles)
        return profiles

    def list_algorithms(self) -> list[dict[str, Any]]:
        """列出引擎暴露给 API 的算法及其可用性。"""

        self._require_engine()
        from retrain_cluster.clustering.registry import API_ALGORITHMS, WARNINGS, available

        return [
            {
                "algorithm": name,
                "available": bool(available(name)),
                "backend": "python",
                "implementation_version": "legacy-v1",
                "max_samples": MAX_ITEMS,
                "warnings": list(WARNINGS.get(name, [])),
            }
            for name in API_ALGORITHMS
        ]

    def engine_status(self) -> dict[str, Any]:
        """返回引擎加载状态，供健康检查使用。"""

        self._load_engine()
        config_file = self.settings.engine_config_path.name
        if self._engine is None:
            return {
                "config_file": config_file,
                "loaded": False,
                "message": self._engine_error,
            }

        from retrain_cluster.clustering.registry import API_ALGORITHMS, available

        model_ids = list(self._catalog.models.keys())
        model_id = model_ids[0] if model_ids else None
        spec = self._catalog.models.get(model_id) if model_id else None
        ready, reason = self._model_ready(model_id) if model_id else (False, "MODEL_NOT_CONFIGURED")
        profiles = self.list_profiles()
        return {
            "config_file": config_file,
            "loaded": True,
            "profiles_total": len(profiles),
            "profiles_available": sum(1 for profile in profiles if profile["available"]),
            "algorithms_available": [name for name in API_ALGORITHMS if available(name)],
            "model_id": model_id,
            "model_provider": spec.get("provider") if spec else None,
            "model_dimension": spec.get("dimension") if spec else None,
            "message": None if ready else f"向量模型不可用（{reason}）",
        }

    # ------------------------------------------------------------------ 示例与上传

    def load_sample_dataset(self) -> dict[str, Any]:
        """读取内置示例数据集（真实核电工程隐患抽样）。"""

        path: Path = self.settings.sample_dataset_path
        if not path.is_file():
            raise SampleDatasetError(f"内置示例数据不存在：{path.name}。")
        import json

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise SampleDatasetError(f"内置示例数据解析失败：{exc}") from exc
        items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(items, list) or not items:
            raise SampleDatasetError("内置示例数据中没有可用样本。")
        dataset = payload.get("dataset_id", path.stem) if isinstance(payload, dict) else path.stem
        return {"source_name": f"示例数据 · {dataset}", "items": items}

    def parse_dataset(self, data: bytes, filename: str) -> dict[str, Any]:
        """把上传的数据文件规范成样本列表。

        返回 `{source_name, total, items, warnings}`，字段与 `DatasetPreview` 契约一一对应
        （`total` 是清洗后真正可用的样本数，不等于原始行数，因此必须显式回报）。
        """

        records, warnings = read_records(data, filename)
        if not records:
            raise InvalidInputError("文件中没有解析出可用样本，请检查文本列是否为空。")

        items: list[dict[str, Any]] = []
        seen_ids: dict[str, int] = {}
        truncated = 0
        skipped: list[str] = []

        for index, record in enumerate(records, start=1):
            raw_id = str(record.get("id") or f"row-{index}").strip()
            identifier, id_cut = truncate(raw_id, 128)
            identifier = identifier or f"row-{index}"
            if identifier in seen_ids:
                seen_ids[identifier] += 1
                identifier = f"{identifier}#{seen_ids[identifier]}"
            else:
                seen_ids[identifier] = 1
            text = str(record.get("text") or "")
            cleaned = clean_hazard_text(text, limit=MAX_TEXT_CHARS)
            if not cleaned.strip():
                skipped.append(raw_id)
                continue
            if len(cleaned) < len(text.strip()):
                truncated += 1
            metadata = {
                key: str(value)
                for key, value in record.items()
                if key not in {"id", "text"} and str(value).strip()
            }
            items.append({"id": identifier, "text": cleaned, "metadata": metadata})
            if len(items) >= MAX_ITEMS:
                warnings.append(f"样本数已达上限 {MAX_ITEMS} 条，其余数据被忽略。")
                break

        if id_cut:
            warnings.append("存在超过 128 字符的 ID，已截断。")
        if truncated:
            warnings.append(f"{truncated} 条文本超过 {MAX_TEXT_CHARS} 字符，已截断后参与聚类。")
        if skipped:
            warnings.append(f"{len(skipped)} 条记录文本为空，已跳过。")
        if not items:
            raise InvalidInputError("文件中没有可用的非空文本。")
        return {
            "source_name": filename,
            "total": len(items),
            "items": items,
            "warnings": warnings,
        }

    # ------------------------------------------------------------------ 执行聚类

    def _resolve_profile(self, options: dict[str, Any]) -> Any:
        """决定本次请求使用哪个 profile。

        优先级：显式 `profile_id` > 指定 `algorithm` 的可用 profile > 配置的
        `default_profile_id` > 自动挑选（纯向量 profile 优先）。
        """

        catalog = self._catalog
        profile_id = options.get("profile_id") or self.settings.default_profile_id
        if profile_id:
            try:
                profile = catalog.profile(profile_id)
            except Exception as exc:  # noqa: BLE001
                raise _from_engine_error(exc) from exc
            available, reason = self._profile_status(profile)
            if not available:
                raise ProfileUnavailableError(
                    f"profile「{profile_id}」当前不可执行（{reason}）。"
                    "若是检索增强 profile，请先构建对应知识库。"
                )
            return profile

        profiles = self.list_profiles()
        algorithms = [options["algorithm"]] if options.get("algorithm") else []

        def matches(profile: dict[str, Any]) -> bool:
            return not algorithms or profile["algorithm"] in algorithms

        candidates = [profile for profile in profiles if profile["available"] and matches(profile)]
        if not candidates and algorithms:
            raise ProfileUnavailableError(
                f"算法「{algorithms[0]}」当前没有可用的 profile。"
                f"可用算法：{', '.join(sorted({p['algorithm'] for p in profiles if p['available']}))}"
            )
        if not candidates:
            raise ProfileUnavailableError("当前没有可用的 profile，请检查引擎配置与模型文件。")

        def rank(profile: dict[str, Any]) -> tuple[int, int, str]:
            try:
                preferred = AUTO_PROFILE_ALGORITHM_PREFERENCE.index(profile["algorithm"])
            except ValueError:
                preferred = len(AUTO_PROFILE_ALGORITHM_PREFERENCE)
            return (profile["features"].get("n_results", 0), preferred, profile["profile_id"])

        selected = sorted(candidates, key=rank)[0]
        return catalog.profile(selected["profile_id"])

    def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        """执行一次聚类，返回加工后的结果。

        参数:
            payload: 形如 `{"items": [{"id","text","metadata"}], "options": {...}}`。

        流程：引擎执行聚类（算法权威结果）→ 取回/复用向量 → 复现引擎的特征变换
        → PCA 降维得到二维坐标 → 生成簇摘要。
        """

        from retrain_cluster.clustering.registry import validate_params
        from retrain_cluster.features.pipeline import FeaturePipeline
        from retrain_cluster.features.reduction import DimReducer
        from retrain_cluster.types import EmbeddingBatch

        started = time.monotonic()
        options = dict(payload.get("options") or {})
        raw_items = payload.get("items") or []
        validate_item_count(len(raw_items))

        texts: list[str] = []
        sample_ids: list[str] = []
        metadata: list[dict[str, Any]] = []
        for index, item in enumerate(raw_items, start=1):
            text = clean_hazard_text(str(item.get("text") or ""), limit=MAX_TEXT_CHARS)
            if not text.strip():
                raise InvalidInputError(f"第 {index} 条样本文本为空。")
            texts.append(text)
            sample_ids.append(str(item.get("id") or f"row-{index}"))
            metadata.append(dict(item.get("metadata") or {}))
        if len(set(sample_ids)) != len(sample_ids):
            raise InvalidInputError("样本 ID 必须唯一，请检查输入数据。")

        engine = self._require_engine()
        profile = self._resolve_profile(options)

        # 引擎在真正执行前先校验超参：参数不合法立刻返回 422 语义，不做无谓计算。
        try:
            validate_params(profile.algorithm, profile.algorithm_params, profile.backend)
        except Exception as exc:  # noqa: BLE001
            raise _from_engine_error(exc) from exc

        if not self._run_lock.acquire(blocking=False):
            raise ServiceBusyError("已有聚类任务正在执行，请稍后重试。")
        try:
            # ① 引擎执行聚类：算法结果与产物落盘都由引擎负责
            engine_request = {
                "profile_id": profile.profile_id,
                "items": [{"id": ident, "text": text} for ident, text in zip(sample_ids, texts)],
            }
            try:
                result = engine.cluster(engine_request, enforce_api_limits=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("聚类执行失败：%s", exc)
                raise _from_engine_error(exc) from exc

            labels = np.asarray([item["cluster_id"] for item in result["assignments"]], dtype=int)
            if labels.shape != (len(raw_items),):
                raise ClusteringError("引擎返回的标签数量与样本数不一致。")

            # ② 取回向量并复现引擎的特征变换（命中引擎自有缓存时不会重复推理）
            try:
                values, model_hash, cache_hit = engine.embeddings(texts, profile.model_id)
                retriever = engine.retriever(profile, model_hash)
                transformed = FeaturePipeline(retriever, self._engine_settings.query_batch).transform(
                    EmbeddingBatch(sample_ids, values, model_hash).values, profile.features
                )
            except Exception as exc:  # noqa: BLE001
                raise _from_engine_error(exc) from exc

            # ③ 二维坐标仅用于可视化，不参与任何聚类计算
            visualization: list[dict[str, Any]] = []
            warnings = list(result.get("warnings", []))
            if options.get("visualize", True) and options.get("reduce_method", "pca") == "pca":
                if transformed.shape[1] >= 2 and transformed.shape[0] >= 2:
                    try:
                        coords = DimReducer("PCA").fit_transform(transformed, 2)
                        visualization = [
                            {
                                "id": sample_ids[index],
                                "x": round(float(coords[index][0]), 6),
                                "y": round(float(coords[index][1]), 6),
                                "cluster_id": int(labels[index]),
                            }
                            for index in range(len(sample_ids))
                        ]
                    except Exception as exc:  # noqa: BLE001 - 可视化失败不应让聚类失败
                        logger.warning("二维降维失败，跳过散点坐标：%s", exc)
                        warnings.append("二维可视化坐标生成失败，结果本身不受影响。")
                else:
                    warnings.append("样本或向量维度不足，未生成二维可视化坐标。")

            # ④ 簇摘要：代表样本、关键词、元数据分布（展示辅助，不改动聚类结果）
            clusters, items = build_digest(
                sample_ids=sample_ids,
                texts=texts,
                labels=labels,
                vectors=transformed,
                metadata=metadata,
                top_keywords=self.settings.digest_top_keywords,
                representatives=self.settings.digest_representatives,
            )

            non_noise = [cluster for cluster in clusters if cluster["cluster_id"] != NOISE_CLUSTER_ID]
            sizes = [cluster["size"] for cluster in non_noise]
            gateway_ms = round((time.monotonic() - started) * 1000)
            summary = {
                "run_id": result["run_id"],
                "total_samples": len(sample_ids),
                "cluster_count": len(non_noise),
                "noise_count": int((labels == NOISE_CLUSTER_ID).sum()),
                "largest_cluster_size": max(sizes) if sizes else 0,
                "smallest_cluster_size": min(sizes) if sizes else 0,
                "avg_cluster_size": round(sum(sizes) / len(sizes), 2) if sizes else 0.0,
                "algorithm": result["algorithm"],
                "profile_id": result["profile_id"],
                "model_id": profile.model_id,
                "implementation_version": result.get("implementation_version", "legacy-v1"),
                "embedding_dimension": int(transformed.shape[1]),
                "cache_hit": bool(cache_hit),
                "elapsed_ms": int(result.get("elapsed_ms", 0)),
                "gateway_ms": gateway_ms,
                "warnings": warnings,
            }
            return {
                "summary": summary,
                "clusters": clusters,
                "items": items,
                "visualization": visualization,
            }
        finally:
            self._run_lock.release()
