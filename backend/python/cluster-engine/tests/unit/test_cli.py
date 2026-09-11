"""Command level behaviour of the retrain-cluster CLI."""

import json
import pytest
from retrain_cluster.cli import main


@pytest.fixture
def config(settings):
    return str(settings.config_path)


def test_profiles_lists_the_configured_profiles(config, capsys):
    assert main(["--config", config, "profiles"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert [item["profile_id"] for item in payload] == ["fixture"]
    assert payload[0]["algorithm"] == "agglomerative"


def test_unknown_command_exits_with_argparse_error(config):
    with pytest.raises(SystemExit) as caught:
        main(["--config", config, "not-a-command"])
    assert caught.value.code == 2


def test_required_subcommand_is_missing(config):
    with pytest.raises(SystemExit) as caught:
        main(["--config", config])
    assert caught.value.code == 2


def test_cluster_reports_profile_errors_as_json_on_stderr(config, tmp_path, capsys):
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({"profile_id": "missing", "items": [{"id": "a", "text": "x"}, {"id": "b", "text": "y"}]}),
        encoding="utf-8",
    )
    assert main(["--config", config, "cluster", "--input", str(request)]) == 1
    error = json.loads(capsys.readouterr().err)["error"]
    assert error["code"] == "PROFILE_NOT_FOUND"
    assert error["request_id"]


def test_cluster_writes_the_output_file(config, tmp_path, monkeypatch):
    import numpy as np

    class FakeService:
        def __init__(self, settings):
            self.settings = settings

        def cluster(self, request):
            return {"run_id": "run_" + "0" * 32, "profile_id": request["profile_id"], "n_samples": 2}

    # cli.py imports the service lazily inside the command; patch it at its source.
    monkeypatch.setattr("retrain_cluster.services.clustering.ClusteringService", FakeService)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"profile_id": "fixture", "items": [{"id": "a", "text": np.str_("x")}]}))
    destination = tmp_path / "out.json"
    assert main(["--config", config, "cluster", "--input", str(request), "--output", str(destination)]) == 0
    assert json.loads(destination.read_text())["run_id"].startswith("run_")


def test_model_manifest_hashes_a_directory(tmp_path):
    source = tmp_path / "model"
    source.mkdir()
    (source / "config.json").write_text("{}", encoding="utf-8")
    (source / "nested").mkdir()
    (source / "nested" / "weight.bin").write_bytes(b"abc")
    destination = tmp_path / "manifest.json"

    assert main(["model-manifest", "--directory", str(source), "--output", str(destination)]) == 0
    payload = json.loads(destination.read_text())
    assert payload["required_files"] == ["config.json", "nested/weight.bin"]
    assert set(payload["file_checksums"]) == set(payload["required_files"])


def test_model_manifest_rejects_an_empty_directory(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="empty"):
        main(["model-manifest", "--directory", str(empty), "--output", str(tmp_path / "m.json")])
