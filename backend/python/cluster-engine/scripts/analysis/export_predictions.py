"""把某次运行的预测簇标签导出为 CSV，供人工复核。

只读 ``artifacts/runs/<run_id>/test.json``。不重新聚类、不调用嵌入服务，
也不访问 ``data/`` 下的输入文件。

CSV 每行一个样本：sample_id, cluster_id, cluster_size。行按簇规模从大到小排序，
使最大的簇排在最前；-1 表示噪声，无论规模大小一律排在最后。

用法：
    python scripts/analysis/export_predictions.py --run run_<hex32> --output clusters.csv
    python scripts/analysis/export_predictions.py --run run_<hex32> --output clusters.csv --summary 20
"""

import argparse
import csv
import json
from collections import Counter
from pathlib import Path

from retrain_cluster.config import Settings


def read_prediction(runs, run_id):
    """读取并校验预测文件，返回 (原始载荷, 样本 ID 列表, 标签列表)。"""
    path = runs / run_id / "test.json"
    if not path.is_file():
        raise SystemExit(f"No test.json found at {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    sample_ids = payload.get("sample_ids") or []
    labels = payload.get("labels") or []
    # 两者长度必须一致，否则后续 zip 会静默丢掉数据
    if len(sample_ids) != len(labels):
        raise SystemExit(f"sample_ids ({len(sample_ids)}) and labels ({len(labels)}) have different lengths")
    return payload, sample_ids, labels


def write_csv(destination, sample_ids, labels):
    """写出 CSV，并返回 (各簇规模, 排序后的簇编号列表)。

    排序键 ``(label == -1, -size, label)`` 的含义：
    先让噪声（-1）排到最后，再按簇规模降序，规模相同时按簇编号升序——
    保证结果稳定可复现。
    """
    sizes = Counter(labels)
    order = sorted(sizes, key=lambda label: (label == -1, -sizes[label], label))
    rows = sorted(
        ((sid, label) for sid, label in zip(sample_ids, labels)),
        key=lambda item: (order.index(item[1]), item[0]),
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["sample_id", "cluster_id", "cluster_size"])
        for sample_id, label in rows:
            writer.writerow([sample_id, label, sizes[label]])
    return sizes, order


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run", required=True, help="run_id, e.g. run_<32 hex chars>")
    parser.add_argument("--config", default=None, help="configs/app.toml that defines artifacts_dir")
    parser.add_argument("--artifacts-dir", default=None, help="override artifacts directory")
    parser.add_argument("--output", required=True, help="destination CSV path")
    parser.add_argument("--summary", type=int, default=10, help="how many clusters to preview")
    args = parser.parse_args(argv)

    # 优先使用显式指定的产物目录，否则从配置解析
    if args.artifacts_dir:
        runs = Path(args.artifacts_dir).resolve() / "runs"
    else:
        runs = Settings.load(args.config).artifacts_dir / "runs"

    payload, sample_ids, labels = read_prediction(runs, args.run)
    sizes, order = write_csv(Path(args.output), sample_ids, labels)

    # 非噪声样本即"真正被归入某个簇"的样本
    effective = [label for label in labels if label != -1]
    print(f"Wrote {args.output}: {len(labels)} rows, {len(sizes) - (1 if -1 in sizes else 0)} clusters")
    if payload.get("metrics"):
        pretty = ", ".join(
            f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}" for k, v in payload["metrics"].items()
        )
        print(f"Run metrics: {pretty}")
    print(f"Clustered rows: {len(effective)}; noise rows: {len(labels) - len(effective)}")
    for label in order[: args.summary]:
        print(f"  cluster {label}: {sizes[label]} samples")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
