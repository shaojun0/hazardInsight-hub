import json
import numpy as np
import pytest
from retrain_cluster.data.loaders import load_reference, load_labels, load_knowledge_texts
from retrain_cluster.artifacts.cache import EmbeddingCache
from retrain_cluster.artifacts.fingerprints import array_hash, file_hash
from retrain_cluster.errors import ClusterError


REFERENCE = {"焊缝裂纹": [1, 0, 0], "管道渗漏": [0, 1, 0], "电缆破损": [0, 0, 1], "阀门卡涩": [0, 1, 0]}
LABELS = {"焊缝缺陷": ["焊缝裂纹", "未熔合"], "渗漏缺陷": ["管道渗漏", "焊缝裂纹"]}
KNOWLEDGE = "焊缝裂纹处理\n\n管道渗漏处理\n"


def _write(path, payload):
    path.write_text(payload, encoding="utf-8")
    return path


def test_loaders_preserve_ordering_labels_and_text_boundaries(tmp_path):
    """Real inputs are no longer tracked, so the loader contract is pinned with synthetic copies.

    Semantics taken from the historical dataset: reference.json keys are unique texts mapped to a
    one-hot label vector, labels.json groups texts under label names (a text may appear twice), and
    database.txt keeps its trailing newline as one empty tail record.
    """
    ref = load_reference(_write(tmp_path / "reference.json", json.dumps(REFERENCE, ensure_ascii=False)))
    assert ref.texts == list(REFERENCE)
    np.testing.assert_array_equal(ref.labels, [np.argmax(v) for v in REFERENCE.values()])
    assert ref.labels.dtype == np.int32
    assert len(set(ref.sample_ids)) == len(ref.texts)
    assert ref.source_fingerprint == file_hash(tmp_path / "reference.json")

    test = load_labels(_write(tmp_path / "labels.json", json.dumps(LABELS, ensure_ascii=False)))
    assert test.texts == [t for cluster in LABELS.values() for t in cluster]
    np.testing.assert_array_equal(test.labels, [0, 0, 1, 1])
    assert test.label_names == {0: "焊缝缺陷", 1: "渗漏缺陷"}
    assert len(set(test.texts)) == 3  # "焊缝裂纹" is repeated across clusters
    assert set(ref.texts) & set(test.texts) == {"焊缝裂纹", "管道渗漏"}

    database = load_knowledge_texts(_write(tmp_path / "database.txt", KNOWLEDGE))
    assert database == ["焊缝裂纹处理", "", "管道渗漏处理", ""]
    assert sum(not x.strip() for x in database) == 2  # blank line plus trailing newline


def test_cache_models_text_boundaries_dtype_integrity(tmp_path):
    cache = EmbeddingCache(tmp_path)
    key = cache.key(["ab", "c"], "model1")
    assert key != cache.key(["a", "bc"], "model1")
    assert key != cache.key(["ab", "c"], "model2")
    values = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float64)
    assert array_hash(values) != array_hash(values.reshape(1, 4))
    assert array_hash(values) != array_hash(values.astype(np.float32))
    cache.save(key, values)
    actual = cache.load(key, rows=2, dimension=2)
    np.testing.assert_array_equal(actual, values)
    assert actual.dtype == values.dtype
    meta = json.loads((tmp_path / f"{key}.json").read_text())
    (tmp_path / meta["file"]).write_bytes(b"broken")
    with pytest.raises(ClusterError, match="integrity"):
        cache.load(key, rows=2, dimension=2)


def test_legacy_cache_unverified_and_half_written_data_ignored(tmp_path):
    path = tmp_path / "legacy.npy"
    np.save(path, np.ones((2, 3)))
    cache = EmbeddingCache(tmp_path / "new")
    cache.import_legacy("key", path)
    assert cache.load("key", rows=2, dimension=3) is None
    np.testing.assert_array_equal(cache.load("key", rows=2, dimension=3, allow_unverified=True), np.ones((2, 3)))
    np.save(cache.directory / "half.npy", np.ones((2, 3)))
    assert cache.load("half", rows=2, dimension=3) is None
