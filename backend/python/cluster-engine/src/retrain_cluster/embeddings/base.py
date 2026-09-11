"""编码器协议（扩展点）。

用 ``Protocol`` 而非 ABC：只声明"必须有 encode 方法"这一契约，不强制继承，
因此测试里可以传入任意鸭子类型的替身（见 tests.conftest.FixedEncoder），
同时 ``isinstance`` 检查依然可用。
"""

from typing import Protocol, Sequence, runtime_checkable
import numpy as np


@runtime_checkable
class Encoder(Protocol):
    """嵌入后端的扩展点。

    实现通过 ``EncoderRegistry`` 解析；继承本 Protocol 是为了记录契约并支持
    ``isinstance`` 检查，但不会限制鸭子类型的替代实现
    （见 tests.conftest.FixedEncoder）。
    """

    def encode(self, texts: Sequence[str]) -> np.ndarray: ...
