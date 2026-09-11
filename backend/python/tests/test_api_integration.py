"""端到端接口测试（需要真实本地向量模型与 torch，默认跳过）。

运行方式：

```bash
cd backend/python
.venv/Scripts/python -m pytest -m integration
```

覆盖内容：健康检查就绪、profile/算法清单、示例数据加载、以及用真实
cluster-engine 跑通一次 `POST /api/clustering/run`（含二维坐标与簇摘要）。
这些断言只在装有本地模型的环境里有意义，因此与单元测试分开。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def client() -> TestClient:
    """构建应用并预热引擎（模块级复用，避免重复加载 1.3GB 模型）。"""

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def test_health_reports_engine_loaded(client: TestClient):
    """健康检查完成统一包裹，并报告引擎已加载。"""

    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["status"] == body["data"]["status"]
    assert body["data"]["engine"]["loaded"] is True
    assert body["data"]["engine"]["profilesAvailable"] >= 1


def test_health_is_also_mounted_under_clustering_prefix(client: TestClient):
    """前端只需要一条代理规则，因此健康检查在 /api/clustering 下也可见。"""

    response = client.get("/api/clustering/health")

    assert response.status_code == 200
    assert response.json()["data"]["service"]


def test_sample_endpoint_returns_items(client: TestClient):
    """内置示例数据接口可直接驱动「一键聚类」。"""

    body = client.get("/api/clustering/sample").json()

    assert body["success"] is True
    assert len(body["data"]["items"]) >= 2


def test_profiles_and_algorithms_are_listed(client: TestClient):
    """profile 与算法清单都返回 camelCase 字段，且至少各有一个可用项。"""

    profiles = client.get("/api/clustering/profiles").json()["data"]["profiles"]
    algorithms = client.get("/api/clustering/algorithms").json()["data"]["algorithms"]

    assert profiles and algorithms
    assert any(profile["available"] for profile in profiles)
    assert any(item["available"] for item in algorithms)
    assert {"profileId", "algorithm", "modelId", "maxSamples"} <= set(profiles[0])


def test_run_returns_clusters_visualization_and_digest(client: TestClient):
    """真实跑一次聚类，验证统计、簇摘要、逐条归属与二维坐标都已加工就绪。"""

    items = client.get("/api/clustering/sample").json()["data"]["items"]
    response = client.post(
        "/api/clustering/run",
        json={"items": items, "options": {"visualize": True, "reduceMethod": "pca"}},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    summary = data["summary"]

    assert summary["totalSamples"] == len(items)
    assert summary["algorithm"]
    assert summary["runId"]
    assert summary["embeddingDimension"] >= 2

    assert data["clusters"], "至少应返回一个簇"
    assert len(data["items"]) == len(items)
    assert len(data["visualization"]) == len(items)

    for point in data["visualization"]:
        assert {"id", "x", "y", "clusterId"} <= set(point)

    clustered = [cluster for cluster in data["clusters"] if cluster["clusterId"] >= 0]
    assert clustered, "样本应产生至少一个非噪声簇"
    assert sum(cluster["size"] for cluster in data["clusters"]) == len(items)

    first = clustered[0]
    assert first["representativeSamples"], "簇应带代表样本，供页面展示"
    assert first["keywords"], "簇应带关键词"


def test_run_rejects_too_few_items(client: TestClient):
    """契约层就拦住样本过少的请求。"""

    response = client.post("/api/clustering/run", json={"items": [{"id": "a", "text": "只有一条"}]})

    assert response.status_code == 422
    assert response.json()["success"] is False


def test_upload_rejects_unsupported_file_type(client: TestClient):
    """上传白名单之外的文件返回统一错误结构。"""

    response = client.post(
        "/api/clustering/datasets",
        files={"file": ("report.pdf", b"%PDF-1.4", "application/pdf")},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "UNSUPPORTED_FILE"


def test_upload_parses_csv(client: TestClient):
    """上传 CSV 能解析出样本与元数据。"""

    csv_bytes = "隐患单号,隐患描述,隐患级别\nHZ-1,未设置警戒围栏,A\nHZ-2,缺少连墙件,B\n".encode("utf-8")

    response = client.post(
        "/api/clustering/datasets",
        files={"file": ("hazards.csv", csv_bytes, "text/csv")},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["total"] == 2
    assert data["items"][0]["metadata"]["隐患级别"] == "A"
