import json
import pytest
from fastapi.testclient import TestClient
from retrain_cluster.api.app import create_app
from retrain_cluster.clustering import API_ALGORITHMS
from retrain_cluster.config import Settings
from retrain_cluster.services.clustering import ClusteringService
from retrain_cluster.errors import ClusterError
from tests.conftest import ALGORITHM_CASES, FixedRegistry


class InlineExecutor:
    def __init__(self, service):
        self.service, self.error = service, None

    def start(self):
        pass

    def close(self):
        pass

    def ready(self):
        return True

    def execute(self, body):
        if self.error:
            raise self.error
        return self.service.cluster(body, enforce_api_limits=True)


@pytest.fixture
def api(settings):
    service = ClusteringService(settings, encoders=FixedRegistry())
    executor = InlineExecutor(service)
    with TestClient(create_app(settings=settings, executor=executor)) as client:
        yield client, executor


def body():
    return {"profile_id": "fixture", "items": [{"id": "a", "text": "identical"}, {"id": "b", "text": "identical"}]}


def test_success_location_result_and_health(api):
    client, _ = api
    response = client.post("/api/v1/clusterings", json=body())
    assert response.status_code == 201, response.text
    assert response.json()["n_samples"] == 2
    assert "ari" not in response.json()
    assert client.get(response.headers["Location"]).json() == response.json()
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200
    # 算法清单长度从注册表派生：写死常量会让"新增一个 API 算法"变成一次无声的测试失败
    assert len(client.get("/api/v1/algorithms").json()["algorithms"]) == len(API_ALGORITHMS)
    assert client.get("/api/v1/clusterings/missing").status_code == 404
    assert response.headers["x-request-id"]


@pytest.mark.parametrize("change", ["duplicate_id", "blank", "one", "too_many", "long", "extra"])
def test_request_validation(api, change):
    client, _ = api
    request = body()
    if change == "duplicate_id":
        request["items"][1]["id"] = "a"
    if change == "blank":
        request["items"][0]["text"] = "  "
    if change == "one":
        request["items"] = request["items"][:1]
    if change == "too_many":
        request["items"] = [{"id": str(i), "text": "x"} for i in range(501)]
    if change == "long":
        request["items"][0]["text"] = "x" * 4001
    if change == "extra":
        request["algorithm_params"] = {"eps": 0.1}
    response = client.post("/api/v1/clusterings", json=request)
    assert response.status_code == 422
    assert response.json()["error"]["request_id"]


def test_missing_profile_and_body_limit(api, settings):
    client, _ = api
    request = body()
    request["profile_id"] = "missing"
    assert client.post("/api/v1/clusterings", json=request).status_code == 404

    # 体积上限从配置派生，而不是写死 2 MiB：生产默认已是 200 MiB，
    # 写死字节数会让这条断言随配置变更悄悄失去意义（既可能失效，也可能变成 200 MB 上传）。
    # 这里用 Settings.load 的 overrides 派生一份"上限很小"的配置，代价只有几百字节。
    tiny = Settings.load(settings.config_path, overrides={"max_body_bytes": 1024})
    small_client = TestClient(
        create_app(settings=tiny, executor=InlineExecutor(ClusteringService(tiny, encoders=FixedRegistry())))
    )
    with small_client as small:
        response = small.post("/api/v1/clusterings", content=b" " * 2048)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"


@pytest.mark.parametrize("status", [422, 429, 500, 502, 503, 504])
def test_error_mapping(api, status):
    client, executor = api
    executor.error = ClusterError("TEST_FAILURE", "sanitized", status)
    response = client.post("/api/v1/clusterings", json=body())
    assert response.status_code == status and response.json()["error"]["code"] == "TEST_FAILURE"


@pytest.mark.parametrize("algorithm,params", [c for c in ALGORITHM_CASES if c[0] != "mean_shift"])
@pytest.mark.parametrize("k", [0, 3])
def test_all_ten_algorithms_both_modes_via_api(settings, arrays, algorithm, params, k):
    from tests.conftest import ExactNeighbors

    _, _, db = arrays
    profile_path = settings.profiles_dir / "fixture.json"
    profile = json.loads(profile_path.read_text())
    profile.update(algorithm=algorithm, algorithm_params=params, knowledge_base_id="fixture" if k else None)
    profile["features"] = {
        "n_results": k,
        "beta": 0.37,
        "pca_dim": 0,
        "version": "legacy-radbscan-v1" if algorithm == "radbscan" else "legacy-v1",
    }
    profile_path.write_text(json.dumps(profile))
    service = ClusteringService(settings, encoders=FixedRegistry(), retriever_factory=lambda *args: ExactNeighbors(db))
    request = {"profile_id": "fixture", "items": [{"id": str(i), "text": "record " + str(i)} for i in range(24)]}
    with TestClient(create_app(settings=settings, executor=InlineExecutor(service))) as client:
        response = client.post("/api/v1/clusterings", json=request)
        assert response.status_code == 201, response.text
        assert len(response.json()["assignments"]) == 24
        assert [item["id"] for item in response.json()["assignments"]] == [str(i) for i in range(24)]
        if algorithm == "chinese_whispers":
            assert "LEGACY_CW_LABEL_MAPPING" in response.json()["warnings"]
