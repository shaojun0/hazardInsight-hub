"""OpenAI 兼容接口的远程编码器（如硅基流动托管的 bge-large-zh）。

两点安全/正确性考虑：
  * ``max_retries=0``：禁用 SDK 自动重试，避免超时后重复计费；
  * 校验返回行的 index 顺序，防止服务端乱序返回导致"向量与文本错配"这一
    极其隐蔽的错误。
"""

import os
import numpy as np
from ..errors import ClusterError
from .base import Encoder


class OpenAICompatibleEncoder(Encoder):
    def __init__(self, spec):
        from openai import OpenAI

        key = os.environ.get(spec.get("api_key_env", "EMBEDDING_API_KEY"))
        if not key:
            raise ClusterError("MODEL_UNAVAILABLE", "Embedding API credential is not configured", 503)
        self.spec = spec
        self.client = OpenAI(
            base_url=spec["base_url"], api_key=key, timeout=spec.get("timeout_seconds", 45), max_retries=0
        )

    def encode(self, texts):
        batch = self.spec.get("batch_size", 64)
        vectors = []
        try:
            for start in range(0, len(texts), batch):
                response = self.client.embeddings.create(
                    input=list(texts[start : start + batch]), model=self.spec["source"]
                )
                rows = response.data
                # 服务端必须按输入顺序返回（index 严格递增）；乱序会导致向量与文本错配
                if [row.index for row in rows] != list(range(len(texts[start : start + batch]))):
                    raise ClusterError("EMBEDDING_ORDER_INVALID", "Provider returned unordered embedding rows", 502)
                vectors.extend(row.embedding for row in rows)
        except ClusterError:
            raise
        except Exception as exc:
            # 网络/鉴权等底层异常统一收敛，避免把 provider 原始报文透给调用方
            raise ClusterError("EMBEDDING_PROVIDER_ERROR", "Embedding provider request failed", 502) from exc
        return np.array(vectors)
