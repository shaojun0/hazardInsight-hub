"""后处理：异常/边界识别、小簇保护与保守合并、有界局部拆分、规范编号。

KMeans 家族的先天缺陷是"强制归类"：它会给每条文本一个簇，哪怕这条文本
和谁都无关。本模块就是补这个洞（对应实施计划 5.3 / 6 节）：

* **拒绝权**：达不到绝对语义门槛的点标为噪声，而不是"最接近就吸收"；
* **小簇保护**：默认"小簇"是**不同文本数 < 5**（不是比例阈值），
  10 万条里 3 条的小主题不会被"按比例"删掉；
* **有界拆分**：最多 8 个父簇、每个只二分一次，绝不无界递归；
* **反链式合并**：每次接受合并后重算中心与分位数，避免 A≈B、B≈C 导致 A 与 C 连通；
* **规范编号**：按成员规范化文本键集合的稳定指纹排序编号，
  不按大小排序——否则重复频次一变，所有簇 ID 都会漂移。

所有阈值都来自 ``configs/semantic-calibration-v1.json``，
不在代码里硬编码"0.7 就相似"。
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math

import numpy as np

from ..features.semantic import cosine_to_centers, normalize_centers
from .semantic_auto import assign, fit_mbk, recompute_centers

#: 默认"小簇"上限（不同文本数）。刻意不随 N 增长。
DEFAULT_SMALL_CLUSTER_UNIQUE = 5

#: 构建临时核心所需的最少不同文本数；不足则走小簇规则。
DEFAULT_MIN_CORE = 3

#: 单次拆分的最大父簇数。
DEFAULT_SPLIT_BUDGET = 8

#: 拆分候选时每个父簇最多取多少条成员做二分。
SPLIT_SAMPLE_ROWS = 4096

#: 凝聚评分使用 MAD 所需的最少参考成员数；更少时只用绝对门槛。
MAD_MIN_REFERENCE = 10

#: MAD 到标准差的换算常数。
MAD_SCALE = 1.4826

#: 各种成员状态。
STATUS_CORE = "core"
STATUS_BORDERLINE = "borderline"
STATUS_SMALL_COHERENT = "small_coherent"
STATUS_DUPLICATE_ONLY = "duplicate_only"
STATUS_NOISE = "noise"
STATUS_INVALID = "invalid"

#: 否定与状态反转词。用于合并的**保守 veto**：一半明确否定、一半明确肯定时不要合并。
#: 规则刻意只做"否决"，不声称能覆盖所有反义表达。
NEGATION_TOKENS = ("未", "不", "无", "没", "禁止", "严禁", "不可", "缺乏", "失效", "损坏")

#: 一个簇"基本是否定表达"或"基本没有否定"的判定阈值。
NEGATION_EXTREME = 0.8

#: 计算否定占比时每簇最多抽样多少条文本。
NEGATION_SAMPLE = 20


def negation_polarity(texts) -> float | None:
    """估计一组文本的否定占比（None 表示样本为空）。"""

    sample = [str(item) for item in list(texts)[:NEGATION_SAMPLE]]
    if not sample:
        return None
    hits = sum(1 for text in sample if any(token in text for token in NEGATION_TOKENS))
    return hits / len(sample)


@dataclass
class MemberState:
    """一条唯一文本的最终归属状态。"""

    index: int
    status: str
    cluster: int
    s1: float | None = None
    s2: float | None = None
    margin: float | None = None
    confidence: float | None = None
    noise_reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "status": self.status,
            "cluster": int(self.cluster),
            "s1": None if self.s1 is None else round(float(self.s1), 6),
            "s2": None if self.s2 is None else round(float(self.s2), 6),
            "margin": None if self.margin is None else round(float(self.margin), 6),
            "confidence": None if self.confidence is None else round(float(self.confidence), 6),
            "noise_reason": self.noise_reason,
        }


def refine_in_semantic_space(space, labels, *, rounds: int = 2, block: int = 2048) -> dict:
    """在 ``X_sem`` 上做有界余弦分配/中心更新，并重算中心与空簇。"""

    from .semantic_auto import refine_with_cosine

    labels = np.asarray(labels, dtype=np.int32)
    live = sorted({int(label) for label in labels if int(label) >= 0})
    if not live or len(live) == 1:
        k = (max(live) + 1) if live else 0
        centers, empty = recompute_centers(space.sem, labels, k) if k else (np.zeros((0, space.sem_dim), np.float32), [])
        return {"labels": labels, "centers": centers, "n_clusters": len(live), "empty_clusters": empty, "history": []}

    centers, _empty = recompute_centers(space.sem, labels, max(live) + 1)
    compact = np.zeros((len(live), space.sem_dim), dtype=np.float32)
    remap = np.full(max(live) + 1, -1, dtype=np.int32)
    for new_index, old_index in enumerate(live):
        compact[new_index] = centers[old_index]
        remap[old_index] = new_index
    compact_labels = np.where(labels >= 0, remap[np.clip(labels, 0, None)], -1).astype(np.int32)

    outcome = refine_with_cosine(space.sem, compact, compact_labels, rounds=rounds, block=block)
    final_labels = outcome["labels"].astype(np.int32)
    final_live = sorted({int(label) for label in final_labels if int(label) >= 0})
    final_centers, empty = recompute_centers(space.sem, final_labels, outcome["centers"].shape[0])
    kept = np.zeros((len(final_live), space.sem_dim), dtype=np.float32)
    remap_final = np.full(outcome["centers"].shape[0], -1, dtype=np.int32)
    for new_index, old_index in enumerate(final_live):
        kept[new_index] = final_centers[old_index]
        remap_final[old_index] = new_index
    labels_out = np.where(
        final_labels >= 0, remap_final[np.clip(final_labels, 0, None)], -1
    ).astype(np.int32)
    return {
        "labels": labels_out,
        "centers": kept,
        "n_clusters": len(final_live),
        "empty_clusters": [int(item) for item in empty if int(item) in set(final_live)],
        "history": outcome["history"],
    }


def membership_similarity(
    matrix: np.ndarray, centers: np.ndarray, *, block: int = 2048
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 ``(s1, s2, other_label)``。

    ``s1`` 是到最近中心的余弦相似度，``s2`` 是到次近中心的，``other_label``
    是次近中心的簇号（用于"重新分配"时找到真正的候选目标簇）。
    只做 ``U × K`` 的块计算，不构造 ``U × U``。
    """

    total = matrix.shape[0]
    if centers.shape[0] < 1:
        empty = np.zeros(total, dtype=np.float32)
        return empty, empty.copy(), np.full(total, -1, dtype=np.int32)
    similarity = cosine_to_centers(matrix, centers, block=block)
    if centers.shape[0] == 1:
        return similarity[:, 0].astype(np.float32), np.full(total, -1.0, dtype=np.float32), np.full(total, -1, dtype=np.int32)
    # argpartition 只取最大的两个，避免全量排序
    top2 = np.argpartition(-similarity, 1, axis=1)[:, :2]
    rows = np.arange(total)[:, None]
    values = similarity[rows, top2]
    first = np.where(values[:, 0] >= values[:, 1], 0, 1)
    best_index = top2[np.arange(total), first]
    other_index = top2[np.arange(total), 1 - first]
    return (
        similarity[np.arange(total), best_index].astype(np.float32),
        similarity[np.arange(total), other_index].astype(np.float32),
        other_index.astype(np.int32),
    )


