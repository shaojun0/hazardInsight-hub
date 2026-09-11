import json
import numpy as np
import pytest
from retrain_cluster.retrieval.build import build_knowledge_base
from retrain_cluster.retrieval.chroma import ChromaRetriever
from retrain_cluster.services.clustering import ClusteringService
from retrain_cluster.errors import ClusterError
from tests.conftest import FixedEncoder, FixedRegistry


def test_real_chroma_build_query_and_validation(tmp_path):
    texts = ["record " + str(i) for i in range(10)]
    source = tmp_path / "input.txt"
    source.write_text("\n".join(texts))
    root = tmp_path / "knowledge"
    meta = build_knowledge_base(root, "kb", texts, FixedEncoder(), "model", 8, source)
    assert meta["status"] == "completed" and meta["count"] == 10
    retriever = ChromaRetriever(root, "kb", "model", 8)
    assert np.asarray(retriever.query(FixedEncoder().encode(texts[:2]), 7).values).shape == (2, 7, 8)
    with pytest.raises(ClusterError):
        ChromaRetriever(root, "kb", "different-model", 8)
    with pytest.raises(ClusterError):
        retriever.query(FixedEncoder().encode(texts[:2]), 11)
    with pytest.raises(FileExistsError):
        build_knowledge_base(root, "kb", texts, FixedEncoder(), "model", 8, source)
    retriever.collection.delete(ids=retriever.collection.get()["ids"][:1])
    with pytest.raises(ClusterError):
        ChromaRetriever(root, "kb", "model", 8)


def test_service_result_cache_and_artifact_privacy(settings):
    service = ClusteringService(settings, encoders=FixedRegistry())
    body = {
        "profile_id": "fixture",
        "items": [
            {"id": "a", "text": "private original text"},
            {"id": "b", "text": "private original text"},
            {"id": "c", "text": "something else"},
        ],
    }
    first = service.cluster(body)
    second = service.cluster(body)
    assert first["assignments"] == second["assignments"]
    assert first["assignments"][0]["cluster_id"] == first["assignments"][1]["cluster_id"]
    assert service.runs.get(first["run_id"]) == first
    raw = (settings.artifacts_dir / "runs" / second["run_id"] / "manifest.json").read_text()
    assert json.loads(raw)["cache_hit"] is True
    assert "private original text" not in raw
    path = settings.artifacts_dir / "runs" / first["run_id"] / "result.json"
    path.write_text("{}")
    with pytest.raises(ClusterError):
        service.runs.get(first["run_id"])
