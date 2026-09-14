"""有界 Auto-K：候选生成、验证评分与确定性选择。

这一层回答的唯一问题是"该分几个簇"，且**不要求调用方输入 K**。
它刻意不做的事（见实施计划 5.1 / 5.2）：

* 不比较 inertia——inertia 恒随 K 增大而下降，用它选 K 必然偏好大量小簇；
* 不冒充标准 silhouette——改写为"中心分离代理分数"，并在原空间中心上评估；
* 不做无界的 K 搜索——候选总数 ≤12、拟合样本 ≤8192、只对得分前两名做挑战重拟合；
* 不因为未通过门槛就强行归类——允许最终 K=0（全噪声）并返回
  ``NO_COHERENT_TOPICS``。

预算的每一处上限都可以在 manifest 里核对到，因此"某次运行花了多少算力"
是可解释的，而不是"跑到某个地方停了"。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math

import numpy as np

from ..errors import ClusterError
from ..features.semantic import cosine_to_centers
from .semantic_auto import assign, fit_mbk, recompute_centers

#: 粗候选网格。经验上中文短文本的簇数很少落在非 2 的幂上，粗网格先定位量级。
COARSE_KS = (2, 4, 8, 16, 32, 64, 128, 256)

#: 普通 K 候选总数上限（含粗候选 + 细候选）。
MAX_CANDIDATES = 12

#: 细候选最多补几个整数点。
MAX_FINE_CANDIDATES = 3

#: 小批次拆分后常把稀有主题的支持样本分散到两边；至少 128 条才独立留出。
#: 未留出的候选必须另查排除自身后的成员支持，不能靠自相似度通过门槛。
MIN_HOLDOUT_UNIQUE = 128

#: 候选拟合的迭代预算（比最终全量拟合小得多，选 K 不需要收敛到极致）。
CANDIDATE_MAX_ITER = 30

#: 候选拟合的初始化次数，显式固定，避免"每次选出的 K 不一样"。
CANDIDATE_N_INIT = 3

#: 验证集内"低支持簇"的下限；低于它的簇里的验证样本计入 Tiny 惩罚。
TINY_SUPPORT = 3

#: 得分并列容差：差值 ≤ 此值时优先较小 K。
TIE_TOLERANCE = 0.02


def _digest(salt: str, key: str) -> bytes:
    return hashlib.sha256(f"{salt}:{key}".encode("utf-8")).digest()


@dataclass
class CandidateScore:
    """一个候选 K 的全部评分分量与拒绝原因（进 manifest，不进响应正文）。"""

    k: int
    sep: float = 0.0
    coh: float = 0.0
    coverage: float = 0.0
    tiny: float = 0.0
    score: float = float("-inf")
    valid_clusters: int = 0
    rejected: str | None = None

    def as_dict(self) -> dict:
        return {
            "k": self.k,
            "sep": round(self.sep, 6),
            "coh": round(self.coh, 6),
            "coverage": round(self.coverage, 6),
            "tiny": round(self.tiny, 6),
            "score": None if not math.isfinite(self.score) else round(self.score, 6),
            "valid_clusters": self.valid_clusters,
            "rejected": self.rejected,
        }


@dataclass
class AutoKDiagnostics:
    """Auto-K 全过程诊断。"""

    status: str = "ok"
    low_support: bool = False
    k_cap: int = 0
    k_cap_reached: bool = False
    sample_size: int = 0
    train_size: int = 0
    validation_size: int = 0
    sample_key_fingerprint: str = ""
    candidates: list[CandidateScore] = field(default_factory=list)
    selected_k: int | None = None
    selection_reason: str = ""
    single_cluster: dict = field(default_factory=dict)
    stability: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "low_support": self.low_support,
            "k_cap": self.k_cap,
            "k_cap_reached": self.k_cap_reached,
            "sample_size": self.sample_size,
            "train_size": self.train_size,
            "validation_size": self.validation_size,
            "sample_key_fingerprint": self.sample_key_fingerprint,
            "candidates": [item.as_dict() for item in self.candidates],
            "selected_k": self.selected_k,
            "selection_reason": self.selection_reason,
            "single_cluster": dict(self.single_cluster),
            "stability": dict(self.stability),
            "warnings": list(self.warnings),
        }


def sample_split(
    unique_keys,
    *,
    sample_size: int,
    validation_size: int,
    salt: str = "auto-k-v1",
    buckets: int = 4,
) -> dict:
    """按固定哈希抽样并做互斥的训练/验证划分。

    关键点：抽样与划分**只看文本键的哈希**，与输入顺序、出现频次无关。
    因此"打乱输入顺序"不会改变 Auto-K 看到的数据，"某条文本重复 1000 次"
    也不会靠重复挤占抽样名额、把长尾主题挤出去。

    返回 ``{sample, train, validation, fingerprint}``（均为唯一文本下标）。
    """

    total = len(unique_keys)
    digests = [_digest(salt, key) for key in unique_keys]
    order = sorted(range(total), key=lambda index: (digests[index], unique_keys[index]))
    sample = order[: min(sample_size, total)]

    if len(sample) < MIN_HOLDOUT_UNIQUE:
        # 小批次：留出不成立，全部当训练集，并在诊断里标 low_support
        fingerprint = hashlib.sha256(b"".join(digests[index] for index in sample)).hexdigest()
        return {"sample": sample, "train": sample, "validation": sample, "fingerprint": fingerprint}

    validation = [index for index in sample if digests[index][0] % buckets == 0]
    if len(validation) > validation_size:
        validation = validation[:validation_size]
    validation_set = set(validation)
    train = [index for index in sample if index not in validation_set]
    if len(train) < 2 or not validation:
        # 退化：桶划分凑不出可用留出，退回全样本（结果会标 low_support）
        train, validation = sample, sample
    fingerprint = hashlib.sha256(b"".join(digests[index] for index in sample)).hexdigest()
    return {"sample": sample, "train": train, "validation": validation, "fingerprint": fingerprint}


def candidate_ks(unique_count: int, k_cap: int) -> list[int]:
    """生成粗候选 K 列表。

    上界三重受限：``k_cap``、``floor(U/3)``、以及候选本身至少要能容纳
    "每个簇 3 条不同文本"。这是"不宣称能在 10 万条里发现只有 2 条的主题"
    在候选层面的体现。
    """

    cap = int(max(1, min(k_cap, unique_count // 3)))
    if cap < 2:
        return []
    ks = [k for k in COARSE_KS if 2 <= k <= cap]
    if cap not in ks:
        ks.append(cap)
    return sorted(set(ks))


def expand_fine(ks: list[int], best: int, unique_count: int) -> list[int]:
    """在粗最优的相邻区间内补最多 3 个整数候选。"""

    if best not in ks:
        return []
    position = ks.index(best)
    neighbours = []
    if position > 0 and best - ks[position - 1] > 1:
        neighbours.append((ks[position - 1], best))
    if position + 1 < len(ks) and ks[position + 1] - best > 1:
        neighbours.append((best, ks[position + 1]))
    cap = int(max(1, min(unique_count // 3, ks[-1])))
    fine: list[int] = []
    for low, high in neighbours:
        gap = high - low
        for step in range(1, min(MAX_FINE_CANDIDATES, gap)):
            value = low + round(gap * step / (min(MAX_FINE_CANDIDATES, gap) + 1))
            if low < value < high and value <= cap:
                fine.append(int(value))
    return sorted({value for value in fine})[:MAX_FINE_CANDIDATES]


def _scale(value: float, low: float, high: float) -> float:
    """把分量线性映射到 [0, 1]，超出范围即夹住。"""

    if not math.isfinite(value) or high <= low:
        return 0.0
    return float(min(1.0, max(0.0, (value - low) / (high - low))))


def evaluate_candidate(
    space,
    train,
    validation,
    k: int,
    *,
    seed: int,
    max_iter: int,
    batch_size: int,
    n_init: int,
    t_sem: float,
    min_cluster_unique: int,
    scaling: dict,
    weights: dict,
    t_pair: float = 0.85,
) -> tuple[CandidateScore, dict]:
    """在一个候选 K 上拟合、验证并打分。

    流程刻意与最终流程保持一致：在 ``X_fit`` 上拟合（快），把标签回投到
    ``X_sem`` 重算中心，然后在 ``X_sem`` 上评估（准），并施加**同一套**
    轻量语义拒绝规则（``cos(s1) < t_sem`` 即拒绝）。
    """

    score = CandidateScore(k=k)
    train_matrix = space.fit[train]
    if train_matrix.shape[0] < max(2, k):
        score.rejected = "insufficient_train_rows"
        return score, {}

    fitted = fit_mbk(
        train_matrix,
        k,
        seed=seed,
        batch_size=min(batch_size, train_matrix.shape[0]),
        max_iter=min(max_iter, CANDIDATE_MAX_ITER),
        n_init=n_init,
    )
    labels_train = fitted["labels"]
    # 中心从 X_fit 回投到 X_sem：拟合空间只决定"谁和谁在一起"，语义空间决定"离得多远"
    centers_sem, empty = recompute_centers(space.sem[train], labels_train, k)
    live = [index for index in range(k) if index not in set(empty)]
    if len(live) < 2:
        score.rejected = "insufficient_valid_clusters"
        return score, {"empty_clusters": len(empty)}

    labels_val, similarity_val = assign(space.sem[validation], centers_sem)
    # 轻量语义拒绝：达不到最低成员语义支持的点视为被拒绝（与最终后处理同口径）
    accepted = similarity_val >= t_sem

    # 无独立留出时，成员与包含自身的中心天然更近。用簇内其他文本的
    # 平均成对相似度补充独立证据，单例不得给自己投票；不构造 N×N。
    if set(train) & set(validation):
        assigned = space.sem[validation]
        independent = np.zeros(len(validation), dtype=bool)
        for label in live:
            positions = np.flatnonzero(labels_val == label)
            if len(positions) < 2:
                continue
            members = assigned[positions]
            mean_pair = (members @ members.sum(axis=0) - np.einsum("ij,ij->i", members, members)) / (len(positions) - 1)
            independent[positions] = mean_pair >= t_pair
        accepted &= independent

    # 记录每个簇的验证支持量，用于 Tiny 惩罚
    support: dict[int, int] = {}
    for index, label in enumerate(labels_val):
        if accepted[index]:
            support[int(label)] = support.get(int(label), 0) + 1
    # 有效性门槛必须随验证集大小缩放：验证集只有 7 条时要求"每簇 3 条"会把
    # 唯一正确的划分也否掉，于是在小语料上永远返回全噪声。
    # Tiny 惩罚仍按固定 TINY_SUPPORT 计算，因此"靠拆碎拿满分"依然被压制。
    min_support = int(max(1, min(TINY_SUPPORT, min_cluster_unique, max(1, len(validation) // 4))))
    valid_clusters = [label for label, count in support.items() if count >= min_support]
    score.valid_clusters = len(valid_clusters)
    if len(valid_clusters) < 2:
        score.rejected = "insufficient_valid_clusters"
        return score, {"support": support}

    member_mask = np.array([accepted[index] and int(labels_val[index]) in set(valid_clusters) for index in range(len(validation))])
    if not member_mask.any():
        score.rejected = "no_accepted_members"
        return score, {"support": support}

    members = space.sem[np.asarray(validation)[member_mask]]
    member_labels = labels_val[member_mask]
    # 中心分离代理分数：a = 1-cos(自身中心)，b = 1-max(其他中心)；p = (b-a)/max(a,b)
    all_similarity = cosine_to_centers(members, centers_sem)
    own = all_similarity[np.arange(members.shape[0]), member_labels]
    other = all_similarity.copy()
    other[np.arange(members.shape[0]), member_labels] = -np.inf
    best_other = other.max(axis=1)
    a = np.maximum(1.0 - own, 0.0)
    b = np.maximum(1.0 - best_other, 0.0)
    separation = (b - a) / np.maximum(np.maximum(a, b), 1e-6)
    per_cluster_sep = []
    per_cluster_coh = []
    for label in valid_clusters:
        selected = member_labels == label
        if not selected.any():
            continue
        per_cluster_sep.append(float(np.clip(separation[selected], -1.0, 1.0).mean()))
        per_cluster_coh.append(float(own[selected].mean()))

    score.sep = float(np.mean(per_cluster_sep)) if per_cluster_sep else 0.0
    score.coh = float(np.mean(per_cluster_coh)) if per_cluster_coh else 0.0
    score.coverage = float(member_mask.sum()) / float(len(validation))
    tiny_members = sum(count for count in support.values() if count < TINY_SUPPORT)
    score.tiny = float(tiny_members) / float(max(1, len(validation)))

    sep_scaled = _scale(score.sep, scaling["sep_low"], scaling["sep_high"])
    coh_scaled = _scale(score.coh, scaling["coh_low"], scaling["coh_high"])
    k_cap = max(2, scaling["k_cap"])
    score.score = (
        weights["sep"] * sep_scaled
        + weights["coh"] * coh_scaled
        + weights["coverage"] * score.coverage
        - weights["tiny"] * score.tiny
        - weights["k_complexity"] * math.log(1 + k) / math.log(1 + k_cap)
    )
    return score, {
        "support": support,
        "empty_clusters": len(empty),
        "sep_scaled": sep_scaled,
        "coh_scaled": coh_scaled,
        # 样本解中心（拟合空间）留作全量拟合的初始中心，避免重复拟合
        "centers_fit": fitted["centers"],
    }


def evaluate_single_cluster(space, sample, *, t_single: float, t_pair: float, seed: int) -> dict:
    """K=1 基准：整批是否构成单一主题。

    用两个证据，都不依赖"第二个中心"：

    * 留一中心相似度的低分位（``q10``）——防止个别离群点把整体拉高；
    * 固定抽样成员对的相似度中位数——从句对层面确认同义性。

    小批次不宣称独立验证可靠性，只给单主题证据诊断。
    """

    matrix = space.sem[sample]
    total = matrix.shape[0]
    if total < 2:
        return {"eligible": total == 1, "reason": "singleton", "loo_q10": None, "pair_median": None}
    total_sum = matrix.sum(axis=0)
    norms = np.linalg.norm(matrix, axis=1)
    norms_safe = np.where(norms <= 1e-8, 1.0, norms)
    # 留一中心：总向量和减去自身；自身不能给自己投票
    leave_one_out = (total_sum[None, :] - matrix) / np.maximum(np.linalg.norm(total_sum[None, :] - matrix, axis=1), 1e-8)[:, None]
    loo = np.einsum("ij,ij->i", matrix, leave_one_out).astype(np.float32)
    loo_q10 = float(np.quantile(loo, 0.10))
    # 句对相似度：从抽样集里按哈希顺序取最多 512 对，避免 O(n²)
    pair_count = min(512, max(1, total // 2))
    pairs = []
    for offset in range(pair_count):
        left = (offset * 7 + 1) % total
        right = (offset * 13 + 3) % total
        if left != right:
            pairs.append(float(matrix[left] @ matrix[right]))
    pair_median = float(np.median(pairs)) if pairs else 0.0
    eligible = bool(loo_q10 >= t_single and pair_median >= t_pair)
    return {
        "eligible": eligible,
        "reason": None if eligible else "below_single_topic_threshold",
        "loo_q10": round(loo_q10, 6),
        "pair_median": round(pair_median, 6),
        "size": int(total),
    }


def challenge_stability(
    space,
    train_a,
    validation,
    k_a: int,
    k_b: int,
    *,
    seed: int,
    max_iter: int,
    batch_size: int,
    n_init: int,
    salt: str,
) -> dict:
    """对得分前两名做挑战重拟合，比较划分一致性与噪声集合一致性。

    稳定性不达门槛时**加诊断**，不伪造"高质量"。这里不返回"通过/不通过"，
    只返回实测数字，由调用方决定如何展示。
    """

    train_b = list(train_a)
    if len(train_b) > 4:
        # 用另一个固定种子桶重排训练集顺序，改变批次顺序但不改变数据集合
        order = sorted(train_b, key=lambda index: hashlib.sha256(f"{salt}:{index}".encode()).hexdigest())
        train_b = order
    outcomes = []
    for k in (k_a, k_b):
        fitted = fit_mbk(
            space.fit[train_b],
            k,
            seed=seed + 1,
            batch_size=min(batch_size, len(train_b)),
            max_iter=min(max_iter, CANDIDATE_MAX_ITER),
            n_init=n_init,
        )
        centers, _empty = recompute_centers(space.sem[train_b], fitted["labels"], k)
        labels, _scores = assign(space.sem[validation], centers)
        outcomes.append(labels)
    left, right = outcomes
    return {
        "k_pair": [int(k_a), int(k_b)],
        "same_partition": bool(np.array_equal(left, right)),
        # 原始标签一致率：只有两次运行的簇号恰好相同时才有意义，
        # 它是下界指标；主指标是下面的 ari（对标签置换不变）
        "raw_label_agreement": round(float((left == right).mean()), 6),
        "ari": round(_adjusted_rand(left, right), 6),
        "noise_jaccard": round(_noise_jaccard(left, right), 6),
    }


def _adjusted_rand(left: np.ndarray, right: np.ndarray) -> float:
    """ARI 的 contingency 计数实现。"""

    from sklearn.metrics import adjusted_rand_score

    if len(set(left.tolist())) < 2 and len(set(right.tolist())) < 2:
        return 1.0
    return float(adjusted_rand_score(left, right))


def _noise_jaccard(left: np.ndarray, right: np.ndarray) -> float:
    """噪声集合 Jaccard；双方都无噪声时定义为 1。"""

    left_noise = set(np.nonzero(np.asarray(left) == -1)[0].tolist())
    right_noise = set(np.nonzero(np.asarray(right) == -1)[0].tolist())
    if not left_noise and not right_noise:
        return 1.0
    union = left_noise | right_noise
    return float(len(left_noise & right_noise)) / float(len(union)) if union else 1.0


def _trivial_outcome(
    space,
    unique_keys,
    diagnostics: AutoKDiagnostics,
    labels: np.ndarray,
    reason: str,
    *,
    calibration: dict,
) -> dict:
    """单簇 / 两两 / 全噪声这类退化结果的统一返回。

    这类结果**照常算中心**：单簇有真实中心（用于代表文本与命名），
    全噪声没有有效簇因此中心为空——不为噪声造质心。
    成员状态同样按统一口径判定，因此上层拿到的是同一种结构，
    不需要为"退化情况"写第二套分支。
    """

    from . import postprocess

    labels = np.asarray(labels, dtype=np.int32)
    live = sorted({int(label) for label in labels if int(label) >= 0})
    if live:
        rebuilt, _empty = recompute_centers(space.sem, labels, max(live) + 1)
        centers = rebuilt[live]
    else:
        centers = np.zeros((0, space.sem_dim), dtype=np.float32)

    states, membership = postprocess.classify_members(
        space,
        labels,
        centers,
        t_sem=float(calibration["t_sem"]),
        t_margin=float(calibration["t_margin"]),
        # 退化情况下"每个簇 3 条不同文本才能构成核心"必然不成立，
        # 因此这里放宽到 1：低支持由 quality_status=low_support 表达，而不是伪装成噪声
        min_core=1,
    )
    labels_out, counts = postprocess.apply_statuses(labels, states)
    diagnostics.selected_k = len(live)
    diagnostics.selection_reason = reason
    return {
        "labels": labels_out,
        "centers": centers,
        "auto_k": diagnostics,
        "final_k": len(live),
        "status": diagnostics.status,
        "states": states,
        "counts": counts,
        "postprocess": {
            "refine_log": [],
            "split_log": [],
            "merge_log": [],
            "small_cluster_log": [],
            "numbering": {},
            "membership": membership,
            "empty_clusters": [],
            "n_clusters": len(live),
        },
        "merge_log": [],
        "split_log": [],
    }


def run_auto_k(
    space,
    *,
    unique_keys,
    frequencies=None,
    texts=None,
    k_cap: int = 256,
    seed: int = 42,
    sample_size: int = 8192,
    validation_size: int = 2048,
    forced_k: int | None = None,
    max_iter: int = 100,
    batch_size: int = 1024,
    n_init: int = 3,
    t_sem: float = 0.80,
    t_pair: float = 0.85,
    t_single: float = 0.85,
    t_merge: float = 0.88,
    t_margin: float = 0.03,
    min_cluster_unique: int = 5,
    split_budget: int = 8,
    merge_rounds: int = 2,
    refine_rounds: int = 2,
    scaling: dict | None = None,
    weights: dict | None = None,
) -> dict:
    """执行完整的有界聚类链：Auto-K → 全量拟合 → 后处理 → 规范编号。

    返回统一结构：``{labels, centers, auto_k, final_k, status, states, counts,
    postprocess, merge_log, split_log}``。所有分支（正常、单簇、两两、
    全噪声）都返回同一组键，上层不需要区分"退化情况"。

    后处理（小簇保护、合并、拆分、编号）由 ``clustering.postprocess`` 完成，
    与本模块共用同一份 ``X_sem``，不存在两套语义口径。
    """

    from . import postprocess

    calibration = {"t_sem": t_sem, "t_pair": t_pair, "t_merge": t_merge, "t_margin": t_margin}
    frequency_list = [int(value) for value in (frequencies if frequencies is not None else [1] * len(unique_keys))]

    unique_count = int(space.sem.shape[0])
    weights = {
        "sep": 0.45,
        "coh": 0.35,
        "coverage": 0.20,
        "tiny": 0.15,
        "k_complexity": 0.05,
        **(weights or {}),
    }
    scaling = {
        "sep_low": t_margin,
        "sep_high": 0.35,
        "coh_low": t_sem,
        "coh_high": 0.98,
        "k_cap": float(k_cap),
        **(scaling or {}),
    }
    diagnostics = AutoKDiagnostics(k_cap=int(k_cap))
    diagnostics.warnings.extend(
        [
            "AUTO_K_NO_UNIQUE_TRUTH",
            "AUTO_K_SAMPLING_MAY_MISS_RARE_TOPICS",
        ]
    )

    if unique_count == 0:
        raise ClusterError("EMPTY_DATASET", "No valid text to cluster", 422)
    if unique_count == 1:
        diagnostics.status = "singleton"
        diagnostics.low_support = True
        return _trivial_outcome(
            space, unique_keys, diagnostics, np.zeros(1, dtype=np.int32), "single_unique_text", calibration=calibration
        )

    if unique_count == 2:
        # 两条不同文本：语义相近则同簇，否则全判噪声（不硬造两个"高质量单例簇"）
        similarity = float(space.sem[0] @ space.sem[1])
        diagnostics.status = "pair"
        diagnostics.low_support = True
        diagnostics.single_cluster = {"eligible": similarity >= t_pair, "pair_similarity": round(similarity, 6)}
        if similarity >= t_pair:
            return _trivial_outcome(
                space, unique_keys, diagnostics, np.zeros(2, dtype=np.int32), "pair_coherent", calibration=calibration
            )
        return _trivial_outcome(
            space, unique_keys, diagnostics, np.full(2, -1, dtype=np.int32), "pair_unrelated", calibration=calibration
        )

    split = sample_split(unique_keys, sample_size=sample_size, validation_size=validation_size)
    sample = split["sample"]
    train = split["train"]
    validation = split["validation"]
    diagnostics.sample_size = len(sample)
    diagnostics.train_size = len(train)
    diagnostics.validation_size = len(validation)
    diagnostics.sample_key_fingerprint = split["fingerprint"]
    if len(sample) < MIN_HOLDOUT_UNIQUE:
        diagnostics.low_support = True
        diagnostics.warnings.append("SMALL_BATCH_NO_HOLDOUT")

    diagnostics.single_cluster = evaluate_single_cluster(space, sample, t_single=t_single, t_pair=t_pair, seed=seed)

    explicit = candidate_ks(len(train), k_cap) if forced_k is None else [int(forced_k)]
    ks = explicit[:MAX_CANDIDATES]

    scores: dict[int, CandidateScore] = {}
    extras: dict[int, dict] = {}
    for k in ks:
        score, extra = evaluate_candidate(
            space,
            train,
            validation,
            k,
            seed=seed,
            max_iter=max_iter,
            batch_size=batch_size,
            n_init=n_init,
            t_sem=t_sem,
            t_pair=t_pair,
            min_cluster_unique=min_cluster_unique,
            scaling=scaling,
            weights=weights,
        )
        scores[k] = score
        extras[k] = extra or {}

    # 粗网格定位量级后，只在最优邻居区间内补细候选（有界，不重扫全网格）
    eligible = [item for item in scores.values() if math.isfinite(item.score)]
    if forced_k is None and eligible:
        best_coarse = max(eligible, key=lambda item: (item.score, -item.k)).k
        for k in expand_fine(ks, best_coarse, unique_count):
            if k in scores or len(scores) >= MAX_CANDIDATES:
                continue
            score, extra = evaluate_candidate(
                space,
                train,
                validation,
                k,
                seed=seed,
                max_iter=max_iter,
                batch_size=batch_size,
                n_init=n_init,
                t_sem=t_sem,
                t_pair=t_pair,
                min_cluster_unique=min_cluster_unique,
                scaling=scaling,
                weights=weights,
            )
            scores[k] = score
            extras[k] = extra or {}

    # 细候选加入后必须重新收集合格解，否则排序仍停留在粗网格结果上
    eligible = [item for item in scores.values() if math.isfinite(item.score)]
    diagnostics.candidates = [scores[k] for k in sorted(scores)]

    # K=1 与多簇解在同一个尺度上比较：缺失的分离项按剩余权重归一，不把 M 当成 1
    single = diagnostics.single_cluster
    single_score = None
    if single.get("eligible"):
        coh_one = float(np.mean(space.sem[sample] @ _unit(space.sem[sample].sum(axis=0))))
        coh_scaled = _scale(coh_one, scaling["coh_low"], scaling["coh_high"])
        remainder = weights["coh"] + weights["coverage"]
        single_score = (weights["coh"] * coh_scaled + weights["coverage"] * 1.0) / remainder
        single["cohesion"] = round(coh_one, 6)
        single["score"] = round(single_score, 6)

    if not eligible:
        if single_score is not None:
            diagnostics.status = "single_cluster"
            return _trivial_outcome(
                space, unique_keys, diagnostics, np.zeros(unique_count, dtype=np.int32), "single_topic_gate_only_eligible_solution", calibration=calibration
            )
        diagnostics.status = "no_coherent_topics"
        diagnostics.warnings.append("NO_COHERENT_TOPICS")
        return _trivial_outcome(
            space, unique_keys, diagnostics, np.full(unique_count, -1, dtype=np.int32), "no_candidate_passed_semantic_gates", calibration=calibration
        )

    ranked = sorted(eligible, key=lambda item: (-item.score, item.k))
    best = ranked[0]
    if single_score is not None and single_score >= best.score - TIE_TOLERANCE:
        diagnostics.status = "single_cluster"
        return _trivial_outcome(
            space, unique_keys, diagnostics, np.zeros(unique_count, dtype=np.int32), "single_topic_gate_not_worse_than_best_multi_cluster", calibration=calibration
        )

    if len(ranked) > 1:
        diagnostics.stability = challenge_stability(
            space,
            train,
            validation,
            ranked[0].k,
            ranked[1].k,
            seed=seed,
            max_iter=max_iter,
            batch_size=batch_size,
            n_init=n_init,
            salt="auto-k-challenge",
        )

    diagnostics.selected_k = best.k
    diagnostics.k_cap_reached = best.k >= min(k_cap, len(train) // 3)
    diagnostics.selection_reason = "best_composite_score"
    diagnostics.status = "ok"

    # 全量拟合：用样本解中心初始化，显式 n_init=1，唯一文本顺序固定
    fitted = fit_mbk(
        space.fit,
        best.k,
        seed=seed,
        batch_size=batch_size,
        max_iter=max_iter,
        n_init=n_init,
        centers=extras.get(best.k, {}).get("centers_fit"),
    )
    post = postprocess.run_postprocess(
        space,
        fitted["labels"],
        keys=list(unique_keys),
        frequencies=frequency_list,
        calibration=calibration,
        min_cluster_unique=min_cluster_unique,
        split_budget=split_budget,
        merge_rounds=merge_rounds,
        refine_rounds=refine_rounds,
        seed=seed,
        texts=texts,
        # 近零范数的坏向量由语义空间标出，这里原样传给成员判定做隔离
        bad_rows=getattr(space, "bad_rows", ()),
    )
    return {
        "labels": post["labels"],
        "centers": post["centers"],
        "auto_k": diagnostics,
        "final_k": int(post["n_clusters"]),
        "status": diagnostics.status,
        "states": post["states"],
        "counts": post["counts"],
        "postprocess": post,
        "merge_log": post["merge_log"],
        "split_log": post["split_log"],
    }


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-8:
        return np.zeros_like(vector, dtype=np.float32)
    return (vector / norm).astype(np.float32)


__all__ = [
    "AutoKDiagnostics",
    "CandidateScore",
    "COARSE_KS",
    "MAX_CANDIDATES",
    "MIN_HOLDOUT_UNIQUE",
    "TIE_TOLERANCE",
    "candidate_ks",
    "expand_fine",
    "evaluate_candidate",
    "evaluate_single_cluster",
    "challenge_stability",
    "sample_split",
    "run_auto_k",
]