def cluster_cohesion(matrix: np.ndarray, labels: np.ndarray, centers: np.ndarray) -> dict[int, float]:
    """每个簇的宏平均凝聚（成员到自身中心的余弦均值）。"""

    s1, _s2, _other = membership_similarity(matrix, centers)
    result: dict[int, float] = {}
    for label in sorted({int(value) for value in labels if int(value) >= 0}):
        selected = labels == label
        result[label] = float(s1[selected].mean()) if selected.any() else 0.0
    return result


def classify_members(
    space,
    labels,
    centers,
    *,
    t_sem: float,
    t_margin: float,
    min_core: int = DEFAULT_MIN_CORE,
    bad_rows=(),
    r_max_tolerance: float = 0.02,
) -> tuple[list[MemberState], dict]:
    """判定每条唯一文本是核心、边界、噪声还是坏向量，并允许一次重分配。

    关键点（实施计划 6.1）：

    * 大簇用 ``median(r) + 3×1.4826×MAD(r)`` 定半径，但**绝对门槛仍然生效**——
      否则一批全无关文本的 MAD 也会很小，"按分位数删 5%" 一定会把剩下的
      无关文本当作正常成员保留下来；
    * 参考成员少于 10 个时不使用不稳定的 MAD，直接用绝对门槛；
    * margin 小只降 confidence（borderline），不因为"离边界近"就删掉同主题文本。
    """

    matrix = space.sem
    total = int(matrix.shape[0])
    states = [MemberState(index=index, status=STATUS_NOISE, cluster=-1) for index in range(total)]
    diagnostics: dict = {"cores": {}, "radius": {}, "reassigned": 0, "bad_rows": list(bad_rows)}

    live = sorted({int(label) for label in labels if int(label) >= 0})
    bad_set = set(int(item) for item in bad_rows)
    if not live:
        for state in states:
            state.noise_reason = "no_coherent_topics" if state.index not in bad_set else "invalid_embedding"
        return states, diagnostics

    s1, s2, other_label = membership_similarity(matrix, centers)
    other_label = np.asarray(other_label)
    # 每簇的核心成员集合：只有达到绝对语义支持且非坏向量的点才有资格构成核心
    core_members: dict[int, list[int]] = {}
    for label in live:
        support = [
            index
            for index in range(total)
            if int(labels[index]) == label and float(s1[index]) >= t_sem and index not in bad_set
        ]
        core_members[label] = support
        diagnostics["cores"][label] = len(support)

    # 半径：优先用 MAD，但与绝对门槛取更严的一个
    absolute = 1.0 - t_sem
    for label in live:
        members = [index for index in range(total) if int(labels[index]) == label]
        reference = [index for index in members if float(s1[index]) >= t_sem]
        if len(reference) >= MAD_MIN_REFERENCE:
            residual = 1.0 - s1[np.asarray(reference)]
            median = float(np.median(residual))
            mad = float(np.median(np.abs(residual - median)))
            radius = median + 3.0 * MAD_SCALE * mad if mad > 0 else median + r_max_tolerance
        else:
            # 参考成员太少，MAD 不稳定（甚至为 0），退化为绝对门槛
            radius = absolute
        diagnostics["radius"][label] = round(float(min(max(radius, 0.0), absolute)), 6)

    target_counts = {label: len(core_members.get(label, [])) for label in live}
    for index in range(total):
        state = states[index]
        if index in bad_set:
            state.noise_reason = "invalid_embedding"
            continue
        label = int(labels[index])
        if label < 0:
            state.noise_reason = "unclustered"
            continue
        own = float(s1[index])
        best_other = float(s2[index])
        margin = own - best_other
        radius = diagnostics["radius"].get(label, absolute)
        if own < t_sem or (1.0 - own) > radius + 1e-9:
            # 一次重分配：另一簇必须同时满足"绝对门槛 + 间隔 + 足够核心支持"，
            # 不因为"它最近"就把噪声吸收进某个大簇
            candidate = int(other_label[index])
            if (
                candidate >= 0
                and best_other >= t_sem
                and margin <= -t_margin
                and target_counts.get(candidate, 0) >= min_core
            ):
                state.status = STATUS_CORE
                state.cluster = candidate
                state.s1, state.s2, state.margin = best_other, own, -margin
                diagnostics["reassigned"] += 1
                continue
            state.cluster = label
            state.s1, state.s2, state.margin = own, best_other, margin
            state.noise_reason = "below_semantic_support" if own < t_sem else "outside_cluster_radius"
            continue

        if len(core_members.get(label, [])) < min_core:
            # 核心不足：交给小簇规则统一裁决，不在这里直接丢弃
            state.status = STATUS_NOISE
            state.cluster = label
            state.s1, state.s2, state.margin = own, best_other, margin
            state.noise_reason = "insufficient_core_support"
            continue

        state.status = STATUS_BORDERLINE if margin < t_margin else STATUS_CORE
        state.cluster = label
        state.s1, state.s2, state.margin = own, best_other, margin
    return states, diagnostics


