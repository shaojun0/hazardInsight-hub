"""内置示例数据与服务层解析测试。

这一层不加载 cluster-engine（因此无需 torch 与向量模型），只验证
「网关自己负责的那部分」：示例数据读取、上传文件规范化、ID 去重、清洗与警告。
"""

from __future__ import annotations

import json

import pytest

from app.core.errors import InvalidInputError, SampleDatasetError
from app.schemas.clustering import DatasetItem, DatasetPreview
from app.services.clustering_service import ClusteringGatewayService


@pytest.fixture()
def service() -> ClusteringGatewayService:
    """只构造网关服务，不触发引擎加载。"""

    return ClusteringGatewayService()


def test_sample_dataset_is_valid_and_unique(service: ClusteringGatewayService):
    """随项目分发的示例数据可直接用于聚类。"""

    payload = service.load_sample_dataset()

    assert payload["source_name"].startswith("示例数据")
    items = payload["items"]
    assert len(items) >= 2

    ids = [item["id"] for item in items]
    assert len(set(ids)) == len(ids), "示例数据存在重复 ID"

    for item in items:
        parsed = DatasetItem.model_validate(item)
        assert parsed.text.strip()
        assert parsed.metadata, "示例数据应带业务字段，便于在页面上展示元数据分布"


def test_sample_dataset_missing_file_raises(service: ClusteringGatewayService, monkeypatch: pytest.MonkeyPatch, tmp_path):
    """示例文件缺失时给出 404 语义的错误，而不是抛 FileNotFoundError。"""

    monkeypatch.setattr(
        type(service.settings),
        "sample_dataset_path",
        property(lambda _self: tmp_path / "missing.json"),
    )

    with pytest.raises(SampleDatasetError):
        service.load_sample_dataset()


def test_parse_dataset_dedupes_ids_and_truncates(service: ClusteringGatewayService):
    """重复 ID 自动去重、超长文本截断并给出警告。"""

    csv_bytes = (
        "隐患单号,隐患描述\n"
        "A,第一条描述\n"
        "A,第二条描述\n"
        f"B,{'超长描述' * 1500}\n"
    ).encode("utf-8")

    preview = service.parse_dataset(csv_bytes, "hazards.csv")

    ids = [item["id"] for item in preview["items"]]
    assert ids == ["A", "A#2", "B"]
    assert preview["total"] == 3
    assert any("已截断" in warning for warning in preview["warnings"])


def test_parse_dataset_skips_empty_text_and_warns(service: ClusteringGatewayService):
    """文本为空的记录被跳过，并且明确告知用户跳过了多少条。"""

    payload = json.dumps(
        [{"id": "a", "text": "有效描述"}, {"id": "b", "text": "   "}],
        ensure_ascii=False,
    ).encode("utf-8")

    preview = service.parse_dataset(payload, "data.json")

    assert [item["id"] for item in preview["items"]] == ["a"]
    assert any("已跳过" in warning for warning in preview["warnings"])


def test_parse_dataset_rejects_file_without_usable_text(service: ClusteringGatewayService):
    """全是空文本时抛 InvalidInputError（400），而不是返回空结果让前端困惑。"""

    payload = json.dumps([{"id": "a", "text": ""}]).encode("utf-8")

    with pytest.raises(InvalidInputError):
        service.parse_dataset(payload, "empty.json")


def test_parse_dataset_keeps_business_columns_as_metadata(service: ClusteringGatewayService):
    """业务列进入 metadata，供簇的元数据分布统计使用。"""

    csv_bytes = "隐患单号,隐患描述,隐患级别,作业区域\nHZ-1,未设置警戒围栏,A,核岛\n".encode("utf-8")

    preview = service.parse_dataset(csv_bytes, "hazards.csv")

    metadata = preview["items"][0]["metadata"]
    assert metadata == {"隐患级别": "A", "作业区域": "核岛"}


def test_parse_dataset_output_matches_response_contract(service: ClusteringGatewayService):
    """解析结果必须能直接被 `DatasetPreview` 接纳。

    路由层是 `DatasetPreview(**preview)`，一旦两边字段名或必填项不一致，
    上传接口就会在运行时抛 ValidationError（表现为 500）。这里把这条契约
    固定下来，避免以后改字段时忘掉另一边。
    """

    csv_bytes = "隐患单号,隐患描述,隐患级别\nHZ-1,未设置警戒围栏,A\nHZ-2,缺少连墙件,B\n".encode("utf-8")

    preview = service.parse_dataset(csv_bytes, "hazards.csv")
    parsed = DatasetPreview(**preview)

    assert parsed.total == 2
    assert parsed.source_name == "hazards.csv"
    assert [item.id for item in parsed.items] == ["HZ-1", "HZ-2"]


def test_internal_methods_are_not_shadowed_by_cache_attributes():
    """实例属性不能遮蔽同名方法。

    回归守卫：`_model_ready` 缓存字典曾与同名方法撞名，实例属性优先生效导致
    `self._model_ready(...)` 变成 "dict object is not callable"，所有 profile 被
    误判为不可用、健康检查直接 500。这里把命名约束固定下来。
    """

    service = ClusteringGatewayService()

    assert callable(service._model_ready)  # noqa: SLF001
    assert callable(service._profile_status)  # noqa: SLF001
    assert isinstance(service._model_ready_cache, dict)  # noqa: SLF001


def test_engine_status_reports_unavailable_when_dependencies_missing(service: ClusteringGatewayService, monkeypatch: pytest.MonkeyPatch):
    """引擎不可用时健康检查给出明确原因，而不是抛异常。"""

    service._engine_error = "聚类引擎加载失败：模拟的依赖缺失。"  # noqa: SLF001 - 测试需要构造该状态

    status = service.engine_status()

    assert status["loaded"] is False
    assert "依赖缺失" in status["message"]
