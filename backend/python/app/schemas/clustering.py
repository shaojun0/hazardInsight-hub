"""聚类接口的请求/响应契约。

这是前端 TypeScript 类型（`shared/clustering.ts`）的唯一事实来源，两边字段
必须逐一对齐。统一响应包裹（`success / data / error`）满足「错误可辨识、
不 silent fail」的要求。

字段命名：Python 内部一律 snake_case，对外（HTTP 报文）通过 `alias_generator`
统一序列化为 camelCase，与前端 TypeScript 习惯一致。`populate_by_name=True`
让服务端既能用字段名构造，也能同时接受前端传来的 camelCase 请求体。
注意别名只作用于「已声明的模型字段」，不会递归改写 `metadata` / `features`
这类自由字典里的业务键名。
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

T = TypeVar("T")

#: 对外 camelCase、对内 snake_case 的基础配置。
CAMEL_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ApiModel(BaseModel):
    """所有契约模型的基类：统一 camelCase 别名策略。"""

    model_config = CAMEL_CONFIG


class DatasetItem(ApiModel):
    """一条待聚类的样本。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    id: str = Field(min_length=1, description="样本唯一 ID")
    text: str = Field(min_length=1, description="参与聚类的文本")
    metadata: dict[str, Any] = Field(default_factory=dict, description="随样本展示的业务字段")


class RunOptions(ApiModel):
    """聚类执行选项。

    只暴露网关真正支持的开关：算法选择由 cluster-engine 的 profile 决定，
    因此这里不虚构 n_clusters / distance_threshold 之类的参数。
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    profile_id: str | None = Field(default=None, description="指定 profile；留空则自动挑选")
    algorithm: str | None = Field(default=None, description="按算法名自动挑选可用 profile")
    visualize: bool = Field(default=True, description="是否计算二维可视化坐标")
    reduce_method: Literal["pca", "none"] = Field(default="pca", description="二维降维方式")


class ClusteringRunRequest(ApiModel):
    """聚类请求体。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    items: list[DatasetItem] = Field(min_length=2, description="样本列表，至少 2 条")
    options: RunOptions = Field(default_factory=RunOptions)


class ProfileInfo(ApiModel):
    """一个可用 profile 的描述。"""

    profile_id: str
    algorithm: str
    model_id: str
    knowledge_base_id: str | None = None
    features: dict[str, Any] = Field(default_factory=dict)
    algorithm_params: dict[str, Any] = Field(default_factory=dict)
    implementation_version: str
    max_samples: int
    available: bool
    unavailable_reason: str | None = None
    warnings: list[str] = Field(default_factory=list)


class AlgorithmInfo(ApiModel):
    """一种聚类算法的可用性。"""

    algorithm: str
    available: bool
    backend: str
    implementation_version: str
    max_samples: int
    warnings: list[str] = Field(default_factory=list)


class DatasetPreview(ApiModel):
    """数据文件解析结果。"""

    source_name: str
    total: int
    warnings: list[str] = Field(default_factory=list)
    items: list[DatasetItem] = Field(default_factory=list)


class ValueCount(ApiModel):
    """元数据取值计数。"""

    value: str
    count: int


class RepresentativeSample(ApiModel):
    """簇的代表样本（离质心最近的若干条）。"""

    id: str
    text: str
    confidence: float | None = None
    distance: float | None = None


class ClusterGroup(ApiModel):
    """一个簇的聚合描述。"""

    cluster_id: int = Field(description="-1 表示噪声")
    label: str
    size: int
    keywords: list[str] = Field(default_factory=list)
    cohesion: float | None = Field(default=None, description="簇内平均余弦相似度")
    representative_samples: list[RepresentativeSample] = Field(default_factory=list)
    metadata_distribution: dict[str, list[ValueCount]] = Field(default_factory=dict)


class ClusterResultItem(ApiModel):
    """单条样本的聚类归属。"""

    id: str
    text: str
    cluster_id: int
    cluster_label: str
    confidence: float | None = Field(default=None, description="与簇质心的余弦相似度映射到 0~1")
    distance: float | None = Field(default=None, description="到簇质心的欧氏距离")
    keywords: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class VisualizationPoint(ApiModel):
    """二维散点坐标（仅用于可视化，不参与聚类计算）。"""

    id: str
    x: float
    y: float
    cluster_id: int


class ClusterSummary(ApiModel):
    """聚类统计。"""

    run_id: str
    total_samples: int
    cluster_count: int
    noise_count: int
    largest_cluster_size: int
    smallest_cluster_size: int
    avg_cluster_size: float
    algorithm: str
    profile_id: str
    model_id: str
    implementation_version: str
    embedding_dimension: int
    cache_hit: bool
    elapsed_ms: int = Field(description="cluster-engine 报告的算法耗时（毫秒）")
    gateway_ms: int = Field(description="网关总耗时（含可视化加工，毫秒）")
    warnings: list[str] = Field(default_factory=list)


class ClusteringData(ApiModel):
    """聚类结果主体。"""

    summary: ClusterSummary
    clusters: list[ClusterGroup] = Field(default_factory=list)
    items: list[ClusterResultItem] = Field(default_factory=list)
    visualization: list[VisualizationPoint] = Field(default_factory=list)


class ErrorInfo(ApiModel):
    """统一错误结构。"""

    code: str
    message: str
    request_id: str | None = None
    detail: str | None = None


class Envelope(ApiModel, Generic[T]):
    """统一响应包裹：`success / data / error` 三件套。"""

    success: bool
    data: T | None = None
    error: ErrorInfo | None = None


class ProfilesData(ApiModel):
    """可用 profile 列表。"""

    profiles: list[ProfileInfo] = Field(default_factory=list)


class AlgorithmsData(ApiModel):
    """可用算法列表。"""

    algorithms: list[AlgorithmInfo] = Field(default_factory=list)


class SampleData(ApiModel):
    """内置示例数据。"""

    source_name: str
    items: list[DatasetItem] = Field(default_factory=list)


#: 聚类接口的响应类型别名，方便在路由里直接引用。
ClusteringEnvelope = Envelope[ClusteringData]
ProfilesEnvelope = Envelope[ProfilesData]
AlgorithmsEnvelope = Envelope[AlgorithmsData]
SampleEnvelope = Envelope[SampleData]
DatasetEnvelope = Envelope[DatasetPreview]


class EngineStatus(ApiModel):
    """cluster-engine 的加载状态。"""

    config_file: str | None = Field(default=None, description="配置文件名（不暴露绝对路径）")
    loaded: bool
    profiles_total: int = 0
    profiles_available: int = 0
    algorithms_available: list[str] = Field(default_factory=list)
    model_id: str | None = None
    model_provider: str | None = None
    model_dimension: int | None = None
    message: str | None = None


class HealthData(ApiModel):
    """健康检查结果。"""

    status: Literal["ok", "degraded"]
    service: str
    version: str
    engine: EngineStatus


class HealthEnvelope(Envelope[HealthData]):
    """健康检查响应。

    既是统一包裹（`success` / `data` / `error`），又在顶层镜像一份 `status`，
    这样探针类工具可以直接读 `body.status`，前端则统一走 `body.data`。
    """

    status: Literal["ok", "degraded"]