def cluster_key_fingerprint(keys) -> str:
    """簇的稳定指纹：成员规范化文本键排序后取 SHA-256。"""

    return hashlib.sha256("|".join(sorted(str(item) for item in keys)).encode("utf-8")).hexdigest()


def canonical_numbering(labels, member_keys) -> tuple[np.ndarray, dict]:
    """按成员集合的稳定指纹重新编号为 ``0..K-1``。

    噪声固定 ``-1``。这样"相同文本集合、不同输入顺序"一定得到相同的
    ID→簇与 ID→名称映射；而按 size 排序做不到这一点——重复频次一变，
    所有簇 ID 都会跟着漂移。
    """

    labels = np.asarray(labels, dtype=np.int32)
    live = sorted({int(label) for label in labels if int(label) >= 0})
    signatures = []
    for label in live:
        keys = [member_keys[index] for index in range(len(labels)) if int(labels[index]) == label]
        signatures.append((cluster_key_fingerprint(keys), label))
    signatures.sort()
    mapping = {old: new for new, (_signature, old) in enumerate(signatures)}
    renumbered = np.full(labels.shape[0], -1, dtype=np.int32)
    for index, label in enumerate(labels):
        if int(label) >= 0:
            renumbered[index] = mapping[int(label)]
    return renumbered, {int(old): int(new) for old, new in mapping.items()}


