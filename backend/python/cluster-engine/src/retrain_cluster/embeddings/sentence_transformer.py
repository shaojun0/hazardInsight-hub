"""基于 sentence-transformers 的本地编码器（BGE 等模型走这条路）。"""

from .base import Encoder


class SentenceTransformerEncoder(Encoder):
    def __init__(self, spec):
        from sentence_transformers import SentenceTransformer

        self.spec = spec
        # local_files_only=True：只从本地目录加载，绝不静默联网下载，
        # 否则"用了哪个模型"会变得不可控，破坏可复现性
        self.model = SentenceTransformer(spec["source"], device=spec.get("device", "cpu"), local_files_only=True)
        if spec.get("max_length"):
            self.model.max_seq_length = spec["max_length"]

    def encode(self, texts):
        return self.model.encode(
            list(texts),
            batch_size=self.spec.get("batch_size", 256),
            show_progress_bar=False,
            normalize_embeddings=self.spec.get("normalize", False),
        )
