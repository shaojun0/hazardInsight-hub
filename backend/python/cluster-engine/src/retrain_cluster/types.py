"""贯穿全流程的数据契约。

这里的 dataclass 是各层之间传递数据的唯一形式：数据加载 -> 编码 -> 特征变换 -> 聚类，
每一环都只认这些结构，从而保证"数据是什么"和"怎么算"相互独立。
"""

from dataclasses import dataclass, field, asdict
from typing import Any
import numpy as np
from .errors import ClusterError
from .artifacts.fingerprints import fingerprint


@dataclass
class TextDataset:
    """一份文本数据集，附带可选的真实标签（用于评估）。"""

    dataset_id: str  # 数据集标识（由来源文件内容哈希派生）
    sample_ids: list[str]  # 每条文本的唯一 ID，保证结果可回溯到原始样本
    texts: list[str]  # 文本本身
    labels: np.ndarray | None = None  # 真实标签；无监督场景为 None
    label_names: dict[int, str] = field(default_factory=dict)  # 标签编号 -> 可读名称
    source_fingerprint: str = ""  # 来源文件的内容指纹，便于复现与审计


@dataclass
class EmbeddingBatch:
    """一批文本向量。"""

    sample_ids: list[str]  # 与 values 的行一一对应
    values: np.ndarray  # 形状 (n_samples, dimension) 的浮点矩阵
    model_fingerprint: str  # 编码模型指纹：换模型/换设备即失效
    processing_fingerprint: str = "raw-v1"  # 预处理口径版本（是否归一化等）


@dataclass
class NeighborBatch:
    """检索结果：每个样本的 k 个近邻。"""

    ids: list[list[str]]  # 每个样本的近邻 ID 列表，外层长度 = 样本数
    values: Any  # 近邻向量，形状 (n_samples, k, dimension)
    knowledge_base_id: str  # 来源知识库标识
    distances: Any = None  # 可选的距离，当前流程未使用


@dataclass(frozen=True)
class FeatureSpec:
    """特征融合与降维的口径。

    frozen=True 是有意为之：该对象一旦构造就不可变，避免在流程中途被修改
    导致"同一配置产生不同结果"。所有非法取值都在构造时立刻报错。
    """

    beta: float = 1.0  # 融合权重：beta*原始向量 + (1-beta)*邻居均值
    n_results: int = 0  # 检索近邻数 k；0 表示不做检索增强
    pca_dim: int = 0  # 降维目标维度；0 表示不降维
    reduction: str = "PCA"  # 降维算法："PCA" 或 "UMAP"
    version: str = "legacy-v1"  # 特征处理的行为版本，决定边界路径（见 pipeline.py）

    def __post_init__(self):
        # beta 必须在 [0, 1] 且为有限数，否则融合结果无意义
        if not np.isfinite(self.beta) or not 0 <= self.beta <= 1:
            raise ClusterError("INVALID_PROFILE", "beta must be within [0, 1]", 422)
        # 类型必须严格是 int（布尔是 int 的子类，这里要排除 True/False）
        if type(self.n_results) is not int or self.n_results < 0 or type(self.pca_dim) is not int or self.pca_dim < 0:
            raise ClusterError("INVALID_PROFILE", "Inference requires resolved nonnegative dimensions and k", 422)
        # 版本白名单：约束住可以被复现的行为集合
        if self.reduction not in {"PCA", "UMAP"} or self.version not in {"legacy-v1", "legacy-radbscan-v1"}:
            raise ClusterError("INVALID_PROFILE", "Unknown feature behavior version", 422)


@dataclass(frozen=True)
class ResolvedPipelineConfig:
    """一次聚类任务所需的全部已解析配置（对应 configs/profiles/*.json）。

    它是可复现性的核心：只要这份配置相同、输入相同、模型相同，结果就应当相同。
    """

    profile_id: str  # 配置标识，API 请求通过它选择算法与参数
    algorithm: str  # 聚类算法名，需能在 clustering.registry.ALGORITHMS 中找到
    model_id: str  # 使用的编码模型，需能在 models.toml 中找到
    algorithm_params: dict  # 传给算法函数的超参（不含特征相关字段）
    features: FeatureSpec = field(default_factory=FeatureSpec)  # 特征处理口径
    knowledge_base_id: str | None = None  # 检索增强所用的知识库
    implementation_version: str = "legacy-v1"  # 实现版本，当前只支持历史口径
    backend: str = "python"  # 执行后端，当前冻结为纯 Python
    compatibility_status: str = "legacy"  # 与历史实验的兼容性标记
    source_result: str | None = None  # 历史来源结果文件（仅作溯源）
    source_sha256: str | None = None  # 上述文件的校验和
    max_samples: int = 500  # 单批样本数上限

    @classmethod
    def from_dict(cls, raw):
        """从 profile JSON 字典构造，并在构造阶段完成全部合法性校验。"""
        try:
            obj = cls(**{**raw, "features": FeatureSpec(**raw.get("features", {}))})
        except (TypeError, ValueError):
            # 字段名不对/类型不对，统一收敛为领域错误，避免泄漏底层异常细节
            raise ClusterError("INVALID_PROFILE", "Profile fields are invalid", 422) from None
        if obj.implementation_version != "legacy-v1" or obj.max_samples < 2:
            raise ClusterError("INVALID_PROFILE", "Unsupported implementation or sample limit", 422)
        # 需要检索近邻就必须指定知识库，否则无从查起
        if obj.features.n_results and not obj.knowledge_base_id:
            raise ClusterError("INVALID_PROFILE", "Retrieval profile needs a knowledge base", 422)
        # RADBSCAN 的历史行为依赖 legacy-radbscan-v1 这条特殊的特征顺序，不能被别的手滑改掉
        if obj.algorithm == "radbscan" and obj.features.version != "legacy-radbscan-v1":
            raise ClusterError("INVALID_PROFILE", "RADBSCAN requires its historical feature order", 422)
        return obj

    @property
    def fingerprint(self):
        """配置指纹：任何字段变化都会改变它，用于产物溯源与缓存键。"""
        return fingerprint(asdict(self))
