"""Regression tests for small semantic batches and genuine noise rejection."""

import numpy as np
import pytest
from threadpoolctl import threadpool_limits

from retrain_cluster.clustering.auto_k import run_auto_k
from retrain_cluster.clustering.postprocess import protect_small_clusters
from retrain_cluster.clustering.semantic_auto import recompute_centers
from retrain_cluster.features.semantic import build_semantic_space


@pytest.fixture(autouse=True)
def bounded_threads():
    with threadpool_limits(limits=1):
        yield


def topic_vectors(groups=10, members=5, similarity=0.65):
    """Distinct phrasing within a topic: pair similarity below centroid similarity."""
    n = groups * members
    x = np.zeros((n, groups + n), dtype=np.float32)
    for i in range(n):
        x[i, i // members] = np.sqrt(similarity)
        x[i, groups + i] = np.sqrt(1 - similarity)
    return x


def cluster(x):
    return run_auto_k(
        build_semantic_space(x),
        unique_keys=[f"text-{i}" for i in range(len(x))],
        t_sem=0.8, t_pair=0.5, t_single=0.85, t_merge=0.88,
        max_iter=30, batch_size=64,
    )


def test_fifty_rows_with_multiple_topics_are_not_all_noise():
    x = topic_vectors()
    result = cluster(x)
    labels = result["labels"]
    assert result["final_k"] >= 2
    assert np.count_nonzero(labels >= 0) >= 25
    for label in set(labels) - {-1}:
        # Reject a fix that merely forces unrelated topics into arbitrary groups.
        assert len(set(np.flatnonzero(labels == label) // 5)) == 1
        expected = x[labels == label].mean(axis=0)
        expected /= np.linalg.norm(expected)
        np.testing.assert_allclose(result["centers"][label], expected, atol=1e-6)
    np.testing.assert_array_equal(cluster(x)["labels"], labels)


def test_unrelated_rows_still_return_all_noise():
    result = cluster(np.eye(50, dtype=np.float32))
    assert result["final_k"] == 0
    assert np.all(result["labels"] == -1)


def test_coherent_single_topic_does_not_crash():
    result = cluster(topic_vectors(groups=1, members=12, similarity=0.95))
    assert result["final_k"] == 1
    assert np.all(result["labels"] == 0)


def test_pair_evidence_uses_pair_threshold_for_three_member_cluster():
    space = build_semantic_space(topic_vectors(groups=1, members=3))
    labels = np.zeros(3, dtype=np.int32)
    centers, _ = recompute_centers(space.sem, labels, 1)
    kept, log = protect_small_clusters(
        space, labels, centers, keys=["a", "b", "c"], frequencies=[1, 1, 1],
        t_sem=0.8, t_pair=0.5, t_merge=0.88,
    )
    assert np.all(kept == 0)
    assert log[0]["action"] == "keep_small_coherent"
