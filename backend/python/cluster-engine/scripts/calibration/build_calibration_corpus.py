"""把 datas/ 下的原始资料整理成带真值标签的校准语料。

解析逻辑住在包里（``retrain_cluster.data.category_corpus``），本脚本只是一层薄 CLI：
这样"怎么解析"能被单元测试钉住，而"从哪读到哪写"留在运维侧。

两个来源、两种用途：

1. ``datas/rules/规则.txt`` 的 ``c`` 段 —— 本仓库里唯一成规模、带人工分类的
   中文短文本集合，用作阈值扫描的**主语料**（二级分类当主题真值）。
2. ``datas/test/隐患抽样_抽样50条.csv`` —— 真实隐患描述（长文本、含日期与项目号
   等噪声），只用一级分类当粗粒度真值。它**不参与选阈值**，只用来复核
   "换到真实文本上没退化"。

用法::

    python build_calibration_corpus.py --data-dir ../../datas --output-dir artifacts/calibration/corpus
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ENGINE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE_ROOT / "src"))

from retrain_cluster.data.category_corpus import (  # noqa: E402
    describe_corpus,
    load_category_corpus,
    load_field_corpus,
)

#: 相对仓库根的默认数据目录。
DEFAULT_DATAS = "datas"


def build(data_dir: Path) -> list[dict]:
    """构建全部语料；缺哪个文件就直接报错，不静默产出半份语料。"""

    rules = data_dir / "rules" / "规则.txt"
    samples = data_dir / "test" / "隐患抽样_抽样50条.csv"
    missing = [str(path) for path in (rules, samples) if not path.is_file()]
    if missing:
        raise SystemExit("缺少输入文件：\n  " + "\n  ".join(missing))
    return [load_category_corpus(rules), load_field_corpus(samples)]


def main() -> int:
    parser = argparse.ArgumentParser(description="构建语义阈值校准语料")
    parser.add_argument("--data-dir", default=None, help="datas 目录（默认取仓库根的 datas）")
    parser.add_argument("--output-dir", required=True, help="语料 JSON 输出目录")
    args = parser.parse_args()

    repo_root = ENGINE_ROOT.parents[2]
    data_dir = Path(args.data_dir).resolve() if args.data_dir else repo_root / DEFAULT_DATAS
    if not data_dir.is_dir():
        parser.error(f"数据目录不存在：{data_dir}")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for corpus in build(data_dir):
        print(describe_corpus(corpus))
        print()
        path = output_dir / f"corpus_{corpus['name'].replace('-', '_')}.json"
        path.write_text(json.dumps(corpus, ensure_ascii=False, indent=2), encoding="utf-8")
        written.append(path)

    print("已写出：")
    for path in written:
        print(f"  {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
