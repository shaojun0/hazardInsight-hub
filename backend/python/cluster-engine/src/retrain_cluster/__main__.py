"""支持 ``python -m retrain_cluster`` 的执行入口。"""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
