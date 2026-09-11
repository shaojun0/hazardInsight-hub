"""聚类内核，统一通过显式注册表分发。

各个内核**故意不在此处再导出**：它们各自携带可选的重依赖（hdbscan、networkx、torch 等），
必须经 :func:`get_clusterer` 惰性获取，避免 `import` 阶段就拖入所有算法依赖。
"""

from .registry import ALGORITHMS, API_ALGORITHMS, WARNINGS, available, get_clusterer, validate_params

__all__ = [
    "ALGORITHMS",
    "API_ALGORITHMS",
    "WARNINGS",
    "available",
    "get_clusterer",
    "validate_params",
]
