"""The package import graph must stay acyclic and lean."""

import subprocess
import sys
import pytest
from tests.conftest import ROOT

SUBPACKAGES = [
    "retrain_cluster",
    "retrain_cluster.api",
    "retrain_cluster.artifacts",
    "retrain_cluster.clustering",
    "retrain_cluster.data",
    "retrain_cluster.embeddings",
    "retrain_cluster.evaluation",
    "retrain_cluster.features",
    "retrain_cluster.optimization",
    "retrain_cluster.retrieval",
    "retrain_cluster.services",
]

HEAVY = ["fastapi", "chromadb", "torch", "transformers", "sentence_transformers", "openai", "hdbscan"]


@pytest.mark.parametrize("name", SUBPACKAGES)
def test_subpackage_imports_standalone(name):
    """Each subpackage is imported in a fresh interpreter.

    This is the check that surfaces circular imports: importing ``retrain_cluster.data``
    first reaches ``artifacts.cache`` -> ``data.validation`` -> back into partially
    initialized modules, which an in-process test would silently hide.
    """
    completed = subprocess.run([sys.executable, "-c", f"import {name}"], cwd=ROOT, capture_output=True, text=True)
    assert completed.returncode == 0, f"{name} failed to import:\n{completed.stderr}"


def test_top_level_import_stays_lean():
    code = (
        "import sys, retrain_cluster\n"
        f"loaded = [m for m in {HEAVY!r} if m in sys.modules]\n"
        "assert not loaded, loaded\n"
    )
    completed = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr


def test_declared_exports_resolve():
    import importlib

    import retrain_cluster

    assert retrain_cluster.__version__ == "0.2.0"
    unresolved = []
    for name in SUBPACKAGES[1:] + ["retrain_cluster"]:
        module = importlib.import_module(name)
        assert module.__all__, f"{name} declares no __all__"
        for symbol in module.__all__:
            try:
                getattr(module, symbol)
            except AttributeError:
                unresolved.append(f"{name}.{symbol}")
    assert not unresolved, f"unresolvable exports: {unresolved}"


def test_unknown_attribute_raises_attribute_error():
    from retrain_cluster import data

    with pytest.raises(AttributeError):
        data.definitely_not_an_export
