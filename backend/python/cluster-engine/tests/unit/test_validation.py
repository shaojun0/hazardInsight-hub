"""Input validation boundaries."""

import numpy as np
import pytest
from retrain_cluster.data import validate_items, validate_matrix
from retrain_cluster.errors import ClusterError


def ok(matrix, **kwargs):
    return validate_matrix(matrix, **kwargs)


def test_matrix_rejects_bad_shapes_and_types():
    for bad in [np.zeros(4), np.zeros((2, 2, 2))]:
        with pytest.raises(ClusterError, match="finite numeric matrix"):
            ok(bad)
    with pytest.raises(ClusterError, match="finite numeric matrix"):
        ok(np.array([["a", "b"], ["c", "d"]]))
    with pytest.raises(ClusterError, match="finite numeric matrix"):
        ok(np.array([[1.0, np.nan]]))


def test_matrix_checks_row_count_and_dimension():
    values = np.zeros((3, 4))
    with pytest.raises(ClusterError, match="row count"):
        ok(values, rows=2)
    with pytest.raises(ClusterError, match="dimension"):
        ok(values, dimension=2)
    assert ok(values, rows=3, dimension=4).shape == (3, 4)


def test_items_require_unique_present_ids():
    items = [{"id": "a", "text": "x"}, {"id": "b", "text": "y"}]
    assert validate_items(items) is None
    with pytest.raises(ClusterError, match="Sample count"):
        validate_items(items[:1], minimum=2)
    with pytest.raises(ClusterError, match="Sample count"):
        validate_items(items, maximum=1)
    with pytest.raises(ClusterError, match="unique"):
        validate_items([{"id": "a", "text": "x"}, {"id": "a", "text": "y"}])


@pytest.mark.parametrize("bad", ["", "   ", None, 42])
def test_items_reject_blank_or_non_string_text(bad):
    with pytest.raises(ClusterError, match="Blank text"):
        validate_items([{"id": "a", "text": bad}, {"id": "b", "text": "y"}])
