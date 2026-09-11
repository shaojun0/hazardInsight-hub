"""最近邻检索后端。

检索器只处理向量，绝不能接触标签、评分或算法参数——这是保证"检索增强不偷用监督信息"的边界。
"""

from .base import Retriever
from .build import build_knowledge_base
from .chroma import ChromaRetriever, collection_checksum, kb_path, read_manifest

__all__ = [
    "ChromaRetriever",
    "Retriever",
    "build_knowledge_base",
    "collection_checksum",
    "kb_path",
    "read_manifest",
]
