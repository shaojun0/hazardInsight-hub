"""检索增强聚类，并保持历史实验口径可复现。

这里只再导出"依赖轻、几乎不会失败"的底层符号。重量级子包（api、services、
embeddings、features 等）必须由调用方显式导入，这样做有两个好处：
  1. 导入图保持无环（见 tests/unit/test_package_api.py）；
  2. ``import retrain_cluster`` 不会顺带拉入 fastapi/torch/chromadb 等可选重依赖。
"""

__version__ = "0.2.0"

from .errors import ClusterError
from .types import TextDataset, EmbeddingBatch, NeighborBatch, FeatureSpec, ResolvedPipelineConfig
from .config import Settings, Catalog, model_fingerprint, verify_local_model

__all__ = [
    "Catalog",
    "ClusterError",
    "EmbeddingBatch",
    "FeatureSpec",
    "NeighborBatch",
    "ResolvedPipelineConfig",
    "Settings",
    "TextDataset",
    "model_fingerprint",
    "verify_local_model",
    "__version__",
]
