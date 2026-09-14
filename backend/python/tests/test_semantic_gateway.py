"""semantic-v1 的网关契约测试。

网关在语义路径上的职责只有三件事，本模块就钉这三件事：

1. **原样透传**：clusters / items / visualization 必须与引擎返回的一致——
   网关不重新打分、不重命名、不重新抽样；
2. **不二次编码**：绝不调用 ``engine.embeddings``（那是 legacy 分支复现特征变换用的），
   否则同一批文本会被编码两次，且"向量口径"出现两个来源；
3. **契约与准入**：结果能构造出 ``ClusteringData``，且"单条样本"按实现版本放行/拒绝。

引擎用替身（返回固定载荷），因此这里不需要本地向量模型，测试与模型是否就绪无关。
profile 与算法参数取自仓库真实配置，让 ``validate_params`` 走真路径而不是被绕过。
"""

from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from app.core.config import get_settings
from app.core.errors import ClusterGatewayError, InvalidInputError
from app.schemas.clustering import ClusteringData, ProfileInfo
from app.services.clustering_service import ClusteringGatewayService, _capability_of

SEMANTIC_PROFILE_ID = "bge-large-semantic-auto-kmeans-v1"


class StubEngine:
    """替身引擎：记录请求、按请求规模返回合法载荷，并让"二次编码"直接失败。"""

    def __init__(self, factory) -> None:
        self.factory = factory
        self.requests: list[dict] = []
        self.embeddings_calls = 0

    def cluster(self, request, *, enforce_api_limits: bool = False):
        self.requests.append({"request": request, "enforce_api_limits": enforce_api_limits})
        return copy.deepcopy(self.factory(request.get("items") or []))

    def embeddings(self, texts, model_id):  # pragma: no cover - 被调用即测试失败
        self.embeddings_calls += 1
        raise AssertionError("semantic 路径不得二次编码：网关不该调用 engine.embeddings")


def _summary(**overrides) -> dict:
    base = {
        "total_samples": 4,
        "cluster_count": 2,
        "noise_count": 0,
        "invalid_count": 0,
        "duplicate_count": 0,
        "unique_count": 4,
        "coverage": 1.0,
        "noise_ratio": 0.0,
        "selected_k": 2,
        "final_k": 2,
        "auto_k_status": "ok",
        "largest_cluster_size": 2,
        "smallest_cluster_size": 2,
        "avg_cluster_size": 2.0,
        "quality_score": 0.8125,
        "weighted_quality_score": 0.8125,
        "overall_quality": 0.8125,
        "quality_version": "semantic-quality-v1",
        "confidence_version": "semantic-confidence-v1",
        "naming_version": "semantic-naming-v1",
        "normalization_version": "zh-shorttext-v1",
        "calibration_version": "semantic-calibration-v1",
        "calibration_status": "experimental",
        "effective_model_id": "bge-large-zh-v1.5",
        "device": "cpu",
        "seed": 42,
        "embedding_cache_hits": 4,
        "embedding_cache_misses": 0,
        "embedding_cache_hit_ratio": 1.0,
        "cache_only": True,
        "fallback_reason": None,
        "stage_timings": {"normalize_ms": 0.1, "auto_k_ms": 12.0},
        "visualization_sample_count": 4,
        "visualization_total_count": 4,
        "diagnostics": {"sampled_silhouette": None},
        "reduction": {"status": "disabled", "source_dim": 1024, "fit_dim": 1024, "reason": "below_min_samples"},
        "auto_k": {"status": "ok", "selected_k": 2, "candidates": []},
        "postprocess": {"merge_log": [], "split_log": [], "numbering": {0: 0, 1: 1}},
    }
    base.update(overrides)
    return base


