"""向量编码后端。重依赖一律延迟到各实现的 ``__init__`` 中导入（torch/transformers 等）。"""

from .base import Encoder
from .openai_compatible import OpenAICompatibleEncoder
from .registry import EncoderRegistry
from .sccl import SCCLEncoder
from .sentence_transformer import SentenceTransformerEncoder
from .simcse import SimCSEEncoder

__all__ = [
    "Encoder",
    "EncoderRegistry",
    "OpenAICompatibleEncoder",
    "SCCLEncoder",
    "SentenceTransformerEncoder",
    "SimCSEEncoder",
]
