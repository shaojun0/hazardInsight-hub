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


def test_interrupt_ends_a_blocking_request_immediately(settings):
    """硬取消：杀进程必须让阻塞中的 execute 立刻退出，而不是等满 deadline。

    这是"停止任务能真的释放资源"的全部依据——聚类跑的是紧循环，Python 层没有
    抢占点、线程也杀不掉，只有进程边界能保证停得下来。因此这里把 timeout 设得
    很大，专门证明"停下来"靠的是 interrupt 而不是超时。
    """

    settings.timeout_seconds = 30
    executor = SyncExecutor(settings, worker=controlled_worker)
    executor.start()
    wait_ready(executor)
    previous = executor.process.pid
    try:
        with ThreadPoolExecutor() as pool:
            running = pool.submit(executor.execute, {"delay": 30})
            time.sleep(0.2)  # 等它真正进到执行中，否则杀的是空闲进程
            assert executor.interrupt() is True
            started = time.monotonic()
            with pytest.raises(ClusterError) as error:
                running.result(timeout=10)
            assert error.value.status == 503
            assert time.monotonic() - started < 5, "取消应当立刻生效，而不是等到超时"
        # 既有语义不变：子进程状态不可信时销毁重启，下一次请求不必付冷启动代价
        assert executor.process.pid != previous
        wait_ready(executor)
        assert executor.execute({"value": "recovered"}) == {"echo": "recovered"}
    finally:
        executor.close()


def test_interrupt_is_a_noop_when_idle_or_unstarted(settings):
    """空闲时取消不该炸；从未启动过则如实返回 False（没有进程可杀）。"""

    executor = SyncExecutor(settings, worker=controlled_worker)
    assert executor.interrupt() is False  # 还没启动过

    executor.start()
    wait_ready(executor)
    previous = executor.process.pid
    try:
        assert executor.interrupt() is True
        # 空闲态被杀之后，下一次 execute 会自行重建子进程（start 检测到进程已死）
        assert executor.execute({"value": "ok"}) == {"echo": "ok"}
        assert executor.process.pid != previous
    finally:
        executor.close()


def test_actual_spawn_service_with_local_openai_stub(settings, monkeypatch):
    # openai 是可选依赖（只在使用远程 openai_compatible provider 时才需要），
    # 未安装时跳过而不是让整套测试失败——这与引擎"缺依赖时优雅降级"的口径一致。
    pytest.importorskip("openai", reason="远程 provider 需要可选的 openai 包")

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
