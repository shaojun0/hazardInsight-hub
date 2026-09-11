"""结构化日志：输出单行 JSON，便于日志系统采集与检索。"""

import json
import logging


def configure_logging():
    logging.basicConfig(level=logging.INFO, format="%(message)s")


def event(stage, **fields):
    """记录一次结构化事件。

    安全约定：调用方只能传标识符/计数这类元数据，**绝不传原文、向量或凭据**。
    日志往往会被集中收集和长期保存，一旦写入敏感内容就难以收回。
    """
    # Callers pass identifiers/counts only, never texts, vectors or credentials.
    logging.getLogger("retrain_cluster").info(json.dumps({"stage": stage, **fields}))
