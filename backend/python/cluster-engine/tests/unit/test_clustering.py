"""Clustering registry: algorithm discovery, backend policy and parameter contracts."""

import pytest
from retrain_cluster.clustering import (
    ALGORITHMS,
    API_ALGORITHMS,
    SEMANTIC_ALGORITHMS,
    WARNINGS,
    available,
    get_clusterer,
    validate_params,
)
from retrain_cluster.errors import ClusterError
from retrain_cluster.optimization.search_spaces import SPACES

AGG = {"distance_threshold": 0.5}


def test_search_spaces_cover_every_legacy_algorithm():
    """optuna 搜索空间必须覆盖全部 legacy 算法。

    semantic-v1 刻意**不在**其中：它的决策阈值（t_sem / t_pair / …）必须来自
    校准文件，不允许写进 profile，而调优产物最终要落成 profile 参数——
    因此给它一个搜索空间会和 ``validate_semantic_params`` 直接冲突。
    这条断言同时守住"新增 legacy 算法忘了加搜索空间"这个老问题。
    """

    assert set(SPACES) == set(ALGORITHMS) - set(SEMANTIC_ALGORITHMS)


def test_mean_shift_is_cli_only():
    assert "mean_shift" in ALGORITHMS
    assert "mean_shift" not in API_ALGORITHMS
    assert len(API_ALGORITHMS) == len(ALGORITHMS) - 1


def test_warnings_only_cover_known_algorithms():
    """WARNINGS 的键必须都注册过算法，且当前集合是有意为之。

    前半句防的是"改了算法名忘了改告警"（会静默丢失告警）；
    后半句让新增告警必须显式改这里，避免顺手加了一条没人知道的提示。
    """

    assert set(WARNINGS) <= set(ALGORITHMS)
    assert set(WARNINGS) == {"chinese_whispers", "semantic_auto_kmeans"}


def test_unknown_algorithm_is_unavailable():
    assert not available("bayesian_magic")
    with pytest.raises(ClusterError, match="Algorithm dependencies"):
        get_clusterer("bayesian_magic")


def test_non_python_backend_is_rejected():
    with pytest.raises(ClusterError, match="frozen Python backend"):
        get_clusterer("agglomerative", backend="native")


def test_valid_parameters_resolve_to_a_callable():
    assert callable(validate_params("agglomerative", AGG))


@pytest.mark.parametrize(
    "params",
    [
        {"unknown_param": 1},
        {"distance_threshold": 0},
        {"distance_threshold": -0.5},
        {"distance_threshold": float("nan")},
        {"distance_threshold": True},
    ],
)
def test_invalid_parameter_values_are_rejected(params):
    with pytest.raises(ClusterError) as caught:
        validate_params("agglomerative", params)
    assert caught.value.payload("x")["error"]["code"] == "INVALID_PROFILE"


@pytest.mark.parametrize("damping", [0.2, 1.0, 0.5 - 1e-9])
def test_damping_must_stay_in_the_supported_range(damping):
    with pytest.raises(ClusterError, match="execution contract"):
        validate_params("affinity_propagation", {"damping": damping})
    assert callable(validate_params("affinity_propagation", {"damping": 0.7}))


def test_canopy_requires_t1_greater_than_t2():
    with pytest.raises(ClusterError, match="execution contract"):
        validate_params("canopy", {"t1": 0.5, "t2": 0.5})
    with pytest.raises(ClusterError, match="execution contract"):
        validate_params("canopy", {"t1": 0.3, "t2": 0.5})
    assert callable(validate_params("canopy", {"t1": 0.8, "t2": 0.4}))


@pytest.mark.parametrize("algorithm,params", [("canopy", {"t1": 2.0, "t2": 1.0}), ("leader", {"threshold": 1.0})])
def test_metric_is_restricted_to_supported_names(algorithm, params):
    with pytest.raises(ClusterError, match="execution contract"):
        validate_params(algorithm, {**params, "metric": "chebyshev"})
    assert callable(validate_params(algorithm, {**params, "metric": "cosine"}))


def test_kernel_parameters_that_are_missing_are_rejected():
    with pytest.raises(ClusterError, match="incomplete or invalid"):
        validate_params("dbscan", {"eps": 0.5, "min_samples": 2, "metric": "chebyshev"})
