"""Structured logging must stay free of payload data."""

import json
import logging
import pytest
from retrain_cluster.logging import configure_logging, event


def emitted(caplog):
    return json.loads(caplog.records[-1].getMessage())


@pytest.fixture
def captured(caplog):
    configure_logging()
    return caplog


def test_event_emits_stage_and_scalar_fields(captured):
    with captured.at_level(logging.INFO, logger="retrain_cluster"):
        event("completed", run_id="run_x", n_samples=12, cache_hit=True)
    payload = emitted(captured)
    assert payload == {"stage": "completed", "run_id": "run_x", "n_samples": 12, "cache_hit": True}


def test_event_rejects_unserializable_payloads(captured):
    """Emitting raw vectors or arrays must fail loudly rather than stringify them."""
    import numpy as np

    with captured.at_level(logging.INFO, logger="retrain_cluster"):
        with pytest.raises(TypeError):
            event("completed", vectors=np.zeros((2, 2)))


def test_events_are_namespaced_under_the_package(captured):
    with captured.at_level(logging.INFO, logger="retrain_cluster"):
        event("started")
    assert emitted(captured)["stage"] == "started"
