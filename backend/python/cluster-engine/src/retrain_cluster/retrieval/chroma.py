"""基于 ChromaDB 的知识库检索。

安全与一致性是这里的重点：
  * ``kb_path`` 用白名单正则校验知识库标识，杜绝路径穿越；
  * 打开索引后做三重一致性校验（记录数、距离度量空间、内容校验和），
    确保索引与清单描述的完全一致，防止"检索到过期/错配的向量"。
"""

import json
from pathlib import Path
import re
import numpy as np
from ..artifacts.fingerprints import fingerprint, array_hash
from ..data.validation import validate_matrix
from ..errors import ClusterError
from ..types import NeighborBatch
from .base import Retriever


def kb_path(root, ident):
    """把知识库标识映射为目录，并做严格格式校验（防路径穿越）。"""
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", ident):
        raise ClusterError("INVALID_PROFILE", "Invalid knowledge base identifier", 422)
    return Path(root) / ident


def read_manifest(root, ident, model_fingerprint, dimension):
    """读取并校验知识库清单，返回 (目录, 清单)。

    校验项覆盖：构建完成、已核验、模型指纹一致、维度一致、度量空间为 l2、记录非空。
    任一不符都视为"知识库不可用"，而不是静默使用——错配的向量会得出完全错误的聚类。
    """
    path = kb_path(root, ident)
    try:
        meta = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
        if (
            meta["status"] != "completed"
            or meta["verification"] != "verified"
            or meta["model_fingerprint"] != model_fingerprint
            or meta["dimension"] != dimension
            or meta["metric"] != "l2"
            or meta["count"] < 1
        ):
            raise ValueError("incompatible knowledge base")
        return path, meta
    except (OSError, ValueError, KeyError):
        raise ClusterError(
            "KNOWLEDGE_BASE_UNAVAILABLE", "Knowledge base is missing, unverified or incompatible", 503
        ) from None


def collection_checksum(collection):
    """计算整个集合的内容指纹。

    先按 ID 排序再取向量，保证与插入顺序、存储顺序无关——这样同一批数据无论
    何时写入，算出的校验和都相同。
    """
    data = collection.get(include=["embeddings"])
    order = sorted(range(len(data["ids"])), key=lambda i: data["ids"][i])
    vectors = np.asarray(data["embeddings"])[order]
    return fingerprint({"ids": [data["ids"][i] for i in order], "vectors": array_hash(vectors)})


class ChromaRetriever(Retriever):
    def __init__(self, root, ident, model_fingerprint, dimension):
        import chromadb
        from chromadb.config import Settings

        path, self.manifest = read_manifest(root, ident, model_fingerprint, dimension)
        self.ident, self.dimension = ident, dimension
        try:
            # embedding_function=None：向量由本流程提供，绝不使用 Chroma 内置的默认模型
            self.client = chromadb.PersistentClient(str(path / "index"), settings=Settings(anonymized_telemetry=False))
            self.collection = self.client.get_collection(name="micro", embedding_function=None)
            config = self.collection.configuration
            # 三重校验：记录数、HNSW 距离空间、内容校验和都必须与清单一致
            if (
                self.collection.count() != self.manifest["count"]
                or config.get("hnsw", {}).get("space") != "l2"
                or collection_checksum(self.collection) != self.manifest["records_sha256"]
            ):
                raise ValueError("index mismatch")
        except Exception:
            raise ClusterError(
                "KNOWLEDGE_BASE_UNAVAILABLE", "Knowledge base integrity verification failed", 503
            ) from None

    def query(self, vectors, k):
        """查询每个向量的 k 个最近邻。"""
        if k < 1 or k > self.manifest["count"]:
            raise ClusterError("INVALID_PROFILE", "Neighbor count exceeds knowledge base size", 422)
        vectors = validate_matrix(vectors, dimension=self.dimension)
        result = self.collection.query(query_embeddings=vectors.tolist(), n_results=k, include=["embeddings"])
        return NeighborBatch(result["ids"], result["embeddings"], self.ident)
