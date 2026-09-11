"""FastAPI 应用装配：中间件、异常处理器、路由注册与生命周期管理。"""

from contextlib import asynccontextmanager
import uuid
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from ..config import Settings, Catalog
from ..artifacts.runs import RunStore
from ..errors import ClusterError
from .execution import SyncExecutor
from .routes import router


class RequestBoundary:
    """ASGI 中间件：为每个请求分配 request_id，并在读取阶段强制体积上限。

    关键点是"边读边计数"：不是收完整个 body 再判断大小，而是超过阈值立刻中断，
    避免超大请求先耗尽内存再被拒绝（那等于没有防护）。
    """

    def __init__(self, app, max_bytes):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        # 非 HTTP 流量（如 websocket/lifespan）直接透传
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        total, chunks = 0, []
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return  # 客户端提前断开，无需继续
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > self.max_bytes:
                error = ClusterError("REQUEST_TOO_LARGE", "Request body exceeds 2 MiB limit", 413)
                return await JSONResponse(error.payload(request_id), status_code=413)(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        sent = False

        async def replay():
            """把已缓存的分块"重放"给下游应用（body 只能读一次，故需缓存）。"""
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        async def with_id(message):
            """在响应头回填 request_id，方便客户端在日志中检索同一次请求。"""
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"x-request-id", request_id.encode()))
            await send(message)

        await self.app(scope, replay, with_id)


def create_app(config_path=None, *, settings=None, executor=None):
    """构造 FastAPI 应用。

    settings / executor 可注入，便于测试时使用临时配置或替身执行器。
    """
    settings = settings or Settings.load(config_path)
    catalog = Catalog(settings)  # 启动时加载并校验配置，问题尽早暴露
    executor = executor or SyncExecutor(settings)

    @asynccontextmanager
    async def lifespan(app):
        """应用生命周期：启动时拉起执行子进程，关闭时确保回收。"""
        executor.start()
        try:
            yield
        finally:
            executor.close()

    app = FastAPI(title="Retrain Cluster", version="0.2.0", lifespan=lifespan)
    app.state.settings, app.state.catalog, app.state.executor = settings, catalog, executor
    app.state.runs = RunStore(settings.artifacts_dir / "runs")
    app.add_middleware(RequestBoundary, max_bytes=settings.max_body_bytes)

    @app.exception_handler(ClusterError)
    async def domain_error(request: Request, exc: ClusterError):
        """业务异常：按其自带的状态码与错误码返回，不泄漏内部细节。"""
        return JSONResponse(exc.payload(request.state.request_id), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc):
        """请求体不符合契约：统一为 422，不把 pydantic 的详细报错透出去。"""
        error = ClusterError("INVALID_REQUEST", "Request does not match the API contract", 422)
        return JSONResponse(error.payload(request.state.request_id), status_code=422)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc):
        """兜底处理器：任何未预期异常都返回统一的 500，绝不外泄堆栈或路径。"""
        error = ClusterError("INTERNAL_ERROR", "Unexpected server error", 500)
        return JSONResponse(error.payload(request.state.request_id), status_code=500)

    app.include_router(router)
    return app
