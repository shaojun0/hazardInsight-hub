"""日志入口。

沿用源项目 `medica-report-review` 的 logger 约定（`app/core/logger.py`）：
业务模块统一通过 `get_logger(__name__)` 获取 logger，方便后续替换为
结构化日志或接入采集端。
"""

from __future__ import annotations

import logging

_CONFIGURED = False


def get_logger(name: str) -> logging.Logger:
    """返回带统一格式的 logger。"""

    global _CONFIGURED
    if not _CONFIGURED:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        )
        _CONFIGURED = True
    return logging.getLogger(name)
