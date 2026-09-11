"""统一的领域异常。

全项目只抛这一种业务异常，好处是：错误码稳定、HTTP 状态码随异常一起传递、
且可以在 API 层被一个 handler 集中转换成 JSON 响应。
"""


class ClusterError(Exception):
    """携带机器可读错误码与 HTTP 状态码的业务异常。

    参数
    ----
    code : str
        稳定的错误码（如 ``INVALID_PROFILE`` / ``MODEL_UNAVAILABLE``），供调用方分支判断。
    message : str
        面向人的说明，不含敏感信息。
    status : int
        建议的 HTTP 状态码；CLI 场景下不使用，但保留以便 API 层直接透传。
    """

    def __init__(self, code: str, message: str, status: int = 500):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

    def payload(self, request_id):
        """转换为 API 的错误响应体，附带 request_id 便于日志串联排查。"""
        return {"error": {"code": self.code, "message": self.message, "request_id": request_id}}
