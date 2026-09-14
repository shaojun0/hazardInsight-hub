"""把扫描结果固化成 ``semantic-calibration-v1.json`` 的正式条目。

为什么要有这一步：实施计划要求「生产 profile 必须固化校准结果；没有校准产物时
仅标记 experimental」。手工改 JSON 会让"阈值从哪来"变成口口相传——
所以固化动作本身也做成脚本，它负责：

1. 从扫描结果里取推荐阈值（只取**影响标签**的那几个，权重类保持原样）；
2. 计算 ``source_fingerprint``：把语料内容、扫描协议、profile 参数、模型与阈值
   一起哈希。换了语料或改了参数，指纹必变，于是"这次校准是哪份数据得出的"
   永远可查；
3. 写回 ``status``（默认 ``validated``）与 ``scope`` 里的校准依据。

``--dry-run`` 只打印将要发生的变更，不落盘。

用法::

    python freeze_calibration.py --results ../../artifacts/calibration/results/sweep-pca64.json \\
        --spec sweep-spec.json --corpus-dir ../../artifacts/calibration/corpus \\
        --calibration ../../configs/semantic-calibration-v1.json --dry-run
"""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path

#: 会被固化进校准文件的阈值键。``t_margin`` 只影响归属置信度的展示口径、
#: 不改变任何标签，因此不在扫描结论里覆盖它。
CALIBRATED_KEYS = ("t_sem", "t_pair", "t_merge", "t_single")


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def source_fingerprint(payload: dict) -> str:
    """对"校准依据"取指纹：排序键 + 紧凑分隔符，保证同样的输入得到同样的结果。"""

    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def collect_basis(results: dict, spec_path: Path | None, corpus_dir: Path) -> dict:
    """汇总"本次校准基于什么"，任何一项变化都会改变指纹。"""

    corpora = []
    for entry in results.get("corpora", []):
        name = entry["name"]
        path = corpus_dir / f"corpus_{name.replace('-', '_')}.json"
        corpora.append(
            {
                "name": name,
                "items": entry["items"],
                "sha256": sha256_of(path) if path.is_file() else None,
            }
        )
    return {
        "schema": "semantic-calibration-source-v1",
        "profile_id": results["profile_id"],
        "model_id": results["model_id"],
        "algorithm_params": results.get("profile_algorithm_params"),
        "param_overrides": results.get("profile_param_overrides") or {},
        "label_fields": results.get("label_fields"),
        "corpora": corpora,
        "spec_sha256": sha256_of(spec_path) if spec_path and spec_path.is_file() else None,
        "thresholds": {key: results["recommendation"]["thresholds"][key] for key in CALIBRATED_KEYS},
    }


def build_scope(previous: str | None, results: dict, fingerprint: str, prerequisite: str | None = None) -> str:
    """口径说明里补上"这份校准是怎么来的"，同时保留原有的模型/推理口径描述。

    ``prerequisite`` 是**适用前提**：校准只能在某种条件下成立时（例如降维必须
    真正启用），这段文字会被一并写进 ``scope``。它不参与指纹——决定标签的
    条件已经以 ``param_overrides`` 的形式进了指纹，这里只是让读配置的人
    不必反查扫描记录就知道边界在哪。
    """

    objective = results["recommendation"].get("objective") or {}
    corpora = "、".join(f"{item['name']}({item['items']})" for item in results.get("corpora", []))
    overrides = results.get("profile_param_overrides") or {}
    override_text = "、".join(f"{key}={value}" for key, value in overrides.items()) or "无"
    basis = (
        f"校准依据：{objective.get('corpus')} 的 {objective.get('field')} 层级"
        f"（{objective.get('split')} 切分），"
        f"B-cubed F1={objective.get('b_cubed_f1')}、"
        f"稀有主题召回={objective.get('rare_topic_recall')}；"
        f"语料 {corpora}；"
        f"扫描参数覆盖 {override_text}；"
        f"source_fingerprint={fingerprint[:16]}…（全值见配置字段）。"
    )
    original = (previous or "").strip()
    if "校准依据：" in original:
        original = original.split("校准依据：")[0].strip()
    text = f"{original}{' ' if original else ''}{basis}".strip()
    if prerequisite:
        text = f"{text} 适用前提：{prerequisite.strip()}"
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description="固化语义阈值校准")
    parser.add_argument("--results", required=True, help="扫描结果 JSON（sweep_thresholds.py 的产出）")
    parser.add_argument("--calibration", required=True, help="semantic-calibration-v1.json 路径")
    parser.add_argument("--version", default="semantic-calibration-v1")
    parser.add_argument("--spec", default=None, help="扫描 spec（可选，进指纹）")
    parser.add_argument("--corpus-dir", default=None, help="语料 JSON 目录（默认与 results 同级的 corpus/）")
    parser.add_argument("--status", default="validated", choices=["validated", "experimental"])
    parser.add_argument(
        "--prerequisite",
        default=None,
        help="适用前提，写进 scope（例如：本校准仅在降维真正启用时成立）。不参与指纹。",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    results_path = Path(args.results).resolve()
    results = load_json(results_path)
    recommendation = results.get("recommendation")
    if not recommendation:
        raise SystemExit("扫描结果里没有 recommendation，无法固化")

    calibration_path = Path(args.calibration).resolve()
    document = load_json(calibration_path)
    versions = document.get("versions") or {}
    if args.version not in versions:
        raise SystemExit(f"校准文件里没有版本 {args.version}")

    corpus_dir = Path(args.corpus_dir).resolve() if args.corpus_dir else results_path.parent.parent / "corpus"
    basis = collect_basis(results, Path(args.spec).resolve() if args.spec else None, corpus_dir)
    fingerprint = source_fingerprint(basis)

    entry = versions[args.version]
    before = {key: (entry.get("thresholds") or {}).get(key) for key in CALIBRATED_KEYS}
    before["status"] = entry.get("status")
    before["source_fingerprint"] = entry.get("source_fingerprint")

    entry["thresholds"] = {**entry.get("thresholds", {}), **{
        key: float(recommendation["thresholds"][key]) for key in CALIBRATED_KEYS
    }}
    entry["model_id"] = results["model_id"]
    entry["status"] = args.status
    entry["source_fingerprint"] = fingerprint
    entry["scope"] = build_scope(entry.get("scope"), results, fingerprint, args.prerequisite)
    entry.pop("calibrated_at", None)  # 不引入 schema 未声明的字段：SemanticCalibration 会拒绝未知键

    after = {key: entry["thresholds"][key] for key in CALIBRATED_KEYS}
    after["status"] = entry["status"]
    after["source_fingerprint"] = fingerprint

    print("变更前的阈值 / 状态：")
    for key, value in before.items():
        print(f"  {key:<19} {value}")
    print("变更后：")
    for key, value in after.items():
        print(f"  {key:<19} {value if key != 'source_fingerprint' else value[:16] + '…'}")
    print(f"\n校准依据指纹 {fingerprint}")
    print(f"依据明细 {json.dumps(basis, ensure_ascii=False, indent=2)}")

    if args.dry_run:
        print("\n--dry-run：未写入。")
        return 0

    document["versions"][args.version] = entry
    calibration_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n已写入 {calibration_path}（{date.today().isoformat()}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
