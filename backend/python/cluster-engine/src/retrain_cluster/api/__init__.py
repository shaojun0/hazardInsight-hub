"""HTTP 接口层。

``app`` 会导入 FastAPI，因此这里用 ``__getattr__`` 做**惰性解析**：
只有真正访问某个符号时才导入对应子模块，使 ``import retrain_cluster.api`` 本身不拉入
fastapi/uvicorn 这类可选重依赖（由 test_package_api 守护这一约定）。
"""

from importlib import import_module

# 符号名 -> 所属子模块
_MODULES = {
    "create_app": ".app",
    "RequestBoundary": ".app",
    "SyncExecutor": ".execution",
    "router": ".routes",
}

__all__ = sorted(_MODULES)


def __getattr__(name):
    """模块级属性访问钩子：按需导入并缓存到模块命名空间。"""
    target = _MODULES.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(import_module(target, __name__), name)
