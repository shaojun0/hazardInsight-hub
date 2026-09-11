"""检索器协议（扩展点）。

职责边界刻意收得很窄：检索器只处理向量、只返回近邻，**绝不能看到标签、评分或算法参数**。
这条约束保证了"检索增强"不会偷偷利用监督信息，从而让无监督口径成立。
"""

from typing import Protocol, runtime_checkable
import numpy as np
from ..types import NeighborBatch


@runtime_checkable
class Retriever(Protocol):
    """最近邻检索后端的扩展点。

    检索器只处理向量并返回 ``NeighborBatch``；它绝不能接触标签、评分或算法设置。
    """

    def query(self, vectors: np.ndarray, k: int) -> NeighborBatch: ...
