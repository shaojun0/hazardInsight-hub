"""Run records are versioned, atomic and integrity checked."""

import json
from pathlib import Path
import pytest
from retrain_cluster.artifacts.runs import RunStore, atomic_json
from retrain_cluster.errors import ClusterError

RUN_ID = "run_" + "ab" * 16


def write(directory, **files):
    for name, payload in files.items():
        (directory / name).write_text(json.dumps(payload) if not isinstance(payload, str) else payload)


def test_atomic_json_creates_parents_and_leaves_no_temp_files():
    target = Path(__import__("tempfile").mkdtemp()) / "nested" / "out.json"
    atomic_json(target, {"answer": 42})
    assert json.loads(target.read_text()) == {"answer": 42}
    assert not list(target.parent.glob(".pending-*"))


def test_atomic_json_rejects_non_finite_numbers():
    import tempfile

    target = Path(tempfile.mkdtemp()) / "nan.json"
    with pytest.raises(ValueError):
        atomic_json(target, {"value": float("nan")})


def test_run_id_format_is_enforced():
    store = RunStore(Path(__file__).parent)
    for bad in ["nope", "run_short", "run_" + "z" * 32]:
        with pytest.raises(ClusterError, match="Result not found"):
            store.get(bad)


def test_save_and_get_roundtrip(tmp_path):
    store = RunStore(tmp_path)
    store.save({"run_id": RUN_ID, "labels": [0, 1]}, {"kind": "unit"})
    assert store.get(RUN_ID)["labels"] == [0, 1]
    manifest = json.loads((tmp_path / RUN_ID / "manifest.json").read_text())
    assert manifest["status"] == "completed" and manifest["result_sha256"]


def test_missing_run_is_reported_as_not_found(tmp_path):
    with pytest.raises(ClusterError, match="Result not found"):
        RunStore(tmp_path).get(RUN_ID)


def test_tampered_result_fails_integrity(tmp_path):
    store = RunStore(tmp_path)
    store.save({"run_id": RUN_ID, "labels": [0, 1]}, {"kind": "unit"})
    (tmp_path / RUN_ID / "result.json").write_text('{"labels": [9, 9, 9]}')
    with pytest.raises(ClusterError, match="integrity check failed"):
        store.get(RUN_ID)


def test_unfinished_run_is_not_readable(tmp_path):
    store = RunStore(tmp_path)
    store.save({"run_id": RUN_ID}, {"kind": "unit"})
    manifest = tmp_path / RUN_ID / "manifest.json"
    write(tmp_path / RUN_ID, **{"manifest.json": {**json.loads(manifest.read_text()), "status": "running"}})
    with pytest.raises(ClusterError, match="integrity check failed"):
        store.get(RUN_ID)


def test_corrupt_manifest_is_not_readable(tmp_path):
    store = RunStore(tmp_path)
    store.save({"run_id": RUN_ID}, {"kind": "unit"})
    write(tmp_path / RUN_ID, **{"manifest.json": "{not json"})
    with pytest.raises(ClusterError, match="integrity check failed"):
        store.get(RUN_ID)


def test_resave_refuses_to_overwrite_an_existing_run(tmp_path):
    store = RunStore(tmp_path)
    store.save({"run_id": RUN_ID}, {"kind": "unit"})
    with pytest.raises(FileExistsError):
        store.save({"run_id": RUN_ID}, {"kind": "unit"})
