"""FastAPI 依赖。

沿用源项目 `medica-report-review/app/api/deps.py` 的写法：用 `lru_cache`
把服务对象做成进程内单例，避免每条请求都重建引擎与模型注册表。
"""

from __future__ import annotations

from functools import lru_cache

from app.core.config import get_settings
from app.services.clustering_service import ClusteringGatewayService


@lru_cache
def get_cluster_service() -> ClusteringGatewayService:
    """返回聚类网关服务单例。"""

    return ClusteringGatewayService(get_settings())
