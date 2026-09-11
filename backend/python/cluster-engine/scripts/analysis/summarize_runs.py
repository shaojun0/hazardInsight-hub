"""汇总 ``artifacts/runs`` 下的所有运行记录。

只读产物文件，不重新聚类、不调用嵌入服务、不接触 ``data/`` 输入。识别两种产物布局：

  * 实验运行（由 ExperimentService 写出）
      manifest.json, best.json, trials.json, profile.json, test.json
  * 服务运行（由 RunStore 写出）
      带 result_sha256 与 status 的 manifest.json, result.json

用法：
    python scripts/analysis/summarize_runs.py
    python scripts/analysis/summarize_runs.py --config configs/app.toml
    python scripts/analysis/summarize_runs.py --artifacts-dir artifacts --output summary.json
"""

import argparse
import json
from pathlib import Path

from retrain_cluster.artifacts.fingerprints import file_hash
from retrain_cluster.artifacts.runs import atomic_json
from retrain_cluster.config import Settings


def load_json(path):
    """读取并解析 JSON；文件缺失或格式错误时返回 None（不抛异常）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def verify_integrity(directory, manifest):
    """对单个运行目录做完整性检查，返回问题描述列表（空列表表示健康）。"""
    problems = []
    for name in ("manifest.json",):
        if not (directory / name).is_file():
            problems.append("missing " + name)
    result = directory / "result.json"
    expected = manifest.get("result_sha256")
    # 清单声明了结果哈希时，结果文件必须存在且哈希一致
    if expected:
        if not result.is_file():
            problems.append("missing result.json referenced by manifest")
        elif file_hash(result) != expected:
            problems.append("result.json checksum mismatch")
    # 可选产物若存在则必须是合法 JSON（半截文件说明写入被中断）
    for optional in ("best.json", "test.json", "trials.json"):
        path = directory / optional
        if path.is_file() and load_json(path) is None:
            problems.append(optional + " is not valid JSON")
    return problems


def summarize(directory):
    """把一个运行目录概括成一行字典，缺失字段用 None 占位。"""
    manifest = load_json(directory / "manifest.json") or {}
    status = manifest.get("status", "unknown")
    problems = verify_integrity(directory, manifest)
    profile = manifest.get("profile") or {}
    search = manifest.get("search") or {}
    test = load_json(directory / "test.json") or {}
    metrics = test.get("metrics") or {}
    best = load_json(directory / "best.json") or {}
    return {
        "run_id": directory.name,
        "kind": manifest.get("kind", "unknown"),
        "status": status,
        "algorithm": profile.get("algorithm", "-"),
        "n_results": search.get("n_results"),
        "pca_dim": search.get("pca_dim"),
        "elapsed_seconds": round(manifest.get("elapsed_seconds") or -1, 2),
        "n_clusters": metrics.get("n_clusters"),
        "noise_ratio": metrics.get("noise_ratio"),
        "ari": metrics.get("ari"),
        "nmi": metrics.get("nmi"),
        "v_measure": metrics.get("v_measure"),
        "score": metrics.get("score"),
        "n_samples": len(test.get("labels") or []),
        "n_trials": len(best or {}),
        "integrity": problems,
    }


def format_table(rows):
    """把行列表渲染成等宽对齐的文本表格。"""
    columns = ["run_id", "algorithm", "n_results", "status", "n_clusters", "ari", "nmi", "score", "noise_ratio"]
    # 每列宽度 = 该列内容的最大显示宽度（含表头），保证对齐
    widths = {name: max(len(name), *(len(str(row[name])) for row in rows)) if rows else len(name) for name in columns}
    lines = ["  ".join(name.rjust(widths[name]) for name in columns)]

    def render(value, width):
        # 浮点统一保留 4 位小数，便于纵向比较
        if isinstance(value, float):
            value = f"{value:.4f}"
        return str(value).rjust(width)

    for row in rows:
        lines.append("  ".join(render(row[name], widths[name]) for name in columns))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", default=None, help="configs/app.toml that defines artifacts_dir")
    parser.add_argument("--artifacts-dir", default=None, help="override artifacts directory")
    parser.add_argument("--sort", default="run_id", choices=["run_id", "ari", "score", "nmi", "elapsed_seconds"])
    parser.add_argument("--output", default=None, help="also write the summary as JSON")
    parser.add_argument("--only-broken", action="store_true", help="print runs failing integrity checks only")
    args = parser.parse_args(argv)

    runs = (
        Path(args.artifacts_dir).resolve() / "runs"
        if args.artifacts_dir
        else Settings.load(args.config).artifacts_dir / "runs"
    )
    if not runs.is_dir():
        print(f"No runs directory found at {runs}")
        return 1

    rows = [summarize(directory) for directory in sorted(runs.glob("run_*")) if directory.is_dir()]
    if not rows:
        print(f"No run_* directories found under {runs}")
        return 1

    broken = [row for row in rows if row["integrity"]]
    # 排序键：(该字段是否为 None, 字段值)。None 排到最后，避免缺失值干扰比较；
    # 指标类字段用降序（越大越好），时间/ID 类用升序。
    rows.sort(key=lambda row: (row[args.sort] is None, row[args.sort]), reverse=args.sort in {"ari", "score", "nmi"})

    print(f"Scanned {len(rows)} run(s) in {runs}")
    print(format_table(broken if args.only_broken else rows))
    if broken:
        print(f"\n{len(broken)} run(s) failed integrity checks:")
        for row in broken:
            print(f"  {row['run_id']}: {', '.join(row['integrity'])}")

    if args.output:
        atomic_json(args.output, rows)
        print(f"\nWrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
