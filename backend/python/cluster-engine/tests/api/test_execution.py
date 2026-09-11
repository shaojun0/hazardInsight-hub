from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from fastapi.testclient import TestClient
from retrain_cluster.api.execution import SyncExecutor
from retrain_cluster.api.app import create_app
from retrain_cluster.errors import ClusterError
from tests.worker_helpers import controlled_worker
from tests.conftest import FixedEncoder


def wait_ready(executor):
    deadline = time.monotonic() + 20
    while not executor.ready():
        assert time.monotonic() < deadline
        time.sleep(0.02)


def test_busy_timeout_kills_worker_and_recovers(settings):
    settings.timeout_seconds = 0.5
    executor = SyncExecutor(settings, worker=controlled_worker)
    executor.start()
    wait_ready(executor)
    old = executor.process.pid
    try:
        with ThreadPoolExecutor() as pool:
            running = pool.submit(executor.execute, {"delay": 1.5})
            time.sleep(0.1)
            with pytest.raises(ClusterError) as busy:
                executor.execute({"value": "second"})
            assert busy.value.status == 429
            with pytest.raises(ClusterError) as timeout:
                running.result()
            assert timeout.value.status == 504
        assert executor.process.pid != old
        wait_ready(executor)
        assert executor.execute({"value": "recovered"}) == {"echo": "recovered"}
    finally:
        executor.close()


def test_worker_crash_recovers(settings):
    executor = SyncExecutor(settings, worker=controlled_worker)
    executor.start()
    wait_ready(executor)
    try:
        with pytest.raises(ClusterError) as error:
            executor.execute({"crash": True})
        assert error.value.status == 503
        wait_ready(executor)
        assert executor.execute({"value": 1}) == {"echo": 1}
    finally:
        executor.close()


def test_actual_spawn_service_with_local_openai_stub(settings, monkeypatch):
    class Provider(BaseHTTPRequestHandler):
        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            values = FixedEncoder().encode(data["input"])
            response = {
                "object": "list",
                "model": "fixture",
                "data": [{"object": "embedding", "index": i, "embedding": v.tolist()} for i, v in enumerate(values)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            }
            encoded = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    model_file = settings.models_file
    model_file.write_text(model_file.read_text().replace("127.0.0.1:9", f"127.0.0.1:{server.server_port}"))
    monkeypatch.setenv("EMBEDDING_API_KEY", "local-fixture-only")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    try:
        from retrain_cluster.config import Catalog
        from retrain_cluster.embeddings.openai_compatible import OpenAICompatibleEncoder
        assert OpenAICompatibleEncoder(Catalog(settings).model("fixture")).encode(["same", "same"]).shape == (2, 8)
        with TestClient(create_app(settings=settings)) as client:
            response = client.post(
                "/api/v1/clusterings",
                json={"profile_id": "fixture", "items": [{"id": "a", "text": "same"}, {"id": "b", "text": "same"}]},
            )
            assert response.status_code == 201, response.text
            assert response.json()["n_clusters"] == 1
            assert client.get(response.headers["Location"]).json() == response.json()
            assert client.get("/health/ready").status_code == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
