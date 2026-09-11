"""SCCL 编码器：与 SimCSE 的主要差异是**用注意力掩码做平均池化**（而非取 [CLS]）。

平均池化时需排除 padding 位置：掩码为 0 的 token 不参与求和，
否则补齐用的占位 token 会稀释句向量。
"""

import numpy as np
from .base import Encoder


class SCCLEncoder(Encoder):
    def __init__(self, spec):
        import torch
        from transformers import AutoModel, AutoTokenizer

        self.spec, self.torch = spec, torch
        # 显式指定本地 tokenizer 目录：不做静默下载与回退
        self.tokenizer = AutoTokenizer.from_pretrained(
            spec.get("tokenizer_source", spec["source"]), local_files_only=True
        )
        self.model = (
            AutoModel.from_pretrained(spec["source"], local_files_only=True).to(spec.get("device", "cpu")).eval()
        )

    def encode(self, texts):
        torch, spec = self.torch, self.spec
        values = []
        batch = spec.get("batch_size", 256)
        for start in range(0, len(texts), batch):
            tokens = self.tokenizer(
                list(texts[start : start + batch]),
                padding=True,
                truncation=True,
                max_length=spec.get("max_length", 128),
                return_tensors="pt",
            )
            mask = tokens["attention_mask"].to(spec.get("device", "cpu"))
            with torch.no_grad():
                output = self.model(input_ids=tokens["input_ids"].to(spec.get("device", "cpu")), attention_mask=mask)
                # 掩码加权平均池化：expanded 把 0/1 掩码扩展到特征维度，
                # 先屏蔽 padding 位再求和，最后除以有效 token 数
                expanded = mask.unsqueeze(-1)
                value = torch.sum(output.last_hidden_state * expanded, dim=1) / torch.sum(expanded, dim=1)
                if spec.get("normalize", False):
                    value = torch.nn.functional.normalize(value, p=2, dim=1)
            values.append(value.cpu().numpy())
        return np.concatenate(values, axis=0)
