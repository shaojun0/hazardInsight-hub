"""构建知识库（离线一次性操作）。

流程：写"构建中"清单 -> 编码全部文本 -> 建集合并分批写入 -> 校验记录数 ->
补写内容校验和并标记完成。清单状态从 building 到 completed，读取方只会接受后者。
"""

from importlib.metadata import version
import uuid
from .chroma import kb_path, collection_checksum
from ..artifacts.runs import atomic_json
from ..artifacts.fingerprints import fingerprint, file_hash
from ..data.validation import validate_matrix


def build_knowledge_base(directory, ident, texts, encoder, model_fingerprint, dimension, source_path):
    import chromadb
    from chromadb.config import Settings

    path = kb_path(directory, ident)
    path.mkdir(parents=True, exist_ok=False)  # 绝不覆盖已存在的索引，避免半新半旧
    meta = {
        "schema_version": 1,
        "knowledge_base_id": ident,
        "status": "building",  # 先落一个"未完成"状态，中断时不会被误用
        "verification": "verified",
        "processing": "raw-lines-v1",
        "metric": "l2",  # 距离度量；与检索端的校验必须一致
        "model_fingerprint": model_fingerprint,
        "dimension": dimension,
        "count": len(texts),
        "source_sha256": file_hash(source_path),
        "texts_fingerprint": fingerprint(texts),
        "chromadb_version": version("chromadb"),  # 记录版本，便于排查索引兼容问题
        "index_origin": "new-current-environment",
    }
    atomic_json(path / "manifest.json", meta)
    values = validate_matrix(encoder.encode(texts), rows=len(texts), dimension=dimension)
    client = chromadb.PersistentClient(str(path / "index"), settings=Settings(anonymized_telemetry=False))
    collection = client.create_collection(
        name="micro", embedding_function=None, configuration={"hnsw": {"space": "l2"}}
    )
    # ID 用随机 UUID：知识库检索只需向量相似度，ID 本身无业务含义
    ids = [str(uuid.uuid4()) for _ in texts]
    # 分批写入，避免一次性提交导致内存峰值过高
    for start in range(0, len(texts), 2048):
        collection.add(ids=ids[start : start + 2048], embeddings=values[start : start + 2048])
    if collection.count() != len(texts):
        raise RuntimeError("Incomplete knowledge base insertion")
    # 全部写入成功后才记录校验和并置为 completed——这是"索引可用"的唯一凭证
    meta.update(status="completed", records_sha256=collection_checksum(collection))
    atomic_json(path / "manifest.json", meta)
    return meta
