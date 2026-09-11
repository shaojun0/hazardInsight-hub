"""API 请求/响应模型（pydantic）。

``extra="forbid"`` + ``strict=True`` 是有意为之：拒绝多余字段与隐式类型转换，
让"客户端发错字段名"这类问题立刻暴露，而不是被静默忽略后产生难以定位的差异。
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Item(BaseModel):
    """一条待聚类的文本。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=128)  # 调用方自定义的样本 ID，需唯一
    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def nonblank(cls, value):
        """拒绝纯空白文本：它既没有语义，也会让距离计算失去意义。"""
        if not value.strip():
            raise ValueError("Blank text")
        return value


class ClusteringRequest(BaseModel):
    """聚类请求体。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    profile_id: str = Field(min_length=1, max_length=128)  # 选择算法与参数的配置档
    items: list[Item] = Field(min_length=2, max_length=500)  # 至少 2 条才谈得上"聚类"

    @field_validator("items")
    @classmethod
    def unique_ids(cls, items):
        """样本 ID 必须唯一，否则结果中的 id 无法与输入一一对应。"""
        if len({item.id for item in items}) != len(items):
            raise ValueError("Duplicate sample IDs")
        return items


class Assignment(BaseModel):
    """单个样本的聚类归属。"""

    id: str
    cluster_id: int  # -1 表示噪声


class ClusteringResponse(BaseModel):
    """聚类结果。"""

    run_id: str
    profile_id: str
    algorithm: str
    implementation_version: str
    n_samples: int
    n_clusters: int
    n_noise: int
    assignments: list[Assignment]
    warnings: list[str]  # 行为告警，如历史口径相关提示
    elapsed_ms: int


class ErrorDetail(BaseModel):
    """错误详情。"""

    code: str
    message: str
    request_id: str  # 与服务端日志中的 request_id 对应，便于排查


class ErrorResponse(BaseModel):
    """统一错误响应体。"""

    error: ErrorDetail
