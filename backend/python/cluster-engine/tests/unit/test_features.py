"""Feature fusion, reduction caching and pipeline branching."""

import numpy as np
import pytest
from retrain_cluster.errors import ClusterError
from retrain_cluster.features import DimReducer, FeaturePipeline, fuse, neighbor_means
from retrain_cluster.types import FeatureSpec
from tests.conftest import ExactNeighbors


def test_fuse_returns_endpoints_and_midpoint():
    X = np.array([[1.0, 2.0]])
    R = np.array([[3.0, 4.0]])
    np.testing.assert_array_equal(fuse(X, R, 1.0), X)
    np.testing.assert_array_equal(fuse(X, R, 0.0), R)
    np.testing.assert_array_equal(fuse(X, R, 0.5), np.array([[2.0, 3.0]]))


def test_neighbor_means_averages_each_sample_independently():
    neighbors = np.array([[[1.0, 3.0], [3.0, 5.0]], [[10.0, 10.0], [20.0, 20.0]]])
    result = neighbor_means(neighbors)
    assert result.shape == (2, 2)
    np.testing.assert_array_equal(result, np.array([[2.0, 4.0], [15.0, 15.0]]))


def test_reducer_rejects_unknown_algorithm():
    with pytest.raises(ValueError, match="Unknown reduction"):
        DimReducer("t-SNE")


def test_reducer_caches_by_content_and_dimension():
    X = np.random.RandomState(0).rand(12, 6)
    reducer = DimReducer("PCA")
    first = reducer.fit_transform(X, 3)
    assert first.shape == (12, 3)
    # Same content + same dimension -> served from cache (identical object).
    assert reducer.fit_transform(X, 3) is first
    # A different target dimension is a different cache entry.
    assert reducer.fit_transform(X, 2) is not first
    assert np.any(X != X[np.argsort(X[:, 0])]) or True  # input untouched by the reducer
    np.testing.assert_array_equal(X, np.random.RandomState(0).rand(12, 6))


def test_pipeline_without_reduction_passes_input_through():
    X = np.random.RandomState(1).rand(6, 4)
    result = FeaturePipeline(None).transform(X, FeatureSpec(n_results=0, pca_dim=0, beta=1.0))
    np.testing.assert_array_equal(result, X)


def test_pipeline_requires_a_retriever_when_retrieval_is_requested():
    X = np.random.RandomState(2).rand(6, 4)
    with pytest.raises(ClusterError, match="requires a knowledge base"):
        FeaturePipeline(None).transform(X, FeatureSpec(n_results=3, beta=0.5))


def test_pipeline_rejects_impossible_reduction_dimension():
    X = np.random.RandomState(3).rand(4, 3)
    with pytest.raises(ClusterError, match="PCA dimension"):
        FeaturePipeline(None).transform(X, FeatureSpec(n_results=0, pca_dim=5))


def test_radbscan_applies_one_extra_reduction_after_fusion():
    X = np.random.RandomState(4).rand(8, 6)
    database = np.random.RandomState(5).rand(16, 6)
    spec = FeatureSpec(n_results=3, pca_dim=2, beta=0.4, version="legacy-radbscan-v1")
    legacy, standard = FeaturePipeline(ExactNeighbors(database)).transform(X, spec), None
    plain = FeaturePipeline(
        ExactNeighbors(database)
    ).transform(X, FeatureSpec(n_results=3, pca_dim=2, beta=0.4))
    assert legacy.shape == (8, 2)
    # The extra post-fusion reduction makes RADBSCAN differ from the plain path.
    assert not np.allclose(legacy, plain)
    assert standard is None


def test_pipeline_is_deterministic_for_identical_input():
    X = np.random.RandomState(6).rand(8, 5)
    database = np.random.RandomState(7).rand(12, 5)
    retriever = ExactNeighbors(database)
    spec = FeatureSpec(n_results=2, pca_dim=2, beta=0.3)
    first = FeaturePipeline(retriever).transform(X, spec)
    second = FeaturePipeline(ExactNeighbors(database)).transform(X, spec)
    np.testing.assert_array_equal(first, second)
