"""检索融合与降维。这一层**绝不读取标签**，因此链路全程保持无监督。"""

from .fusion import fuse, neighbor_means
from .pipeline import FeaturePipeline
from .reduction import DimReducer

__all__ = ["DimReducer", "FeaturePipeline", "fuse", "neighbor_means"]
