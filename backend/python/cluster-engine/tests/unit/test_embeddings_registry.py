"""Encoder registry: caching, dependency gates and error mapping.

Backend constructors are faked, so no torch / transformers / openai module is ever loaded.
"""

import types
import pytest
from retrain_cluster.embeddings import registry
from retrain_cluster.embeddings.base import Encoder
from retrain_cluster.embeddings.registry import PROVIDERS, EncoderRegistry, check_model
from retrain_cluster.errors import ClusterError


class FakeEncoder(Encoder):
    instances = 0

    def __init__(self, spec, boom=False):
        FakeEncoder.instances += 1
        if boom:
            raise RuntimeError("backend exploded")
        self.spec = spec

    def encode(self, texts):
        return [[0.0] * len(texts)]


@pytest.fixture
def patched(monkeypatch):
    """Point the registry at FakeEncoder, bypassing real dependency checks."""
    FakeEncoder.instances = 0
    monkeypatch.setattr(registry, "check_model", lambda spec: None)
    monkeypatch.setattr(registry, "PROVIDERS", {"fake": ("fake_module", "FakeEncoder", "fake_dep")})
    monkeypatch.setattr(registry, "import_module", lambda name: types.SimpleNamespace(FakeEncoder=FakeEncoder))
    return EncoderRegistry()


def test_instances_are_cached_per_fingerprint(patched):
    first = patched.get({"provider": "fake"}, "fingerprint-a")
    assert patched.get({"provider": "fake"}, "fingerprint-a") is first
    assert patched.get({"provider": "fake"}, "fingerprint-b") is not first
    assert FakeEncoder.instances == 2


def test_backend_construction_failure_is_mapped_to_503(monkeypatch):
    monkeypatch.setattr(registry, "check_model", lambda spec: None)
    monkeypatch.setattr(registry, "PROVIDERS", {"fake": ("fake_module", "FakeEncoder", "fake_dep")})

    def fake_import(name):
        def boom(spec):
            return FakeEncoder(spec, boom=True)

        return types.SimpleNamespace(FakeEncoder=boom)

    monkeypatch.setattr(registry, "import_module", fake_import)
    with pytest.raises(ClusterError, match="Model loading failed"):
        EncoderRegistry().get({"provider": "fake"}, "fp")


def test_error_from_check_model_propagates_unchanged(monkeypatch):
    def raiser(spec):
        raise ClusterError("MODEL_UNAVAILABLE", "credential missing", 503)

    monkeypatch.setattr(registry, "check_model", raiser)
    with pytest.raises(ClusterError) as caught:
        EncoderRegistry().get({"provider": "fake"}, "fp")
    assert caught.value.payload("x")["error"]["code"] == "MODEL_UNAVAILABLE"


def test_unknown_provider_is_unavailable():
    with pytest.raises(ClusterError, match="provider dependency is unavailable"):
        check_model({"provider": "totally-unknown"})


def test_missing_dependency_is_reported_as_unavailable(monkeypatch):
    monkeypatch.setattr(registry.util, "find_spec", lambda name: None)
    with pytest.raises(ClusterError, match="provider dependency is unavailable"):
        check_model({"provider": "sentence_transformer"})


def test_remote_provider_requires_a_credential(monkeypatch):
    monkeypatch.setattr(registry.util, "find_spec", lambda name: object())
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    with pytest.raises(ClusterError, match="credential is not configured"):
        check_model({"provider": "openai_compatible"})
    monkeypatch.setenv("EMBEDDING_API_KEY", "unit-test-key")
    check_model({"provider": "openai_compatible"})


def test_local_providers_go_through_the_model_manifest_check(monkeypatch):
    seen = []
    monkeypatch.setattr(registry.util, "find_spec", lambda name: object())
    monkeypatch.setattr(registry, "verify_local_model", lambda spec: seen.append(spec))
    spec = {"provider": "simcse", "source": "/somewhere"}
    check_model(spec)
    assert seen == [spec]


def test_every_registered_provider_points_at_a_real_symbol():
    import importlib

    for name, (module, attribute, dependency) in PROVIDERS.items():
        cls = getattr(importlib.import_module(f"retrain_cluster.embeddings.{module}"), attribute)
        assert issubclass(cls, Encoder), f"{name} -> {attribute} does not honour the Encoder Protocol"
        assert callable(getattr(cls, "encode"))
