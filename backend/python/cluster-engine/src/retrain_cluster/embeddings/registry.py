"""编码器注册表：把模型配置解析为可用的编码器实例。

两类 provider 的可用性判定完全不同：
  * 远程（openai_compatible）：只检查 API 凭据环境变量是否存在；
  * 本地（sentence_transformer / simcse / sccl）：检查依赖包 + 模型文件校验和。
"""

from importlib import import_module, util
import os
from ..config import verify_local_model
from ..errors import ClusterError

# provider 名 -> (模块名, 类名, 需要探测的依赖包)
PROVIDERS = {
    "openai_compatible": ("openai_compatible", "OpenAICompatibleEncoder", "openai"),
    "sentence_transformer": ("sentence_transformer", "SentenceTransformerEncoder", "sentence_transformers"),
    "simcse": ("simcse", "SimCSEEncoder", "torch"),
    "sccl": ("sccl", "SCCLEncoder", "torch"),
}


def check_model(spec):
    """检查模型在当前环境是否可用；不可用则抛出带原因的错误码。"""
    provider = spec.get("provider")
    if provider not in PROVIDERS or not util.find_spec(PROVIDERS[provider][2]):
        raise ClusterError("MODEL_UNAVAILABLE", "Model provider dependency is unavailable", 503)
    if provider == "openai_compatible":
        # 远程模型：只校验凭据是否配置（不发起实际请求，避免产生费用）
        if not os.environ.get(spec.get("api_key_env", "EMBEDDING_API_KEY")):
            raise ClusterError("MODEL_UNAVAILABLE", "Embedding API credential is not configured", 503)
    else:
        # 本地模型：校验文件清单与校验和
        verify_local_model(spec)


class EncoderRegistry:
    """按模型指纹缓存编码器实例，避免重复加载模型（本地模型加载很贵）。"""

    def __init__(self):
        self.instances = {}

    def get(self, spec, fingerprint):
        if fingerprint not in self.instances:
            check_model(spec)
            module, name, _ = PROVIDERS[spec["provider"]]
            cls = getattr(import_module(f"{__package__}.{module}"), name)
            try:
                self.instances[fingerprint] = cls(spec)
            except ClusterError:
                raise
            except Exception:
                # 底层异常可能包含路径等内部信息，统一替换为不泄漏细节的领域错误
                raise ClusterError(
                    "MODEL_UNAVAILABLE", "Model loading failed; inspect local model configuration", 503
                ) from None
        return self.instances[fingerprint]
