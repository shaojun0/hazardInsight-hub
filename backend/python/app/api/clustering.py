"""聚类相关路由。

路由层只做「准入校验 + 委托」，业务逻辑全部在 `ClusteringGatewayService`；
所有失败都通过抛出领域异常交给统一处理器，路由里不写 `try/except` 拼错误 JSON。
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, Query, UploadFile
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_cluster_service
from app.core.config import get_settings
from app.core.errors import ClusteringTimeoutError, FileTooLargeError
from app.schemas.clustering import (
    AlgorithmsData,
    AlgorithmsEnvelope,
    ClusteringData,
    ClusteringEnvelope,
    ClusteringRunRequest,
    DatasetEnvelope,
    DatasetPreview,
    ProfilesData,
    ProfilesEnvelope,
    SampleData,
    SampleEnvelope,
)
from app.services.clustering_service import ClusteringGatewayService
from app.utils.validators import validate_upload_extension

router = APIRouter(prefix="/clustering", tags=["clustering"])


def _normalize_filename(raw_name: str) -> str:
    """修正 multipart 文件名的编码。

    浏览器以 UTF-8 发送文件名，但 multipart 默认按 latin1 解码，含中文的文件名
    会变成乱码。这里按主项目 hazard-test 路由的既有做法还原一次。
    """

    if not raw_name:
        return "dataset"
    if any("\u4e00" <= char <= "\u9fff" for char in raw_name):
        return raw_name
    try:
        return raw_name.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return raw_name


@router.get("/profiles", response_model=ProfilesEnvelope, summary="列出可用 profile")
async def list_profiles(
    refresh: bool = Query(default=False, description="是否强制重新校验模型与 profile"),
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> ProfilesEnvelope:
    """返回 cluster-engine 中可通过 API 使用的配置档及其可用状态。"""

    profiles = await run_in_threadpool(service.list_profiles, refresh=refresh)
    return ProfilesEnvelope(success=True, data=ProfilesData(profiles=profiles), error=None)


@router.get("/algorithms", response_model=AlgorithmsEnvelope, summary="列出可用聚类算法")
async def list_algorithms(
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> AlgorithmsEnvelope:
    """返回引擎暴露的聚类算法及其依赖可用性。"""

    algorithms = await run_in_threadpool(service.list_algorithms)
    return AlgorithmsEnvelope(success=True, data=AlgorithmsData(algorithms=algorithms), error=None)


@router.get("/sample", response_model=SampleEnvelope, summary="读取内置示例数据")
async def sample_dataset(
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> SampleEnvelope:
    """返回随项目分发的示例数据集（真实核电工程隐患抽样）。"""

    payload = await run_in_threadpool(service.load_sample_dataset)
    return SampleEnvelope(
        success=True,
        data=SampleData(source_name=payload["source_name"], items=payload["items"]),
        error=None,
    )


@router.post("/datasets", response_model=DatasetEnvelope, summary="上传并解析数据文件")
async def upload_dataset(
    file: UploadFile = File(..., description="CSV / XLSX / JSON / TXT"),
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> DatasetEnvelope:
    """解析上传的数据文件，规范成聚类样本列表（含自动识别文本列）。"""

    settings = get_settings()
    filename = _normalize_filename(file.filename or "dataset")
    validate_upload_extension(filename)
    data = await file.read()
    if not data:
        raise FileTooLargeError("上传的文件内容为空。")
    if len(data) > settings.upload_max_bytes:
        raise FileTooLargeError(
            f"文件大小 {len(data) / 1024 / 1024:.1f} MB 超过上限 "
            f"{settings.upload_max_bytes / 1024 / 1024:.0f} MB。"
        )
    preview = await run_in_threadpool(service.parse_dataset, data, filename)
    return DatasetEnvelope(success=True, data=DatasetPreview(**preview), error=None)


@router.post("/run", response_model=ClusteringEnvelope, summary="执行一次聚类")
async def run_clustering(
    body: ClusteringRunRequest,
    service: ClusteringGatewayService = Depends(get_cluster_service),
) -> ClusteringEnvelope:
    """执行聚类并返回统计、簇摘要、逐条结果与二维可视化坐标。"""

    settings = get_settings()
    payload = {
        "items": [item.model_dump() for item in body.items],
        "options": body.options.model_dump(),
    }
    try:
        data = await asyncio.wait_for(
            run_in_threadpool(service.run, payload),
            timeout=settings.timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        # 线程无法被强制取消，因此这里只中止等待；引擎侧任务结束后会自行释放单飞锁。
        raise ClusteringTimeoutError(
            f"聚类执行超过 {settings.timeout_seconds:.0f} 秒仍未返回，已中止等待。"
            "请减少样本数量或改用更轻量的 profile 后重试。"
        ) from exc
    return ClusteringEnvelope(success=True, data=ClusteringData(**data), error=None)
