"""ExperimentService orchestration: artifact layout and failure recording.

The real ClusteringService is used with the fixed encoder double, and only Optuna is
faked, so this covers actual orchestration without any network or heavy dependency.
"""

import json
import numpy as np
import pytest
from retrain_cluster import errors
from retrain_cluster.services.clustering import ClusteringService
from retrain_cluster.services.experiments import ExperimentService
from retrain_cluster.types import TextDataset
from tests.conftest import ExactNeighbors, FixedRegistry

TEXTS = [f"sample text {i}" for i in range(8)]
LABELS = [0, 0, 1, 1, 0, 0, 1, 1]
RESOLVED = {"distance_threshold": 0.5, "beta": 1.0, "n_results": 0, "pca_dim": 0}


class FakeTrial:
    def __init__(self, number):
        self.number, self.value, self.state = number, 0.5, type("State", (), {"name": "COMPLETE"})
        self.params, self.user_attrs = {"distance_threshold": 0.5}, {"resolved_params": RESOLVED}


class FakeStudy:
    def __init__(self, trials=1):
        self.trials = [FakeTrial(i) for i in range(trials)]
        self.best_trial = self.trials[0]
        self.best_params = self.trials[0].params


def dataset():
    return TextDataset("unit", [str(i) for i in range(len(TEXTS))], TEXTS, np.array(LABELS))


@pytest.fixture
def service(settings, arrays, monkeypatch):
    _, _, db = arrays
    # The minimal settings fixture has no [experiment] section; paths are stubbed below anyway.
    settings.experiment = {
        **settings.experiment,
        "reference": "unit-stub",
        "test": "unit-stub",
        "n_trials": 1,
        "n_jobs": 1,
        "seed": 42,
        "startup_trials": 1,
    }
    real = ClusteringService
    monkeypatch.setattr(
        "retrain_cluster.services.experiments.ClusteringService",
        lambda cfg: real(cfg, encoders=FixedRegistry(), retriever_factory=lambda *a: ExactNeighbors(db)),
    )
    monkeypatch.setattr("retrain_cluster.services.experiments.load_reference", lambda _: dataset())
    monkeypatch.setattr("retrain_cluster.services.experiments.load_labels", lambda _: dataset())
    return ExperimentService(settings)


def test_run_writes_the_full_artifact_set(service, monkeypatch):
    monkeypatch.setattr("retrain_cluster.services.experiments.optimize", lambda *a, **k: FakeStudy(3))
    result = service.run("fixture", n_results=0, pca_dim=0, n_trials=2, n_jobs=1)
    run_id = result["run_id"]
    directory = service.settings.artifacts_dir / "runs" / run_id

    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["status"] == "completed" and manifest["kind"] == "experiment"
    assert manifest["baseline_kind"] == "current-environment"
    assert manifest["search"] == {"n_results": 0, "pca_dim": 0}
    assert "train" in manifest["embedding_fingerprints"] and "test" in manifest["embedding_fingerprints"]

    for name in ("profile.json", "best.json", "trials.json", "test.json"):
        assert (directory / name).is_file(), name
    best = json.loads((directory / "best.json").read_text())
    # Both sampled and resolved parameter sets are exported (E04).
    assert best["sampled_params"] == {"distance_threshold": 0.5}
    assert best["resolved_params"] == RESOLVED
    assert len(json.loads((directory / "trials.json").read_text())) == 3
    test = json.loads((directory / "test.json").read_text())
    assert len(test["labels"]) == len(TEXTS)
    assert result["test_metrics"] == test["metrics"]


def test_failure_records_status_and_reraises(service, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("optimizer died")

    monkeypatch.setattr("retrain_cluster.services.experiments.optimize", boom)
    with pytest.raises(RuntimeError, match="optimizer died"):
        service.run("fixture", n_results=0, pca_dim=0)

    directories = list((service.settings.artifacts_dir / "runs").glob("run_*"))
    assert len(directories) == 1
    manifest = json.loads((directories[0] / "manifest.json").read_text())
    assert manifest["status"] == "failed"
    assert "result.json" not in {p.name for p in directories[0].iterdir()}


def test_tune_rejects_unknown_profile(service):
    with pytest.raises(errors.ClusterError, match="Profile not found"):
        service.run("does-not-exist", n_results=0, pca_dim=0)