def _cluster(cluster_id: int, name: str, **overrides) -> dict:
    base = {
        "cluster_id": cluster_id,
        "label": name,
        "cluster_name": name,
        "name_source": "representative_phrase",
        "name_evidence": f"{name}的原文依据",
        "naming_version": "semantic-naming-v1",
        "size": 2,
        "unique_size": 2,
        "percentage": 50.0,
        "keywords": ["脚手架", "连墙件"],
        "cohesion": 0.91,
        "separation": 0.83,
        "quality_score": 0.8,
        "quality_status": "evaluated",
        "quality_version": "semantic-quality-v1",
        "confidence_version": "semantic-confidence-v1",
        "distance_metric": "cosine",
        "representative_texts": [f"{name}的代表文本"],
        "representative_samples": [{"id": f"c{cluster_id}-1", "text": f"{name}的代表文本", "confidence": 0.9, "distance": 0.1}],
        "metadata_distribution": {"area": [{"value": "A区", "count": 2}]},
    }
    base.update(overrides)
    return base


def _semantic_payload() -> dict:
    return {
        "run_id": "run_fixture",
        "profile_id": SEMANTIC_PROFILE_ID,
        "algorithm": "semantic_auto_kmeans",
        "implementation_version": "semantic-v1",
        "n_samples": 4,
        "n_clusters": 2,
        "n_noise": 0,
        "assignments": [
            {"id": "i1", "cluster_id": 0},
            {"id": "i2", "cluster_id": 0},
            {"id": "i3", "cluster_id": 1},
            {"id": "i4", "cluster_id": 1},
        ],
        "warnings": ["SEMANTIC_CALIBRATION_EXPERIMENTAL", "EMBEDDING_CACHE_ONLY"],
        "elapsed_ms": 123,
        "semantic": {
            "summary": _summary(),
            "clusters": [
                _cluster(0, "脚手架连墙件缺失"),
                _cluster(1, "配电箱门未上锁"),
            ],
            "items": [
                {
                    "id": f"i{index}",
                    "text": f"第 {index} 条隐患描述文本",
                    "cluster_id": 0 if index <= 2 else 1,
                    "cluster_label": "脚手架连墙件缺失" if index <= 2 else "配电箱门未上锁",
                    "confidence": 0.88,
                    "distance": 0.12,
                    "keywords": [],
                    "metadata": {"area": "A区"},
                    "assignment_status": "core",
                    "noise_reason": None,
                    "confidence_version": "semantic-confidence-v1",
                    "distance_metric": "cosine",
                }
                for index in range(1, 5)
            ],
            "visualization": [
                {"id": f"i{index}", "x": 0.1 * index, "y": -0.2 * index, "cluster_id": 0 if index <= 2 else 1}
                for index in range(1, 5)
            ],
            "aggregate": {"macro_quality": 0.8125},
        },
    }


def _payload_for(items: list[dict]) -> dict:
    """按请求规模生成一份结构合法的语义载荷。

    4 条时用固定载荷（用例要断言具体数值）；其它规模走"单簇 + 全部 core"的最小构造——
    本模块断言的是**结构守恒与准入规则**，不是某个规模下的聚类结果，
    因此载荷必须与请求条数一致（网关的守恒断言会拦下不一致的载荷）。
    """

    if len(items) == 4:
        return _semantic_payload()

    total = len(items)
    ids = [str(item.get("id")) for item in items]
    texts = {str(item.get("id")): str(item.get("text")) for item in items}
    return {
        "run_id": "run_fixture",
        "profile_id": SEMANTIC_PROFILE_ID,
        "algorithm": "semantic_auto_kmeans",
        "implementation_version": "semantic-v1",
        "n_samples": total,
        "n_clusters": 1,
        "n_noise": 0,
        "assignments": [{"id": ident, "cluster_id": 0} for ident in ids],
        "warnings": ["SEMANTIC_CALIBRATION_EXPERIMENTAL"],
        "elapsed_ms": 7,
        "semantic": {
            "summary": _summary(
                total_samples=total,
                cluster_count=1,
                noise_count=0,
                unique_count=total,
                selected_k=1,
                final_k=1,
                auto_k_status="singleton" if total == 1 else "ok",
                largest_cluster_size=total,
                smallest_cluster_size=total,
                avg_cluster_size=float(total),
                embedding_cache_hits=0,
                embedding_cache_misses=total,
                embedding_cache_hit_ratio=0.0,
                cache_only=False,
                effective_model_id=None if total == 1 else "bge-large-zh-v1.5",
                visualization_sample_count=total,
                visualization_total_count=total,
            ),
            "clusters": [_cluster(0, "单一主题", size=total, unique_size=total, percentage=100.0)],
            "items": [
                {
                    "id": ident,
                    "text": texts.get(ident, ""),
                    "cluster_id": 0,
                    "cluster_label": "单一主题",
                    "confidence": 0.9,
                    "distance": 0.1,
                    "keywords": [],
                    "metadata": {},
                    "assignment_status": "core",
                    "noise_reason": None,
                    "confidence_version": "semantic-confidence-v1",
                    "distance_metric": "cosine",
                }
                for ident in ids
            ],
            "visualization": [{"id": ident, "x": 0.0, "y": 0.0, "cluster_id": 0} for ident in ids],
            "aggregate": {"macro_quality": 0.5},
        },
    }


