"""SimCSE 编码器：以 RoBERTa 为骨干，取 [CLS] 位置的向量作为句向量。

历史实现从 ``pytorch_model.bin`` 中只挑 ``encoder.*`` 前缀的权重加载，
这里原样保留该加载方式（而非用 AutoModel），因为官方的 head 层不参与编码，
换一种加载方式可能引入数值差异。
"""

import numpy as np
from .base import Encoder


class SimCSEEncoder(Encoder):
    def __init__(self, spec):
        import torch
        from transformers import AutoTokenizer, RobertaConfig, RobertaModel
        from pathlib import Path

        self.spec, self.torch = spec, torch
        self.tokenizer = AutoTokenizer.from_pretrained(spec["source"], local_files_only=True)
        config = RobertaConfig.from_pretrained(spec["source"], local_files_only=True)
        # 与原始封装保持一致的初始化方式与状态字典过滤策略
        holder = torch.nn.Module()
        holder.encoder = RobertaModel(config)
        state = torch.load(Path(spec["source"]) / "pytorch_model.bin", map_location="cpu", weights_only=True)
        # 只加载 encoder.* 前缀的权重，其余（如池化/分类头）忽略；strict=False 容忍缺失键
        holder.load_state_dict({k: v for k, v in state.items() if k.startswith("encoder.")}, strict=False)
        self.model = holder.to(spec.get("device", "cpu")).eval()

    def encode(self, texts):
        torch, spec = self.torch, self.spec
        values = []
        # 分批编码以控制显存/内存占用
        for start in range(0, len(texts), spec.get("batch_size", 256)):
            tokens = self.tokenizer(
                list(texts[start : start + spec.get("batch_size", 256)]),
                padding=True,  # 批内补齐到同一长度
                truncation=True,  # 超长截断
                max_length=spec.get("max_length", 128),
                return_tensors="pt",
            )
            with torch.no_grad():  # 推理模式，不建计算图，省内存
                output = self.model.encoder(
                    input_ids=tokens["input_ids"].to(spec.get("device", "cpu")),
                    attention_mask=tokens["attention_mask"].to(spec.get("device", "cpu")),
                )
                # 取 [CLS]（位置 0）的隐状态作为句向量，这是 SimCSE 的标准做法
                value = output.last_hidden_state[:, 0, :]
                if spec.get("normalize", False):
                    value = torch.nn.functional.normalize(value, p=2, dim=1)
            values.append(value.cpu().numpy())
        return np.concatenate(values, axis=0)
