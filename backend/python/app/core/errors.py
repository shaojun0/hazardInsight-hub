"""网关领域错误与错误码。

沿用源项目 `medica-report-review` 的异常分层习惯（`app/core/exceptions.py`）：
定义一个业务基类，再按失败环节细分。API 层只负责把这些异常（以及
cluster-engine 的 `ClusterError`）翻译成统一的响应结构。

错误码命名与 cluster-engine 保持同一风格（大写下划线），前端可直接分支。
"""

from __future__ import annotations

from typing import Any


class ClusterGatewayError(Exception):
    """网关业务异常基类。

    `code` 会原样透出到前端 `error.code`；`status` 是建议的 HTTP 状态码；
    `detail` 承载不面向终端用户的技术细节（仅写日志，不进响应）。
    """

    code = "INTERNAL_ERROR"
    status = 500

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


class InvalidInputError(ClusterGatewayError):
    """输入为空、字段缺失或超出约定范围。"""

    code = "INVALID_INPUT"
    status = 400


class TooManyItemsError(ClusterGatewayError):
    """样本数超过服务上限。"""

    code = "TOO_MANY_ITEMS"
    status = 400


class TextTooLongError(ClusterGatewayError):
    """单条文本超过引擎允许的长度。"""

    code = "INVALID_TEXT"
    status = 400


class UnsupportedFileError(ClusterGatewayError):
    """上传的数据文件类型不受支持。"""

    code = "UNSUPPORTED_FILE"
    status = 400


class FileTooLargeError(ClusterGatewayError):
    """上传文件超过大小上限。"""

    code = "FILE_TOO_LARGE"
    status = 413


class FileParseError(ClusterGatewayError):
    """数据文件解析失败（编码、表头、格式异常等）。"""

    code = "FILE_PARSE_ERROR"
    status = 400


class SampleDatasetError(ClusterGatewayError):
    """内置示例数据缺失或损坏。"""

    code = "SAMPLE_NOT_FOUND"
    status = 404


class EngineUnavailableError(ClusterGatewayError):
    """cluster-engine 无法加载：配置文件缺失、依赖未安装等。"""

    code = "ENGINE_UNAVAILABLE"
    status = 503


class ProfileUnavailableError(ClusterGatewayError):
    """请求的 profile 不存在，或当前环境不可执行。"""

    code = "PROFILE_UNAVAILABLE"
    status = 409


class ServiceBusyError(ClusterGatewayError):
    """已有聚类请求在执行（网关为单飞模式）。"""

    code = "SERVICE_BUSY"
    status = 429


class ClusteringTimeoutError(ClusterGatewayError):
    """聚类超出网关墙钟超时。"""

    code = "CLUSTERING_TIMEOUT"
    status = 504


class ClusteringError(ClusterGatewayError):
    """聚类执行失败（兜底）。"""

    code = "CLUSTERING_FAILED"
    status = 500


def error_payload(exc: ClusterGatewayError, *, request_id: str | None = None) -> dict[str, Any]:
    """把领域异常转成响应里的 `error` 对象。

    字段名与前端 `ClusterApiErrorInfo` 一致（camelCase）。这里是错误结构的
    唯一定义处，`api/error_handlers.py` 与测试都复用它，避免两边字段写歪。
    `detail` 恒为 None：技术细节只进日志，不出网。
    """

    return {
        "code": exc.code,
        "message": exc.message,
        "requestId": request_id,
        "detail": None,
    }
