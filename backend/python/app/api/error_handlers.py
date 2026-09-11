"""统一错误处理。

把所有异常收敛成同一种响应结构：

```json
{"success": false, "data": null, "error": {"code": "...", "message": "...", "requestId": "..."}}
```

这样前端只需写一套错误分支，不会出现"某个接口返回 HTML 错误页"这类
无法解析的情况（即不 silent fail）。
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.errors import ClusterGatewayError, error_payload
from app.core.logger import get_logger

logger = get_logger(__name__)


def _request_id(request: Request) -> str:
    """取（或生成）请求 ID，便于前端把报错与服务端日志对齐。"""

    existing = getattr(request.state, "request_id", None)
    if existing:
        return str(existing)
    generated = uuid.uuid4().hex
    request.state.request_id = generated
    return generated


def _failure(request: Request, code: str, message: str, status: int, detail: str | None = None) -> JSONResponse:
    """构造统一失败响应。"""

    return JSONResponse(
        {
            "success": False,
            "data": None,
            "error": {
                "code": code,
                "message": message,
                "requestId": _request_id(request),
                "detail": detail,
            },
        },
        status_code=status,
    )


def register_error_handlers(app: FastAPI) -> None:
    """注册全部异常处理器。"""

    @app.exception_handler(ClusterGatewayError)
    async def gateway_error(request: Request, exc: ClusterGatewayError) -> JSONResponse:
        """网关业务异常：按其自带的错误码与状态码返回。"""

        logger.warning("[%s] %s", exc.code, exc.message)
        return JSONResponse(
            {
                "success": False,
                "data": None,
                "error": error_payload(exc, request_id=_request_id(request)),
            },
            status_code=exc.status,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        """请求体不符合契约：统一 422，并给出首个字段错误，便于定位。"""

        errors = exc.errors()
        first = errors[0] if errors else {}
        location = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
        reason = first.get("msg", "请求参数不合法")
        message = f"请求参数不合法：{location or 'body'} {reason}。"
        return _failure(request, "INVALID_REQUEST", message, 422)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        """兜底：任何未预期异常都返回 500，不向外泄漏堆栈与路径。"""

        logger.exception("未预期错误：%s", exc)
        return _failure(request, "INTERNAL_ERROR", "服务内部错误，请查看后端日志。", 500)