@pytest.fixture
def service(monkeypatch):
    """真实 Catalog + 替身引擎：算法参数校验走真路径，但不碰本地模型。"""

    from retrain_cluster.config import Catalog, Settings as EngineSettings

    settings = get_settings()
    engine_settings = EngineSettings.load(str(settings.engine_config_path))
    gateway = ClusteringGatewayService(settings)
    monkeypatch.setattr(gateway, "_load_engine", lambda: None)
    # 模型校验被替换掉：本测试只关心契约映射，与"BGE 权重在不在本机"无关
    monkeypatch.setattr(gateway, "_profile_status", lambda profile: (True, None))
    gateway._catalog = Catalog(engine_settings)
    gateway._engine_settings = engine_settings
    gateway._engine = StubEngine(_payload_for)
    return gateway


def _items(count: int = 4) -> list[dict]:
    return [{"id": f"i{index}", "text": f"第 {index} 条隐患描述文本", "metadata": {"area": "A区"}} for index in range(1, count + 1)]


def test_semantic_payload_maps_onto_the_shared_contract(service):
    """引擎载荷必须能构造出 ClusteringData，且扩展字段原样保留。"""

    result = service.run({"items": _items(), "options": {"profile_id": SEMANTIC_PROFILE_ID}})
    data = ClusteringData(**result)  # 字段不符会在这里直接报错

    summary = data.summary
    assert summary.implementation_version == "semantic-v1"
    assert summary.calibration_version == "semantic-calibration-v1"
    assert summary.calibration_status == "experimental"
    assert summary.selected_k == 2 and summary.final_k == 2
    assert summary.quality_score == pytest.approx(0.8125)
    assert summary.unique_count == 4
    # 语义路径的 cache_hit 口径="本次没有新的向量推理"
    assert summary.cache_hit is True
    assert summary.cache_only is True
    assert summary.embedding_cache_hits == 4 and summary.embedding_cache_misses == 0
    assert summary.embedding_dimension == 1024  # 原始模型维度，而非降维后的拟合维度
    assert summary.gateway_ms >= 0

    # 兼容字段与旧前端一致：簇数/噪声/大小都取自引擎 summary
    assert summary.total_samples == 4
    assert summary.cluster_count == 2
    assert summary.noise_count == 0
    assert summary.avg_cluster_size == pytest.approx(2.0)

    first = data.clusters[0]
    assert first.cluster_name == "脚手架连墙件缺失"
    assert first.name_source == "representative_phrase"
    assert first.quality_score == pytest.approx(0.8)
    assert first.distance_metric == "cosine"

    assert data.items[0].assignment_status == "core"
    assert data.items[0].distance_metric == "cosine"
    assert len(data.visualization) == 4