def protect_small_clusters(
    space,
    labels,
    centers,
    *,
    keys,
    frequencies,
    t_pair: float,
    t_merge: float,
    t_sem: float,
    min_cluster_unique: int = DEFAULT_SMALL_CLUSTER_UNIQUE,
) -> tuple[np.ndarray, list[dict]]:
    """小簇保护：能自洽就留下，能量化对齐就合并，都不行才降为噪声。

    * 不同文本数 ≥ ``min_cluster_unique`` 的簇原样保留；
    * 小组（2～4 条不同文本）若成员互相支持（pair/留一相似度达标）
      且与其他簇有分离 → ``small_coherent``，保留；
    * 单条唯一文本但重复出现多次 → ``duplicate_only``，保留并展示真实次数；
      语义质量为 null，不因"重复一千次"而得高分；
    * 其余无法自洽的孤点降为噪声。
    """

    labels = np.asarray(labels, dtype=np.int32).copy()
    log: list[dict] = []
    live = sorted({int(label) for label in labels if int(label) >= 0})
    if centers.shape[0] < len(live) or centers.shape[0] == 0:
        # 没有可用中心（例如全部候选都被判噪声）：小组无法量化对齐目标，一律降噪
        for label in live:
            members = np.nonzero(labels == label)[0]
            if len(members) == 1 and frequencies[int(members[0])] > 1:
                log.append({"cluster": label, "action": "duplicate_only", "unique_size": 1, "frequency": int(frequencies[int(members[0])])})
                continue
            labels[members] = -1
            log.append({"cluster": label, "action": "drop_small_as_noise", "unique_size": int(members.size), "reason": "no_center"})
        return labels, log

    normalized = normalize_centers(centers)
    for label in live:
        members = [index for index in range(labels.shape[0]) if int(labels[index]) == label]
        if len(members) >= min_cluster_unique:
            continue
        vector = space.sem[np.asarray(members)]
        # 成员互相支持：组内两两余弦的**中位数**。
        #
        # 这里刻意不用 25 分位：3~4 条文本只有 3~6 对，25 分位几乎等于"最差的那一对"，
        # 只要组内有一对措辞差异较大，整个自洽的小簇就会被否掉——小语料上尤其明显
        # （4 个主题各 3~4 条时，所有簇都会走这条分支，于是整批退化成全噪声）。
        # 中位数口径与 ``auto_k.evaluate_single_cluster`` 的 ``pair_median`` 完全一致，
        # 后者回答的是同一个问题（"这一组算不算一个主题"），因此两处不会出现两套标准。
        # q25 仍然算出来并写进日志，便于发现"中位数达标但存在明显离群对"的情况。
        q25 = None
        if len(members) > 1:
            similarity = vector @ vector.T
            upper = similarity[np.triu_indices(len(members), k=1)]
            support = float(np.median(upper)) if upper.size else 0.0
            q25 = float(np.quantile(upper, 0.25)) if upper.size else 0.0
        else:
            support = 1.0 if frequencies[members[0]] > 1 else 0.0
        # support 始终是文本对文本的相似度，必须使用 t_pair。
        # t_sem 是成员到中心的门槛，已在 classify_members 检查，不能混用。
        support_bar = t_pair
        if len(members) == 1 and frequencies[members[0]] > 1:
            log.append({"cluster": label, "action": "duplicate_only", "unique_size": 1, "frequency": int(frequencies[members[0]])})
            continue
        if support >= support_bar:
            log.append(
                {
                    "cluster": label,
                    "action": "keep_small_coherent",
                    "unique_size": len(members),
                    "support": round(support, 6),
                    "support_bar": support_bar,
                    "q25": None if q25 is None else round(q25, 6),
                }
            )
            continue
        # 尝试合并：只考虑中心相似度达到 t_merge 且本身不是小簇的目标簇
        target = None
        best = t_merge
        for other in live:
            if other == label:
                continue
            other_size = int((labels == other).sum())
            if other_size < min_cluster_unique:
                continue
            value = float(normalized[label] @ normalized[other])
            if value > best:
                best, target = value, other
        if target is not None:
            labels[np.asarray(members)] = target
            log.append({"cluster": label, "action": "merge_small", "target": int(target), "similarity": round(best, 6)})
            continue
        labels[np.asarray(members)] = -1
        log.append(
            {
                "cluster": label,
                "action": "drop_small_as_noise",
                "unique_size": len(members),
                "support": round(support, 6),
                "q25": None if q25 is None else round(q25, 6),
            }
        )
    return labels, log


