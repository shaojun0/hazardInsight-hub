"""健康检查。

`GET /api/health` 是规范要求的探针；同时把同一个路由再挂到
`/api/clustering/health`，这样前端只需一条 `/api/clustering` 代理规则
即可完成健康检查，无需为探针单独开口子。

健康检查反映 cluster-engine 与本地向量模型的就绪状态，前端据此在
"服务未启动 / 模型未就绪" 时给出明确提示，而不是让用户对着失败的聚类按钮猜。

响应同时满足两种消费习惯：顶层 `status` 供探针直接读取，`data` 内是完整的
就绪详情，前端统一按 `data` 解析。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_cluster_service
from app.core.config import get_settings
from app.schemas.clustering import EngineStatus, HealthData, HealthEnvelope
from app.services.clustering_service import ClusteringGatewayService

router = APIRouter(tags=["health"])

#: 健康检查的路径（在 main.py 中以 /api 与 /api/clustering 两个前缀各挂一次）。
HEALTH_PATH = "/health"


def build_health(service: ClusteringGatewayService) -> HealthData:
    """组装健康检查数据。"""

    settings = get_settings()
    engine = service.engine_status()
    ready = bool(engine.get("loaded")) and not engine.get("message")
    return HealthData(
        status="ok" if ready else "degraded",
        service=settings.app_name,
        version=settings.app_version,
        engine=EngineStatus(**engine),
    )


@router.get(HEALTH_PATH, response_model=HealthEnvelope, summary="健康检查")
def health(
    refresh: bool = Query(default=False, description="是否强制重新校验本地模型文件"),
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> HealthEnvelope:
    """返回服务与聚类引擎的就绪状态。"""

    if refresh:
        service.invalidate_caches()
    data = build_health(service)
    return HealthEnvelope(success=True, data=data, error=None, status=data.status)