def test_gateway_forwards_metadata_and_never_re_encodes(service):
    """metadata 必须传给引擎（元数据分布靠它），且网关不得二次编码。"""

    service.run({"items": _items(), "options": {"profile_id": SEMANTIC_PROFILE_ID}})
    engine = service._engine
    assert engine.embeddings_calls == 0
    assert len(engine.requests) == 1
    request = engine.requests[0]["request"]
    assert request["profile_id"] == SEMANTIC_PROFILE_ID
    assert request["items"][0]["metadata"] == {"area": "A区"}
    assert engine.requests[0]["enforce_api_limits"] is True


def test_single_item_is_allowed_for_semantic_but_rejected_for_legacy(service):
    """准入规则按实现版本分支：semantic 放行单条，legacy 仍然要求 ≥2 条。"""

    result = service.run({"items": _items(1), "options": {"profile_id": SEMANTIC_PROFILE_ID}})
    assert result["summary"]["total_samples"] == 1  # 单条确实走到了引擎
    assert result["summary"]["auto_k_status"] == "singleton"

    legacy_id = next(
        profile.profile_id
        for profile in service._catalog.profiles.values()
        if profile.implementation_version == "legacy-v1"
    )
    with pytest.raises(InvalidInputError):
        service.run({"items": _items(1), "options": {"profile_id": legacy_id}})


def test_engine_failure_keeps_its_error_code(service):
    """引擎错误码与建议状态码必须原样透出，不能被兜底成 CLUSTERING_FAILED。"""

    from retrain_cluster.errors import ClusterError

    class FailingEngine:
        def cluster(self, request, *, enforce_api_limits=False):
            raise ClusterError("MODEL_UNAVAILABLE", "model missing", 503)

    service._engine = FailingEngine()
    with pytest.raises(ClusterGatewayError) as error:
        service.run({"items": _items(), "options": {"profile_id": SEMANTIC_PROFILE_ID}})
    assert error.value.code == "MODEL_UNAVAILABLE"
    assert error.value.status == 503


def test_item_count_upper_bound_is_enforced_before_loading_the_engine(service):
    """超上限请求不应先付出引擎加载的代价，也永远不该走到引擎。"""

    from app.core.constants import MAX_ITEMS
    from app.core.errors import TooManyItemsError

    huge = [{"id": f"i{index}", "text": "x"} for index in range(MAX_ITEMS + 1)]
    with pytest.raises(TooManyItemsError):
        service.run({"items": huge, "options": {}})
    assert service._engine.requests == []


def test_capability_comes_from_the_strategy_registry():
    """能力表由引擎的 Strategy 注册表派生，网关不自己发明能力定义。"""

    semantic = _capability_of("semantic-v1")
    assert semantic["supports_single_item"] is True
    assert semantic["supports_cache_only"] is True

    legacy = _capability_of("legacy-v1")
    assert legacy["supports_single_item"] is False
    assert legacy["supports_cache_only"] is False

    # 未登记的版本按最保守处理，绝不默认"支持单条"
    unknown = _capability_of("future-v9")
    assert unknown["supports_single_item"] is False


def test_profile_contract_exposes_calibration_and_capability():
    """ProfileInfo 的两个新字段可序列化，且默认值让旧调用方不受影响。"""

    info = ProfileInfo(
        profile_id="p",
        algorithm="agglomerative",
        model_id="m",
        implementation_version="legacy-v1",
        max_samples=100,
        available=True,
    )
    assert info.calibration_id is None
    assert info.capability is None
    assert info.model_dump(by_alias=True)["implementationVersion"] == "legacy-v1"

    with pytest.raises(ValidationError):
        ProfileInfo(
            profile_id="p",
            algorithm="a",
            model_id="m",
            implementation_version="legacy-v1",
            max_samples=1,
            available=True,
            capability={"implementation_version": "legacy-v1", "supports_single_item": "not-a-bool"},
        )