def split_low_cohesion(
    space,
    labels,
    centers,
    *,
    keys,
    budget: int = DEFAULT_SPLIT_BUDGET,
    min_cluster_unique: int = 2,
    min_improvement: float = 0.05,
    seed: int = 42,
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """有界局部拆分：最多 ``budget`` 个低凝聚父簇，每个只二分一次。

    接受条件三选三：两个子簇各有足够的不同文本、通过绝对凝聚与分离门槛、
    且凝聚改善超过固定阈值。不做无界递归，也不对每个父簇跑完整 Auto-K。
    """

    labels = np.asarray(labels, dtype=np.int32).copy()
    centers = np.asarray(centers, dtype=np.float32)
    log: list[dict] = []
    live = sorted({int(label) for label in labels if int(label) >= 0})
    if len(live) < 1 or budget <= 0:
        return labels, centers, log

    cohesion = cluster_cohesion(space.sem, labels, centers)
    # 低凝聚优先；同一凝聚度按簇键稳定排序，保证拆分顺序可复现
    parents = sorted(live, key=lambda label: (cohesion.get(label, 0.0), _stable_cluster_order(keys, labels, label)))
    parents = [label for label in parents if len([1 for index in range(labels.shape[0]) if int(labels[index]) == label]) >= 2 * min_cluster_unique]
    parents = parents[:budget]
    # 残余噪声桶也算一个候选父簇（预算内）
    noise_members = [index for index in range(labels.shape[0]) if int(labels[index]) == -1]

    candidates = [(f"c{label}", np.asarray([index for index in range(labels.shape[0]) if int(labels[index]) == label])) for label in parents]
    if len(noise_members) >= 2 * min_cluster_unique:
        candidates.append(("noise", np.asarray(noise_members)))

    next_label = len(live)
    for name, members in candidates:
        if members.shape[0] < 2 * min_cluster_unique:
            continue
        selected = members[:SPLIT_SAMPLE_ROWS]
        vector = space.sem[selected]
        fitted = fit_mbk(vector, 2, seed=seed, batch_size=min(1024, vector.shape[0]), max_iter=30, n_init=3)
        sub_centers, empty = recompute_centers(vector, fitted["labels"], 2)
        if empty:
            continue
        sub_labels, sub_scores = assign(vector, sub_centers)
        sizes = [int((sub_labels == index).sum()) for index in range(2)]
        if min(sizes) < min_cluster_unique:
            log.append({"parent": name, "action": "reject", "reason": "child_too_small", "sizes": sizes})
            continue
        # 父簇凝聚：现算而非用循环开始时的快照，避免前一次拆分改变后续判断
        parent_center, _empty_parent = recompute_centers(space.sem[members], np.zeros(members.shape[0], dtype=np.int32), 1)
        parent_cohesion = float((space.sem[members] @ parent_center[0]).mean())
        child_cohesion = float(np.mean([sub_scores[sub_labels == index].mean() for index in range(2)]))
        if child_cohesion <= parent_cohesion + min_improvement:
            log.append(
                {
                    "parent": name,
                    "action": "reject",
                    "reason": "improvement_below_threshold",
                    "parent_cohesion": round(parent_cohesion, 6),
                    "child_cohesion": round(child_cohesion, 6),
                }
            )
            continue
        # 接受：把父簇全体成员按两个子中心重新分配，拆成两个新簇
        all_labels, _all_scores = assign(space.sem[members], sub_centers)
        labels[members] = np.where(all_labels == 0, next_label, next_label + 1)
        log.append(
            {
                "parent": name,
                "action": "accept",
                "new_clusters": [int(next_label), int(next_label + 1)],
                "sizes": [int((all_labels == 0).sum()), int((all_labels == 1).sum())],
                "improvement": round(child_cohesion - parent_cohesion, 6),
            }
        )
        next_label += 2

    if next_label > len(live):
        rebuilt, _empty = recompute_centers(space.sem, labels, next_label)
        centers = rebuilt
    return labels, centers, log


def _stable_cluster_order(keys, labels, label) -> str:
    members = [str(keys[index]) for index in range(len(labels)) if int(labels[index]) == label]
    return cluster_key_fingerprint(members)


def merge_coherent_clusters(
    space,
    labels,
    centers,
    *,
    keys,
    t_merge: float,
    rounds: int = 2,
    min_cluster_unique: int = DEFAULT_SMALL_CLUSTER_UNIQUE,
    texts=None,
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """保守合并：只合并中心相似度达标且不损害凝聚的簇对。

    反链式处理：每次接受合并后**立刻重算中心与相似度**，
    因此 A≈B、B≈C 不会导致 A 与 C 被错误地链式连通。

    否定 veto：当 ``texts`` 可用时，若一侧几乎全是否定表达、另一侧几乎没有，
    即使中心相似度达标也拒绝合并——"配电箱门未上锁"与"配电箱门已上锁"
    在向量空间里可能很近，但语义相反，合起来会直接误导使用者。
    """

    labels = np.asarray(labels, dtype=np.int32).copy()
    centers = np.asarray(centers, dtype=np.float32).copy()
    log: list[dict] = []
    for round_index in range(max(0, int(rounds))):
        live = sorted({int(label) for label in labels if int(label) >= 0})
        if len(live) < 2:
            break
        normalized = normalize_centers(centers)
        cohesion = cluster_cohesion(space.sem, labels, centers)
        pairs = []
        for left_pos, left in enumerate(live):
            for right in live[left_pos + 1 :]:
                similarity = float(normalized[left] @ normalized[right])
                if similarity >= t_merge:
                    pairs.append((similarity, _stable_cluster_order(keys, labels, left), left, right))
        if not pairs:
            break
        # 相似度降序、稳定簇键升序：结局与遍历顺序无关
        pairs.sort(key=lambda item: (-item[0], item[1], item[2], item[3]))
        accepted = 0
        for similarity, _order, left, right in pairs:
            left_members = np.nonzero(labels == left)[0]
            right_members = np.nonzero(labels == right)[0]
            if left_members.size == 0 or right_members.size == 0:
                # 该簇已在更早的某次合并中被并入别处，跳过即可（这正是反链式处理）
                continue
            if texts is not None:
                left_polarity = negation_polarity([texts[index] for index in left_members])
                right_polarity = negation_polarity([texts[index] for index in right_members])
                if (
                    left_polarity is not None
                    and right_polarity is not None
                    and abs(left_polarity - right_polarity) >= NEGATION_EXTREME
                ):
                    log.append(
                        {
                            "round": round_index + 1,
                            "action": "reject",
                            "pair": [int(left), int(right)],
                            "reason": "negation_conflict",
                            "polarity": [round(left_polarity, 4), round(right_polarity, 4)],
                        }
                    )
                    continue
            merged_members = np.concatenate([left_members, right_members])
            merged_center, _empty = recompute_centers(space.sem[merged_members], np.zeros(merged_members.size, dtype=np.int32), 1)
            merged_cohesion = float((space.sem[merged_members] @ merged_center[0]).mean())
            before = float(
                np.average(
                    [cohesion.get(left, 0.0), cohesion.get(right, 0.0)],
                    weights=[left_members.size, right_members.size],
                )
            )
            if merged_cohesion < before - 0.05:
                log.append(
                    {
                        "round": round_index + 1,
                        "action": "reject",
                        "pair": [int(left), int(right)],
                        "reason": "cohesion_drop",
                        "before": round(before, 6),
                        "after": round(merged_cohesion, 6),
                    }
                )
                continue
            labels[right_members] = left
            centers[left] = merged_center[0]
            cohesion = cluster_cohesion(space.sem, labels, centers)
            accepted += 1
            log.append(
                {
                    "round": round_index + 1,
                    "action": "accept",
                    "pair": [int(left), int(right)],
                    "similarity": round(similarity, 6),
                    "size": int(merged_members.size),
                }
            )
        if accepted == 0:
            break
    return labels, centers, log


def compact(labels, centers) -> tuple[np.ndarray, np.ndarray, dict]:
    """压实簇编号（去掉被合并/清空的空号），返回 ``(labels, centers, mapping)``。"""

    labels = np.asarray(labels, dtype=np.int32).copy()
    centers = np.asarray(centers, dtype=np.float32)
    live = sorted({int(label) for label in labels if int(label) >= 0})
    dimension = centers.shape[1] if centers.ndim == 2 and centers.size else 0
    if not live or dimension == 0:
        return np.full(labels.shape[0], -1, dtype=np.int32), np.zeros((0, dimension), dtype=np.float32), {}
    rebuilt = np.empty((len(live), dimension), dtype=np.float32)
    lookup = np.full(centers.shape[0], -1, dtype=np.int32)
    mapping: dict[int, int] = {}
    for new_index, old_index in enumerate(live):
        rebuilt[new_index] = centers[old_index]
        lookup[old_index] = new_index
        mapping[int(old_index)] = int(new_index)
    safe = np.clip(labels, 0, lookup.shape[0] - 1)
    compacted = np.where(labels >= 0, lookup[safe], -1).astype(np.int32)
    return compacted, rebuilt, mapping


def apply_statuses(labels, states, *, borderline_is_noise: bool = False) -> tuple[np.ndarray, dict]:
    """把成员状态落实成最终标签，并统计各类状态的数量。"""

    labels = np.asarray(labels, dtype=np.int32).copy()
    counts = {
        STATUS_CORE: 0,
        STATUS_BORDERLINE: 0,
        STATUS_SMALL_COHERENT: 0,
        STATUS_DUPLICATE_ONLY: 0,
        STATUS_NOISE: 0,
        STATUS_INVALID: 0,
    }
    for state in states:
        counts[state.status] = counts.get(state.status, 0) + 1
        if state.status == STATUS_NOISE or state.status == STATUS_INVALID or (borderline_is_noise and state.status == STATUS_BORDERLINE):
            labels[state.index] = -1
        elif state.cluster >= 0:
            labels[state.index] = state.cluster
    return labels, counts


def run_postprocess(
    space,
    labels,
    *,
    keys,
    frequencies,
    calibration: dict,
    min_cluster_unique: int = DEFAULT_SMALL_CLUSTER_UNIQUE,
    min_core: int = DEFAULT_MIN_CORE,
    split_budget: int = DEFAULT_SPLIT_BUDGET,
    merge_rounds: int = 2,
    refine_rounds: int = 2,
    split_min_improvement: float = 0.05,
    seed: int = 42,
    bad_rows=(),
    texts=None,
) -> dict:
    """串联完整后处理链，返回最终标签、中心、成员状态与全部日志。

    顺序固定为：语义空间修正 → 有界拆分 → 成员判定（含重分配）
    → 小簇保护 → 保守合并 → 压实与规范编号。
    顺序不能随意调换：先拆分再判定，才能让拆分出来的新簇参与成员判定；
    先合并再编号，才能保证编号覆盖最终簇集合。
    """

    t_sem = float(calibration["t_sem"])
    t_pair = float(calibration["t_pair"])
    t_merge = float(calibration["t_merge"])
    t_margin = float(calibration["t_margin"])

    refined = refine_in_semantic_space(space, labels, rounds=refine_rounds)
    current_labels = refined["labels"]
    current_centers = refined["centers"]

    current_labels, current_centers, split_log = split_low_cohesion(
        space,
        current_labels,
        current_centers,
        keys=keys,
        budget=split_budget,
        min_cluster_unique=max(2, min_cluster_unique // 2),
        min_improvement=split_min_improvement,
        seed=seed,
    )

    states, membership = classify_members(
        space,
        current_labels,
        current_centers,
        t_sem=t_sem,
        t_margin=t_margin,
        min_core=min_core,
        bad_rows=bad_rows,
    )

    # 成员判定后的标签（噪声先落地），再对小簇做保护/合并。
    #
    # 只落地"自身不达标"的点：``noise_reason == "insufficient_core_support"``
    # 的点是自己已经过了绝对语义门槛、只是所在簇的核心成员不够——那正是小簇规则
    # 要裁决的情形（整簇保留 / 被合并 / 整簇降噪）。如果在这里就把它改成 -1，
    # ``protect_small_clusters`` 就再也看不到它们，"小簇保护"会彻底失效。
    staged = np.asarray(current_labels, dtype=np.int32).copy()
    for state in states:
        if state.status == STATUS_NOISE and state.noise_reason != "insufficient_core_support":
            staged[state.index] = -1
    if current_centers.shape[0]:
        rebuilt, _empty = recompute_centers(space.sem, staged, current_centers.shape[0])
        live = sorted({int(label) for label in staged if int(label) >= 0})
        staged, current_centers, _mapping = compact(staged, rebuilt)

    staged, small_log = protect_small_clusters(
        space,
        staged,
        current_centers if current_centers.shape[0] else np.zeros((0, space.sem_dim), dtype=np.float32),
        keys=keys,
        frequencies=frequencies,
        t_pair=t_pair,
        t_merge=t_merge,
        t_sem=t_sem,
        min_cluster_unique=min_cluster_unique,
    )
    if current_centers.shape[0]:
        rebuilt, _empty = recompute_centers(space.sem, staged, current_centers.shape[0])
        staged, current_centers, _mapping = compact(staged, rebuilt)

    if current_centers.shape[0] >= 2:
        staged, current_centers, merge_log = merge_coherent_clusters(
            space,
            staged,
            current_centers,
            keys=keys,
            t_merge=t_merge,
            rounds=merge_rounds,
            min_cluster_unique=min_cluster_unique,
        )
        rebuilt, _empty = recompute_centers(space.sem, staged, current_centers.shape[0])
        staged, current_centers, _mapping = compact(staged, rebuilt)
    else:
        merge_log = []

    final_labels, numbering = canonical_numbering(staged, keys)
    final_live = sorted({int(label) for label in final_labels if int(label) >= 0})
    if final_live:
        # 规范编号可能置换簇号，不能按新下标读取旧中心。
        final_centers, _ = recompute_centers(space.sem, final_labels, len(final_live))
    else:
        final_centers = np.zeros((0, space.sem_dim), dtype=np.float32)

    # 成员状态必须在**最终标签落定之后**重新对齐一次，而不是按 numbering 重映射簇号：
    #
    # * 小簇保护与合并都会改变"谁属于哪个簇"。核心不足的成员在 classify_members
    #   阶段被标为 NOISE（那是刻意留给小簇规则裁决的），若此时仍带着该状态，
    #   ``apply_statuses`` 会再把它打回 -1——**小簇保护就完全等于没生效**；
    # * 被合并到别的簇的成员，其旧簇号在新编号里已不存在，按 numbering 查会得到 -1，
    #   同样造成"标签说属于 A 簇、状态说自己是噪声"的自相矛盾。
    #
    # 因此这里以 final_labels 为唯一事实：最终有簇 → 成员至少是 small_coherent
    # （低支持但被保留）；最终无簇 → 记为噪声并保留原始原因。
    for state in states:
        label = int(final_labels[state.index])
        if label < 0:
            state.cluster = -1
            if state.status in {STATUS_CORE, STATUS_BORDERLINE}:
                state.status = STATUS_NOISE
                state.noise_reason = state.noise_reason or "cluster_dissolved"
            continue
        state.cluster = label
        if state.status == STATUS_NOISE:
            # 只有一条不同文本、却重复出现多次的簇：如实标 duplicate_only，
            # 它的语义质量为 null，不会因为"重复一千次"而拿到高分。
            if int((final_labels == label).sum()) == 1 and int(frequencies[state.index]) > 1:
                state.status = STATUS_DUPLICATE_ONLY
            else:
                state.status = STATUS_SMALL_COHERENT
            state.noise_reason = None

    labels_out, counts = apply_statuses(final_labels, states)
    return {
        "labels": labels_out,
        "centers": final_centers,
        "states": states,
        "counts": counts,
        "membership": membership,
        "refine_log": refined["history"],
        "split_log": split_log,
        "merge_log": merge_log,
        "small_cluster_log": small_log,
        "numbering": {int(key): int(value) for key, value in numbering.items()},
        "empty_clusters": refined["empty_clusters"],
        "n_clusters": len(final_live),
    }


__all__ = [
    "DEFAULT_MIN_CORE",
    "DEFAULT_SMALL_CLUSTER_UNIQUE",
    "DEFAULT_SPLIT_BUDGET",
    "STATUS_BORDERLINE",
    "STATUS_CORE",
    "STATUS_DUPLICATE_ONLY",
    "STATUS_INVALID",
    "STATUS_NOISE",
    "STATUS_SMALL_COHERENT",
    "MemberState",
    "apply_statuses",
    "canonical_numbering",
    "classify_members",
    "cluster_cohesion",
    "cluster_key_fingerprint",
    "compact",
    "membership_similarity",
    "merge_coherent_clusters",
    "negation_polarity",
    "protect_small_clusters",
    "refine_in_semantic_space",
    "run_postprocess",
    "split_low_cohesion",
]
