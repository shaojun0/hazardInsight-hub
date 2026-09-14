"""语义阈值扫描：用真实语料给 semantic-calibration-v1 的判据定标。

设计原则：**不重写任何算法**。脚本构造真实
``SemanticAutoKMeansStrategy``，然后只在每次运行前替换
``strategy.calibration``（``dataclasses.replace``，会重跑 ``__post_init__``
的单调性校验，非法组合直接抛错跳过）。规范化、去重、编码、PCA、Auto-K、
后处理、命名全部走线上同一份实现，因此扫描结论对线上成立。

便宜的原因：文本级 embedding 缓存是跨候选复用的——同一份语料只在
第一次编码时付推理成本，后续每个候选只跑聚类与后处理。

评分用 ``evaluation.semantic_metrics.offline_report``（ARI/NMI/AMI、
配对 P/R/F1、B-cubed F1、噪声 P/R、稀有主题召回）。**B-cubed 把 ``-1``
当普通标签**，所以"全判噪声"和"全并成一簇"这两种退化解都拿不到高分，
不需要额外惩罚项。

选优规则（刻意写得可审计，不发明权重）：

1. 主指标 = calibration 与 holdout 两个切分上、``label_fields[0]`` 层级的
   B-cubed F1 **均值**（只看一半会让另一半语料失去意义，实测确有候选在
   两半上排序相反）；
2. 在距最优 ``TIE_WINDOW`` 以内的候选里，取稀有主题召回最高的那个
   —— 小主题被整体判噪声是本项目已知的失败模式，值得在几乎同等精度下优先；
3. 仍并列时比配对 F1；
4. 再并列则取**距基线 L1 距离最小**者。实测 ``t_pair`` 在 [0.30, 0.65]
   上指标几乎完全相同，只靠前三项会按候选入池顺序落到网格边界的
   ``0.30`` 上，那是外推不是结论；优先"离现状最近"可把改动量压到最小，
   也让结论不依赖扫描顺序。

spec JSON 的形状::

    {
      "profile_id": "bge-large-semantic-auto-kmeans-v1",
      "corpora": ["...corpus_rule_categories.json"],
      "label_field": "l2",
      "stages": [
        {"name": "t_sem", "from": "baseline", "mode": "oat",
         "values": {"t_sem": [0.60, 0.65, 0.70]}}
      ]
    }

用法::

    python sweep_thresholds.py --spec spec.json --output results.json
"""

from __future__ import annotations

from dataclasses import replace
import argparse
from datetime import datetime, timezone
import itertools
import json
from pathlib import Path
import sys
import time

import numpy as np

ENGINE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE_ROOT / "src"))

from retrain_cluster.artifacts.text_cache import TextEmbeddingCache  # noqa: E402
from retrain_cluster.config import Catalog, Settings  # noqa: E402
from retrain_cluster.embeddings.registry import EncoderRegistry  # noqa: E402
from retrain_cluster.errors import ClusterError  # noqa: E402
from retrain_cluster.evaluation.semantic_metrics import offline_report  # noqa: E402
from retrain_cluster.services.strategies import build_strategy  # noqa: E402

#: 阈值键（顺序即单调性约束涉及的键）。
THRESHOLD_KEYS = ("t_sem", "t_pair", "t_merge", "t_margin", "t_single")

#: 并列窗口：主指标相差不超过它就认为"统计上并列"，改用次指标裁决。
TIE_WINDOW = 0.01

#: 参与排名的指标路径：``metrics[路径]``。
PRIMARY_METRIC = "b_cubed_f1"
SECONDARY_METRIC = "rare_topic_recall"
TERTIARY_METRIC = "pairwise_f1"


