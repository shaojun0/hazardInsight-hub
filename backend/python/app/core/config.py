"""网关配置。

沿用源项目 `medica-report-review` 的配置写法（pydantic-settings `BaseSettings`
+ `lru_cache` 单例），环境变量前缀为 `HAZARD_`。

这里**不**承载算法参数：算法与向量化口径在 `cluster-engine/configs/` 下，
由 `retrain_cluster.Settings` 负责加载。`engine_config` 只是指向那份配置的入口。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

#: `backend/python` 目录。所有相对路径都以它为基准解析，与进程 cwd 无关。
BACKEND_ROOT = Path(__file__).resolve().parents[2]


class GatewaySettings(BaseSettings):
    """聚类网关运行配置。"""

    app_name: str = "HazardInsight Clustering Gateway"
    app_version: str = "1.0.0"

    #: cluster-engine 的应用配置（相对 backend/python 解析，禁止绝对路径硬编码）
    engine_config: Path = Field(default=Path("cluster-engine") / "configs" / "app.toml")

    #: 内置示例数据（真实核电工程隐患抽样，由 scripts/build_sample_dataset.py 生成）
    sample_dataset: Path = Field(default=Path("samples") / "hazard_samples.json")

    #: 允许跨域的前端来源，逗号分隔。
    cors_origins: str = (
        "http://localhost:5175,http://127.0.0.1:5175,"
        "http://localhost:3001,http://127.0.0.1:3001"
    )

    #: 未显式指定 profile 时使用的兜底 profile；留空表示由网关自动挑选。
    default_profile_id: str | None = None

    #: 单次聚类请求的墙钟超时（秒）。超过则向前端返回 504。
    timeout_seconds: float = 120.0

    #: 上传数据文件大小上限（字节）。
    upload_max_bytes: int = 10 * 1024 * 1024

    #: 簇摘要（展示辅助）配置。
    digest_top_keywords: int = 6
    digest_representatives: int = 3

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="HAZARD_",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的来源串解析为列表。"""

        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    def resolve_path(self, path: Path) -> Path:
        """把相对路径解析为绝对路径（基准为 `backend/python`，而非进程 cwd）。"""

        return path if path.is_absolute() else (BACKEND_ROOT / path)

    @property
    def engine_config_path(self) -> Path:
        """cluster-engine 的 app.toml 绝对路径。"""

        return self.resolve_path(self.engine_config)

    @property
    def sample_dataset_path(self) -> Path:
        """内置示例数据文件绝对路径。"""

        return self.resolve_path(self.sample_dataset)


@lru_cache
def get_settings() -> GatewaySettings:
    """返回网关配置单例（一次进程生命周期内只读一次环境变量）。"""

    return GatewaySettings()