def load_corpus(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not payload.get("items"):
        raise SystemExit(f"语料为空：{path}")
    return payload


def resolve_corpus_path(value: str) -> Path:
    """spec 里的语料路径允许写成相对仓库根，避免把绝对路径写进版本库。"""

    path = Path(value)
    if path.is_absolute():
        return path
    repo_root = ENGINE_ROOT.parents[2]
    candidate = repo_root / path
    return candidate if candidate.exists() else ENGINE_ROOT / path


def encode_labels(values: list[str]) -> tuple[np.ndarray, dict[str, int]]:
    """把字符串标签映射成连续整数——指标算子内部按 ``int(label)`` 处理。"""

    vocabulary = {label: index for index, label in enumerate(sorted(set(values)))}
    return np.array([vocabulary[label] for label in values], dtype=np.int64), vocabulary


def align(result: dict, corpus: dict, *, field: str, split: str) -> tuple[np.ndarray, np.ndarray, int]:
    """把引擎产出的 ``assignments`` 与语料真值按 ``id`` 对齐。

    返回 ``(预测标签, 真值标签, 参与评估的样本数)``。缺失真值（如三级分类为 None）
    或不在该切分里的样本会被排除——不让"没标注的样本"污染指标。
    """

    predicted = {str(item["id"]): int(item["cluster_id"]) for item in result.get("assignments", [])}
    predicted_labels, truth_labels = [], []
    for item in corpus["items"]:
        if item.get("split") != split:
            continue
        truth = item.get("labels", {}).get(field)
        if not truth:
            continue
        if str(item["id"]) not in predicted:
            continue
        predicted_labels.append(predicted[str(item["id"])])
        truth_labels.append(truth)
    if not predicted_labels:
        raise ClusterError("EMPTY_DATASET", f"No items to evaluate for {field}/{split}", 422)
    truth_encoded, _ = encode_labels(truth_labels)
    return np.array(predicted_labels, dtype=np.int64), truth_encoded, len(predicted_labels)


def evaluate(result: dict, corpora: list[dict], *, fields: list[str], splits: list[str]) -> dict:
    """对一次运行的产出算全部 (语料 × 层级 × 切分) 的离线指标。"""

    summary = result.get("semantic", {}).get("summary", {})
    report = {
        "summary": {
            "final_k": summary.get("final_k"),
            "selected_k": summary.get("selected_k"),
            "noise_ratio": summary.get("noise_ratio"),
            "coverage": summary.get("coverage"),
            "quality_score": summary.get("quality_score"),
            "auto_k_status": summary.get("auto_k_status"),
            "largest_cluster_size": summary.get("largest_cluster_size"),
        },
        "splits": {},
    }
    for corpus in corpora:
        for field in fields:
            for split in splits:
                key = f"{corpus['name']}::{field}::{split}"
                try:
                    predicted, truth, count = align(result, corpus, field=field, split=split)
                except ClusterError:
                    continue
                metrics = offline_report(predicted, truth)
                metrics["assigned_only_f1"] = (metrics.get("assigned_only") or {}).get("b_cubed_f1")
                metrics["evaluated"] = count
                report["splits"][key] = metrics
    return report


def primary_metrics(report: dict, corpus_name: str, field: str) -> dict | None:
    return report["splits"].get(f"{corpus_name}::{field}::calibration")


def ranking_metrics(report: dict, corpus_name: str, field: str) -> dict | None:
    """排序用的指标：主指标取**两个切分** B-cubed F1 的均值。

    只用一个切分挑阈值，等于让另一半语料失去意义——留出切分存在的唯一理由
    就是防止"在单一切分上挑到偶然值"。实测也确实如此：某些候选在
    calibration 上更好、在 holdout 上更差，只看一半会得到相反的结论。
    """

    calibration = primary_metrics(report, corpus_name, field)
    if calibration is None:
        return None
    holdout = report["splits"].get(f"{corpus_name}::{field}::holdout") or {}
    values = [calibration.get(PRIMARY_METRIC)]
    if holdout.get(PRIMARY_METRIC) is not None:
        values.append(holdout[PRIMARY_METRIC])
    return {
        "primary": sum(value for value in values if value is not None) / len(values),
        "calibration": calibration,
        "holdout": holdout,
    }


def rank(rows: list[dict], *, corpus_name: str, field: str, baseline: dict | None = None) -> dict | None:
    """按文档里的规则挑最优候选。

    排序键依次是：主指标（两切分 B-cubed F1 均值）→ 稀有主题召回 → 成对 F1 →
    **距基线的 L1 距离（越近越优）**。最后这一项是为平坦响应面准备的：
    实测 ``t_pair`` 在 [0.30, 0.65] 上指标几乎完全相同，只靠前三项会按
    候选入池顺序随便挑到一个**网格边界**值，那是外推而不是结论。
    在指标无法区分时选"离现状最近"的那个，等于把改动量压到最小，
    结论也更可复现（不再依赖扫描顺序）。
    """

    scored = []
    for row in rows:
        metrics = ranking_metrics(row["report"], corpus_name, field)
        if metrics is None:
            continue
        scored.append((row, metrics))
    if not scored:
        return None
    best = max(metrics["primary"] for _, metrics in scored)
    window = [(row, metrics) for row, metrics in scored if metrics["primary"] >= best - TIE_WINDOW]

    def distance(row: dict) -> float:
        if not baseline:
            return 0.0
        return sum(abs(float(row["thresholds"][key]) - float(baseline[key])) for key in THRESHOLD_KEYS)

    winner, _ = max(
        window,
        key=lambda pair: (
            pair[1]["calibration"].get(SECONDARY_METRIC) or 0.0,
            pair[1]["calibration"].get(TERTIARY_METRIC) or 0.0,
            -distance(pair[0]),
        ),
    )
    return winner


def candidates_for_stage(stage: dict, start: dict) -> list[dict]:
    """按 ``mode`` 生成候选阈值。所有候选都从 ``start`` 出发只改指定键。"""

    values: dict[str, list[float]] = {key: list(value) for key, value in stage["values"].items()}
    unknown = set(values) - set(THRESHOLD_KEYS)
    if unknown:
        raise SystemExit(f"阶段 {stage['name']} 含未知阈值键：{sorted(unknown)}")

    produced: list[dict] = []
    seen: set[tuple] = set()
    if stage.get("mode", "oat") == "oat":
        for key, options in values.items():
            for option in options:
                produced.append({**start, key: float(option)})
    else:
        keys = list(values)
        for combination in itertools.product(*(values[key] for key in keys)):
            produced.append({**start, **dict(zip(keys, (float(value) for value in combination)))})

    unique = []
    for thresholds in produced:
        token = tuple(round(float(thresholds[key]), 6) for key in THRESHOLD_KEYS)
        if token in seen:
            continue
        seen.add(token)
        unique.append(thresholds)
    return unique


def run_candidate(strategy, base_calibration, items: list[dict], thresholds: dict) -> tuple[dict, float]:
    """替换 calibration 后跑一次真实策略，返回 ``(结果, 耗时毫秒)``。"""

    strategy.calibration = replace(base_calibration, **{key: float(value) for key, value in thresholds.items()})
    started = time.monotonic()
    result = strategy.run(items)
    return result, round((time.monotonic() - started) * 1000, 1)


def format_row(index: int, thresholds: dict, report: dict, corpus_name: str, field: str, elapsed: float) -> str:
    summary = report["summary"]
    metrics = primary_metrics(report, corpus_name, field) or {}
    holdout = report["splits"].get(f"{corpus_name}::{field}::holdout") or {}
    return (
        f"{index:>3} | {thresholds['t_sem']:.2f} {thresholds['t_pair']:.2f} "
        f"{thresholds['t_merge']:.2f} {thresholds['t_single']:.2f} | "
        f"{str(summary['final_k']):>3} | {float(summary['noise_ratio'] or 0):.3f} | "
        f"{metrics.get(PRIMARY_METRIC) or 0:.4f} | {metrics.get(TERTIARY_METRIC) or 0:.4f} | "
        f"{metrics.get(SECONDARY_METRIC) or 0:.3f} | {holdout.get(PRIMARY_METRIC) or 0:.4f} | "
        f"{elapsed / 1000:>6.1f}s"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="扫描 semantic-v1 阈值")
    parser.add_argument("--spec", required=True, help="扫描 spec JSON")
    parser.add_argument("--output", required=True, help="结果 JSON 输出路径")
    parser.add_argument("--config", default=str(ENGINE_ROOT / "configs" / "app.toml"))
    parser.add_argument("--run-dir", default=None, help="运行产物目录（默认为 <仓库>/artifacts/calibration/runs）")
    parser.add_argument("--cache-dir", default=None, help="文本级向量缓存目录（跨候选复用）")
    parser.add_argument("--limit", type=int, default=0, help="只取语料前 N 条（调试用，0 表示全量）")
    parser.add_argument(
        "--profile-params",
        default=None,
        help=(
            "临时覆盖 profile 的算法参数（JSON）。存在的理由：阈值作用在**选完 K 之后**，"
            "而 K 由聚类空间决定；当语料数低于 pca_min_samples 时降维会被跳过、"
            "原始高维空间的各向异性会让 Auto-K 退化（实测 967 条 80 个真实主题塌成 k=2）。"
            "覆盖值会写进结果 JSON，避免出现不可复现的结论。"
        ),
    )
    args = parser.parse_args()

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    corpora = [load_corpus(resolve_corpus_path(path)) for path in spec["corpora"]]
    label_fields = spec.get("label_fields") or [corpora[0].get("label_field", "l2")]
    split_fields = spec.get("splits") or ["calibration", "holdout"]
    corpus_name = corpora[0]["name"]

    artifacts = ENGINE_ROOT / "artifacts" / "calibration"
    run_dir = Path(args.run_dir or artifacts / "runs")
    cache_dir = Path(args.cache_dir or artifacts / "text_embeddings")
    run_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    settings = Settings.load(args.config, overrides={"artifacts_dir": str(run_dir)})
    catalog = Catalog(settings)
    profile = catalog.profile(spec["profile_id"])
    param_overrides = json.loads(args.profile_params) if args.profile_params else {}
    if param_overrides:
        profile = replace(profile, algorithm_params={**profile.algorithm_params, **param_overrides})
    cache = TextEmbeddingCache(cache_dir)
    strategy = build_strategy(
        profile,
        settings=settings,
        catalog=catalog,
        encoders=EncoderRegistry(),
        text_cache=cache,
    )
    base_calibration = strategy.calibration

    items = []
    for corpus in corpora:
        for item in corpus["items"]:
            items.append({"id": item["id"], "text": item["text"]})
    if args.limit:
        items = items[: args.limit]

    baseline = {key: float(getattr(base_calibration, key)) for key in THRESHOLD_KEYS}
    corpus_names = ", ".join(f"{corpus['name']}({len(corpus['items'])})" for corpus in corpora)
    print(f"profile        {profile.profile_id}")
    print(f"模型           {profile.model_id}")
    print(f"语料           {corpus_names}")
    print(f"样本数         {len(items)}")
    print(f"算法参数       {profile.algorithm_params}")
    if param_overrides:
        print(f"参数覆盖       {param_overrides}")
    print(f"基线阈值       {baseline}")
    print(f"评估层级       {label_fields}   切分 {split_fields}")
    print()

    results: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "profile_id": profile.profile_id,
        "model_id": profile.model_id,
        "corpora": [{"name": c["name"], "items": len(c["items"])} for c in corpora],
        "label_fields": label_fields,
        "baseline": baseline,
        "profile_algorithm_params": profile.algorithm_params,
        "profile_param_overrides": param_overrides,
        "stages": [],
    }

    header = (
        f"{'#':>3} | {'t_sem t_pair t_merge t_single':<29} | {'k':>3} | {'noise':>5} | "
        f"{'bcubed':>7} | {'pair':>7} | {'rare':>5} | {'holdout':>7} | {'耗时':>7}"
    )

    current = dict(baseline)
    #: 所有阶段的候选都汇进同一个池子，最终用它统一排序——
    #: 否则"阶段内最优"与"全局最优"会各用一套隐含规则，读者无法复核。
    pool: list[dict] = []
    best_row: dict | None = None

    # 先跑一次基线，作为所有 "from": "baseline" 阶段的锚点，也让缓存预热
    print("— 基线 —")
    print(header)
    result, elapsed = run_candidate(strategy, base_calibration, items, current)
    report = evaluate(result, corpora, fields=label_fields, splits=split_fields)
    print(format_row(0, current, report, corpus_name, label_fields[0], elapsed))
    baseline_row = {"thresholds": dict(current), "report": report, "elapsed_ms": elapsed}
    results["baseline_run"] = baseline_row
    pool.append(baseline_row)
    print()

    for stage in spec["stages"]:
        origin = "best" if stage.get("from", "baseline") == "best" and best_row else "baseline"
        start = dict(best_row["thresholds"]) if origin == "best" else dict(baseline)
        candidates = candidates_for_stage(stage, start)
        print(f"— 阶段 {stage['name']}（起点 {origin}，{len(candidates)} 个候选）—")
        print(header)
        rows, skipped = [], 0
        for index, thresholds in enumerate(candidates, start=1):
            try:
                result, elapsed = run_candidate(strategy, base_calibration, items, thresholds)
            except ClusterError as exc:
                skipped += 1
                print(f"{index:>3} | 跳过：{thresholds} -> {exc.code} {exc.message}")
                continue
            report = evaluate(result, corpora, fields=label_fields, splits=split_fields)
            print(format_row(index, thresholds, report, corpus_name, label_fields[0], elapsed))
            rows.append({"thresholds": thresholds, "report": report, "elapsed_ms": elapsed})

        pool.extend(rows)
        best_row = rank(pool, corpus_name=corpus_name, field=label_fields[0], baseline=baseline)
        stage_record = {
            "name": stage["name"],
            "from": origin,
            "values": stage["values"],
            "skipped": skipped,
            "candidates": rows,
            "stage_best": (
                rank(rows, corpus_name=corpus_name, field=label_fields[0], baseline=baseline) or {}
            ).get("thresholds"),
            "pool_best": best_row["thresholds"] if best_row else None,
        }
        if best_row is not None:
            winner_metrics = ranking_metrics(best_row["report"], corpus_name, label_fields[0])
            stage_record["pool_best_metrics"] = winner_metrics
            print(
                f"→ 池内最优 {best_row['thresholds']}  均值{PRIMARY_METRIC}={winner_metrics['primary']:.4f} "
                f"(calibration={winner_metrics['calibration'].get(PRIMARY_METRIC):.4f}, "
                f"holdout={winner_metrics['holdout'].get(PRIMARY_METRIC)}) "
                f"{SECONDARY_METRIC}={winner_metrics['calibration'].get(SECONDARY_METRIC)}"
            )
        results["stages"].append(stage_record)
        print()

    if best_row is None:
        best_row, best_report = baseline_row, baseline_row["report"]
    else:
        best_report = best_row["report"]

    winner_metrics = ranking_metrics(best_row["report"], corpus_name, label_fields[0])
    baseline_metrics = ranking_metrics(baseline_row["report"], corpus_name, label_fields[0])
    results["recommendation"] = {
        "thresholds": best_row["thresholds"],
        "baseline_thresholds": baseline,
        "objective": {
            "corpus": corpus_name,
            "field": label_fields[0],
            "split": "calibration",
            **{key: winner_metrics["calibration"].get(key) for key in (PRIMARY_METRIC, SECONDARY_METRIC, TERTIARY_METRIC)},
        },
        "objective_mean": winner_metrics["primary"],
        "objective_holdout": {
            key: winner_metrics["holdout"].get(key)
            for key in (PRIMARY_METRIC, SECONDARY_METRIC, TERTIARY_METRIC)
        },
        "baseline_objective": {
            key: (baseline_metrics["calibration"] or {}).get(key)
            for key in (PRIMARY_METRIC, SECONDARY_METRIC, TERTIARY_METRIC)
        },
        "baseline_objective_mean": baseline_metrics["primary"] if baseline_metrics else None,
        "selection_rule": (
            f"主指标 = calibration 与 holdout 两个切分的 {PRIMARY_METRIC} 均值最大"
            f"（避免只在半个语料上挑到偶然值）；距最优 {TIE_WINDOW} 以内取 "
            f"{SECONDARY_METRIC} 最高，再比 {TERTIARY_METRIC}；"
            f"仍相同则取距基线 L1 距离最小者（避免在平坦响应面上挑到网格边界的外推值）"
        ),
        "holdout": {
            field: {
                key: (best_row["report"]["splits"].get(f"{corpus_name}::{field}::holdout") or {}).get(key)
                for key in (PRIMARY_METRIC, SECONDARY_METRIC, TERTIARY_METRIC)
            }
            for field in label_fields
        },
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=" * 96)
    print(f"推荐阈值 {best_row['thresholds']}")
    print(f"基线     {baseline}")
    print(f"结果已写入 {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
