"""语义结果的"可读化"：代表文本、稀疏关键词、证据式命名、归属置信度与簇质量分。

定位：**不参与任何聚类决策**。簇划分、噪声判定、规范编号全部在
``clustering.auto_k`` / ``clustering.postprocess`` 完成；这里只把已经确定的
划分翻译成"人看得懂、且每一句都有原文证据"的结果。

与 legacy ``app/services/cluster_digest.py`` 的三处关键差别：

1. **关键词口径**：这里用的是版本化的"类别词频 TF-IDF"
   （``tf(t,c)=count(t,c)/Σcount``、``idf=log(1+(C+1)/(df_cluster+1))``，
   再乘代表文本覆盖率），不是把现有文档 TF-IDF 的簇内均值改个名字。
2. **命名有证据**：名称必须能在本簇真实文本里找到出处；找不到就降级为
   关键词拼接、再降级为中心样本片段，并如实写出 ``nameSource``。
   不凭空生成文本未支持的因果、责任、风险等级。
3. **分数带版本**：confidence 与 quality 都声明自己的版本与口径
   （``distanceMetric=cosine``），不与历史 min-max 分数直接比大小。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import math

import numpy as np

from ..clustering.postprocess import (
    STATUS_BORDERLINE,
    STATUS_CORE,
    STATUS_DUPLICATE_ONLY,
    STATUS_INVALID,
    STATUS_NOISE,
    STATUS_SMALL_COHERENT,
    NEGATION_TOKENS as _NEGATION_TOKENS,
    membership_similarity,
    negation_polarity as _postprocess_negation_polarity,
)

#: 各口径的版本号，随产物一起落盘。改规则必须改版本。
TOKENIZER_VERSION = "jieba-generic-v1"
STOPWORD_VERSION = "zh-generic-v1"
NAMING_VERSION = "semantic-naming-v1"
QUALITY_VERSION = "semantic-quality-v1"
CONFIDENCE_VERSION = "semantic-confidence-v1"

#: 分词词典上限（防止极端语料把词表撑爆）。
DEFAULT_VOCAB_LIMIT = 30000

#: 每个簇的短语候选/代表候选上限。
DEFAULT_CANDIDATE_LIMIT = 20

#: MMR 的代表性权重（余下的权重用于"与已选代表不重复"）。
MMR_LAMBDA = 0.7

#: 名称长度区间（汉字数）。
NAME_MIN_CHARS = 6
NAME_MAX_CHARS = 18

#: 否定与状态反转词由 postprocess 统一定义，避免两处词表分叉。
NEGATION_TOKENS = _NEGATION_TOKENS

#: 通用功能词停用词。只含虚词与套话，**不含**否定词与对象名。
STOPWORDS = frozenset(
    [
        "的", "了", "在", "是", "和", "与", "及", "或", "等", "对", "为", "从", "以",
        "并", "被", "把", "中", "上", "下", "内", "外", "后", "前", "到", "着", "过",
        "也", "都", "还", "就", "而", "之", "其", "该", "本", "有", "会", "能", "可",
        "这个", "那个", "我们", "他们", "以及", "但是", "因为", "所以", "如果", "并且",
    ]
)

#: 关键词提取时过滤掉的单字符与纯标点。
_PUNCT_TOKENS = set("，。；：、（）()[]{},.;:!?！？\"'“”‘’·-—_/\\|<>@#$%^&*+=~`")


def _jieba():
    """惰性获取 jieba；不可用时返回 None（调用方降级到字符 n-gram）。"""

    try:
        import jieba

        jieba.setLogLevel("ERROR")
        return jieba
    except ImportError:
        return None


@dataclass
class NamingOutcome:
    """一次命名的结果与证据来源。"""

    name: str
    source: str  # representative_phrase | keyword_pair | fallback_text | fallback_id
    evidence: str | None = None


def tokenize(text: str, jieba_module=None) -> list[str] | None:
    """分词并过滤停用词/单字/纯标点。jieba 缺失时返回 None。"""

    module = jieba_module if jieba_module is not None else _jieba()
    if module is None:
        return None
    tokens = []
    for word in module.cut(text):
        candidate = word.strip()
        if not candidate or candidate in STOPWORDS or candidate in _PUNCT_TOKENS:
            continue
        # 单字保留：中文里"门""锁""阀"这类单字对象名恰恰是主题线索
        tokens.append(candidate)
    return tokens


def char_ngrams(text: str, *, size: int = 2, limit: int = 400) -> list[str]:
    """字符 n-gram 降级方案；有界，不随文本长度无限增长。"""

    compact = "".join(char for char in text if char not in _PUNCT_TOKENS and not char.isspace())
    if len(compact) < size:
        return [compact] if compact else []
    return [compact[index : index + size] for index in range(min(limit, len(compact) - size + 1))]


def document_terms(text: str, jieba_module=None) -> tuple[list[str], bool]:
    """返回 ``(词项, 是否降级)``。"""

    tokens = tokenize(text, jieba_module=jieba_module)
    if tokens is None:
        return char_ngrams(text), True
    return tokens, False


def cluster_terms(texts, jieba_module=None) -> tuple[list[Counter], bool]:
    """对一批文本分词，返回每条的词频计数与"是否使用了降级分词"。"""

    counters: list[Counter] = []
    degraded = False
    for text in texts:
        tokens = tokenize(text, jieba_module=jieba_module)
        if tokens is None:
            tokens = char_ngrams(text)
            degraded = True
        counters.append(Counter(tokens))
    return counters, degraded


def class_tfidf(
    member_counters: list[Counter],
    all_cluster_counters: list[list[Counter]],
    *,
    coverage_texts=None,
    vocab_limit: int = DEFAULT_VOCAB_LIMIT,
) -> list[tuple[str, float]]:
    """类别词频 TF-IDF：``score = tf × idf × 代表覆盖率``。

    * ``tf(t,c) = count(t,c) / Σ_t count(t,c)``——簇内词频占比；
    * ``idf(t) = log(1 + (C+1) / (df_cluster(t)+1))``——只在少数簇里出现的词更有区分度；
    * ``代表覆盖率``= 词项出现于多少条代表文本中，避免把单条边缘样本的罕见词当主题。

    只遍历稀疏非零项，绝不构造 ``簇数 × 词表`` 的稠密矩阵。
    """

    total_terms = sum(sum(counter.values()) for counter in member_counters)
    if total_terms == 0:
        return []
    # df_cluster：包含该词项的簇数量（按"词项出现在该簇多少条文本"折算成簇级文档频次）
    cluster_count = len(all_cluster_counters)
    df: Counter = Counter()
    for counters in all_cluster_counters:
        seen = set()
        for counter in counters:
            seen.update(counter.keys())
        for term in seen:
            df[term] += 1

    merged: Counter = Counter()
    for counter in member_counters:
        merged.update(counter)
    if len(merged) > vocab_limit:
        merged = Counter(dict(merged.most_common(vocab_limit)))

    coverage: Counter = Counter()
    if coverage_texts is not None:
        for counter in coverage_texts:
            coverage.update(set(counter.keys()))

    scored: list[tuple[str, float]] = []
    for term, count in merged.items():
        tf = count / total_terms
        idf = math.log(1.0 + (cluster_count + 1) / (df.get(term, 1) + 1))
        cover = 1.0 if not coverage else (coverage.get(term, 0) / max(1, len(coverage_texts)))
        scored.append((term, tf * idf * (0.5 + 0.5 * cover)))
    scored.sort(key=lambda item: (-item[1], item[0]))
    return scored


def pick_representatives(
    indices,
    similarity,
    matrix,
    *,
    limit: int = 3,
    candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
    tie_break=None,
) -> list[int]:
    """在核心候选里用 MMR 挑代表文本：既要有代表性，又要避免措辞重复。

    MMR 只在固定的小候选集内比较（≤20 条），因此代价恒定；
    同分时按 ``tie_break``（规范化文本键、原始 ID）裁决，保证结果确定。
    """

    if not indices:
        return []
    order = sorted(indices, key=lambda index: (-float(similarity[index]), (tie_break or (lambda i: ""))(index)))
    candidates = order[:candidate_limit]
    selected: list[int] = []
    while candidates and len(selected) < max(1, limit):
        best_index = None
        best_score = -np.inf
        for index in candidates:
            relevance = float(similarity[index])
            if selected:
                redundancy = max(float(matrix[index] @ matrix[other]) for other in selected)
            else:
                redundancy = 0.0
            value = MMR_LAMBDA * relevance - (1.0 - MMR_LAMBDA) * redundancy
            if value > best_score + 1e-9:
                best_score, best_index = value, index
        if best_index is None:
            break
        selected.append(best_index)
        candidates = [index for index in candidates if index != best_index]
    return selected


def _clean_phrase(text: str) -> str:
    return "".join(char for char in text if char not in _PUNCT_TOKENS and not char.isspace())


def name_from_text(text: str, keywords: list[str], *, min_chars: int = NAME_MIN_CHARS, max_chars: int = NAME_MAX_CHARS) -> str | None:
    """从一条真实文本里抽取"覆盖高权重关键词的连续短语"。

    取第一个关键词在文中的位置，向后扩展到覆盖尽量多关键词、且长度落在
    ``[min_chars, max_chars]`` 的窗口。窗口必须来自原文，因此名称天然有证据。
    """

    cleaned = _clean_phrase(text)
    if not cleaned:
        return None
    positions = []
    for keyword in keywords:
        token = _clean_phrase(keyword)
        if not token:
            continue
        position = cleaned.find(token)
        if position >= 0:
            positions.append((position, position + len(token)))
    if not positions:
        return None
    start = min(item[0] for item in positions)
    end = start
    for left, right in sorted(positions):
        if right - start <= max_chars:
            end = max(end, right)
        else:
            break
    if end - start < min_chars:
        # 太短则向右补足，仍然取自原文
        end = min(len(cleaned), start + min_chars)
    phrase = cleaned[start:end]
    if len(phrase) > max_chars:
        phrase = phrase[:max_chars]
    return phrase or None


def name_cluster(
    *,
    representative_texts: list[str],
    representative_ids: list[str],
    keywords: list[str],
    fallback_id: str,
) -> NamingOutcome:
    """按"代表文本短语 → 关键词组合 → 中心样本片段 → 簇 ID"逐级降级命名。

    通用文本不强制附加"隐患"二字；命名失败只降级命名，不影响已完成的聚类。
    """

    if not keywords:
        if representative_texts:
            snippet = _clean_phrase(representative_texts[0])[:NAME_MAX_CHARS]
            if snippet:
                return NamingOutcome(name=snippet, source="fallback_text", evidence=representative_texts[0])
        return NamingOutcome(name=fallback_id, source="fallback_id", evidence=None)

    for text in representative_texts:
        phrase = name_from_text(text, keywords)
        if phrase:
            return NamingOutcome(name=phrase, source="representative_phrase", evidence=text)

    pair = "".join(_clean_phrase(term) for term in keywords[:2])
    if pair:
        return NamingOutcome(name=pair[:NAME_MAX_CHARS], source="keyword_pair", evidence=representative_texts[0] if representative_texts else None)
    if representative_texts:
        return NamingOutcome(
            name=_clean_phrase(representative_texts[0])[:NAME_MAX_CHARS], source="fallback_text", evidence=representative_texts[0]
        )
    return NamingOutcome(name=fallback_id, source="fallback_id", evidence=None)


def dedupe_names(names: list[str], cluster_ids: list[int]) -> list[str]:
    """解决重名：先加真实区分词（编号），再退化为簇 ID。成员归属不受影响。"""

    counts = Counter(names)
    resolved: list[str] = []
    for name, cluster_id in zip(names, cluster_ids):
        if counts[name] == 1:
            resolved.append(name)
            continue
        resolved.append(f"{name}（第 {cluster_id + 1} 组）")
    return resolved


def member_confidence(
    *,
    s1: float | None,
    margin: float | None,
    core_support: float | None,
    t_sem: float,
    t_margin: float,
    weights: dict,
    single_cluster: bool,
) -> float | None:
    """启发式归属支持分（**不是概率**）。

    ``A=clip((s1-t_sem)/(1-t_sem))``、``M=clip(margin/t_margin)``、
    ``L`` 为归一化的核心支持分量。单簇时 M 不可用——按剩余项重新归一权重，
    绝不把 M 默认为 1（那会凭空抬高单簇结果的可信度）。
    """

    if s1 is None or core_support is None:
        return None
    a = 0.0 if 1.0 - t_sem <= 0 else float(np.clip((s1 - t_sem) / (1.0 - t_sem), 0.0, 1.0))
    l = float(np.clip(core_support, 0.0, 1.0))
    if single_cluster or margin is None:
        total = weights["a"] + weights["l"]
        return float((weights["a"] * a + weights["l"] * l) / total) if total > 0 else None
    m = 0.0 if t_margin <= 0 else float(np.clip(margin / t_margin, 0.0, 1.0))
    return float(weights["a"] * a + weights["m"] * m + weights["l"] * l)


def cluster_quality(
    *,
    cohesion: float | None,
    separation: float | None,
    retained_ratio: float | None,
    unique_size: int,
    weights: dict,
    scaling: dict,
) -> tuple[float | None, str]:
    """簇级质量分：``C / S / R / E`` 四分量，缺失项按剩余权重归一。

    * C 凝聚（均值与低分位共同考虑）、S 分离支持、R 通过门槛比例（保留后处理前分母，
      防止"删光差样本后得满分"）、E 独立支持量。
    少于 3 条不同有效文本时不给正式分数，返回 ``low_support``。
    """

    if unique_size < 3 or cohesion is None:
        return None, "low_support"
    components: list[tuple[float, float]] = []
    c = float(np.clip((cohesion - scaling["coh_low"]) / max(1e-6, scaling["coh_high"] - scaling["coh_low"]), 0.0, 1.0))
    components.append((weights["c"], c))
    if separation is not None:
        s = float(np.clip((separation - scaling["sep_low"]) / max(1e-6, scaling["sep_high"] - scaling["sep_low"]), 0.0, 1.0))
        components.append((weights["s"], s))
    if retained_ratio is not None:
        components.append((weights["r"], float(np.clip(retained_ratio, 0.0, 1.0))))
    e = float(min(1.0, math.log(1 + unique_size) / math.log(21)))
    components.append((weights["e"], e))
    total_weight = sum(weight for weight, _value in components)
    if total_weight <= 0:
        return None, "unscored"
    score = sum(weight * value for weight, value in components) / total_weight
    status = "evaluated" if separation is not None else "single_cluster_separation_unevaluated"
    return float(score), status


def negation_polarity(texts, *, limit: int = 20) -> float | None:
    """估计一组文本的"否定占比"（委托给 postprocess 的同一实现，避免两套口径）。

    只用于合并的保守 veto：一半明确否定、一半明确肯定时不要合并。
    规则不声称能覆盖所有反义表达，因此只做否决、不做肯定。
    """

    return _postprocess_negation_polarity(list(texts)[:limit])


def build_semantic_digest(
    *,
    corpus,
    labels,
    states,
    space,
    centers,
    calibration,
    top_keywords: int = 8,
    representatives: int = 3,
    keyword_vocab_limit: int = DEFAULT_VOCAB_LIMIT,
    selected_k: int | None = None,
) -> dict:
    """把最终划分翻译成网关可直接消费的 ``clusters`` / ``items`` / ``aggregate``。

    ``labels`` 是**唯一文本**上的标签；本函数负责展开回全部原始 ID，
    并保证"每个已接受输入 ID 恰好出现一次"且计数守恒
    （非噪声数 + 噪声数 = 总条数）。
    """

    texts = [entry.text for entry in corpus.unique]
    total_unique = corpus.unique_count
    total = corpus.total
    frequencies = [entry.frequency for entry in corpus.unique]

    # 原始索引 -> 唯一文本下标 / 具体出现位置（重复文本每一份都要能回溯）
    index_to_unique = [-1] * total
    occurrence_by_index: dict[int, object] = {}
    for unique_index, entry in enumerate(corpus.unique):
        for occurrence in entry.occurrences:
            index_to_unique[occurrence.index] = unique_index
            occurrence_by_index[occurrence.index] = occurrence

    similarity = np.zeros(total_unique, dtype=np.float32)
    margin = np.zeros(total_unique, dtype=np.float32)
    if centers is not None and getattr(centers, "shape", (0,))[0] >= 1 and total_unique:
        s1, s2, _other = membership_similarity(space.sem, centers)
        similarity, margin = s1, (s1 - s2) if centers.shape[0] > 1 else np.zeros(total_unique, dtype=np.float32)

    live = sorted({int(label) for label in labels if int(label) >= 0})
    counters, degraded = cluster_terms(texts)
    all_counters = [
        [counters[position] for position, label in enumerate(labels) if int(label) == cluster] for cluster in live
    ]
    warnings: list[str] = []
    if degraded:
        warnings.append("NAMING_DEGRADED")

    # 先把**每条**唯一文本的兜底归属写下来，再由下面的 per-cluster 循环覆盖。
    #
    # 为什么必须这么做：per-cluster 循环只遍历"存活簇"，因此当所有簇都没通过门槛
    # （finalK=0）时它一次都不会执行，``item_states`` 会空掉，明细里的 noise_reason
    # 就统一退化成 "unclustered"——把 "核心不足"、"超出簇半径"、"重复过多" 这些
    # 真实原因全部抹掉，用户看到的结果就无法解释了。
    item_states: dict[int, dict] = {}
    for index in range(total_unique):
        state = states[index]
        item_states[index] = {
            "status": state.status,
            "cluster": int(state.cluster),
            "confidence": None,
            "distance": (
                None
                if state.status == STATUS_NOISE or state.s1 is None
                else round(float(1.0 - state.s1), 6)
            ),
            "noise_reason": state.noise_reason,
        }

    # 每簇核心支持分量的归一化区间（用于 confidence 的 L 项）
    core_scale: dict[int, tuple[float, float]] = {}
    for position, cluster in enumerate(live):
        members = [index for index, label in enumerate(labels) if int(label) == cluster]
        values = [float(similarity[index]) for index in members]
        if not values:
            core_scale[cluster] = (0.0, 0.0)
            continue
        low = float(np.quantile(values, 0.10))
        high = float(np.quantile(values, 0.90))
        core_scale[cluster] = (low, high if high > low else low + 1e-6)

    clusters: list[dict] = []
    cluster_quality_values: list[float] = []
    cluster_quality_sizes: list[int] = []
    raw_names: list[str] = []

    for position, cluster in enumerate(live):
        members = [index for index, label in enumerate(labels) if int(label) == cluster]
        retained = [
            index
            for index in members
            if states[index].status in {STATUS_CORE, STATUS_BORDERLINE, STATUS_SMALL_COHERENT, STATUS_DUPLICATE_ONLY}
        ]
        core = [index for index in retained if states[index].status in {STATUS_CORE, STATUS_BORDERLINE}]
        # 展开重复后的真实条数：分母是原始总条数，噪声与 invalid 都算在内
        original_size = sum(frequencies[index] for index in retained)
        unique_size = len(retained)

        # 关键词：只在"被保留的成员"上聚合，避免把噪声词带进主题
        if core:
            coverage_counters = [counters[index] for index in core[: max(1, min(len(core), 20))]]
            scored = class_tfidf(
                [counters[index] for index in core],
                all_counters,
                coverage_texts=coverage_counters,
                vocab_limit=keyword_vocab_limit,
            )
            keywords = [term for term, _score in scored[: max(1, top_keywords)]]
        else:
            keywords = []

        # 代表文本：核心成员按到中心相似度排序后做 MMR 去重
        representative_indices = pick_representatives(
            core,
            similarity,
            space.sem,
            limit=representatives,
            tie_break=lambda index: (corpus.unique[index].key, corpus.unique[index].primary_id),
        )
        representative_texts = [texts[index] for index in representative_indices]
        naming = name_cluster(
            representative_texts=representative_texts,
            representative_ids=[corpus.unique[index].primary_id for index in representative_indices],
            keywords=keywords,
            fallback_id=f"类别 {cluster + 1}",
        )
        raw_names.append(naming.name)

        cohesion = float(np.mean([similarity[index] for index in core])) if core else None
        separation = _cluster_separation(space, centers, labels, cluster, core) if len(live) > 1 and core else None
        retained_ratio = (len(retained) / len(members)) if members else None
        quality, quality_status = cluster_quality(
            cohesion=cohesion,
            separation=separation,
            retained_ratio=retained_ratio,
            unique_size=unique_size,
            weights=calibration["quality_weights"],
            scaling=calibration["scaling"],
        )

        cluster_low, cluster_high = core_scale.get(cluster, (0.0, 1.0))
        representative_samples = []
        for index in representative_indices:
            s1 = float(similarity[index])
            support = float(np.clip((s1 - cluster_low) / (cluster_high - cluster_low), 0.0, 1.0))
            confidence = member_confidence(
                s1=s1,
                margin=float(margin[index]) if len(live) > 1 else None,
                core_support=support,
                t_sem=calibration["t_sem"],
                t_margin=calibration["t_margin"],
                weights=calibration["confidence_weights"],
                single_cluster=len(live) <= 1,
            )
            representative_samples.append(
                {
                    "id": corpus.unique[index].primary_id,
                    "text": texts[index],
                    "confidence": None if confidence is None else round(confidence, 4),
                    "distance": round(float(1.0 - s1), 6),
                }
            )

        metadata_distribution: dict[str, list[dict]] = {}
        metadata_keys: list[str] = []
        for index in retained:
            for key in corpus.unique[index].occurrences[0].metadata:
                if key not in metadata_keys:
                    metadata_keys.append(key)
        for key in metadata_keys:
            counter: Counter = Counter()
            for index in retained:
                for occurrence in corpus.unique[index].occurrences:
                    value = str(occurrence.metadata.get(key, "") or "")
                    if value:
                        # 按原始出现次数计，重复行不会被压缩掉
                        counter[value] += 1
            if counter:
                metadata_distribution[key] = [{"value": value, "count": count} for value, count in counter.most_common(6)]

        clusters.append(
            {
                "cluster_id": int(cluster),
                "cluster_name": naming.name,
                "name_source": naming.source,
                "name_evidence": naming.evidence,
                "naming_version": NAMING_VERSION,
                "size": int(original_size),
                "unique_size": int(unique_size),
                "percentage": round(100.0 * original_size / max(1, total), 4),
                "keywords": keywords,
                "cohesion": None if cohesion is None else round(cohesion, 6),
                "separation": None if separation is None else round(separation, 6),
                "quality_score": None if quality is None else round(quality, 6),
                "quality_status": quality_status,
                "quality_version": QUALITY_VERSION,
                "confidence_version": CONFIDENCE_VERSION,
                "distance_metric": "cosine",
                "representative_texts": representative_texts,
                "representative_samples": representative_samples,
                "metadata_distribution": metadata_distribution,
            }
        )
        if quality is not None:
            cluster_quality_values.append(quality)
            cluster_quality_sizes.append(original_size)

        for index in members:
            state = states[index]
            status = state.status
            confidence = None
            if status in {STATUS_CORE, STATUS_BORDERLINE, STATUS_SMALL_COHERENT}:
                s1 = float(similarity[index])
                support = float(np.clip((s1 - cluster_low) / (cluster_high - cluster_low), 0.0, 1.0))
                confidence = member_confidence(
                    s1=s1,
                    margin=float(margin[index]) if len(live) > 1 else None,
                    core_support=support,
                    t_sem=calibration["t_sem"],
                    t_margin=calibration["t_margin"],
                    weights=calibration["confidence_weights"],
                    single_cluster=len(live) <= 1,
                )
            item_states[index] = {
                "status": status,
                "cluster": int(state.cluster),
                "confidence": confidence,
                "distance": None if status == STATUS_NOISE else round(float(1.0 - similarity[index]), 6),
                "noise_reason": state.noise_reason,
            }

    names = dedupe_names(raw_names, live)
    for cluster, name in zip(clusters, names):
        cluster["label"] = name
        cluster["cluster_name"] = name

    # 展开回全部原始 ID：每个 ID 恰好出现一次
    items: list[dict] = []
    invalid_by_index = {entry.index: entry for entry in corpus.invalid}
    for occurrence_index in range(total):
        if occurrence_index in invalid_by_index:
            entry = invalid_by_index[occurrence_index]
            items.append(
                {
                    "id": entry.sample_id,
                    "text": entry.text,
                    "cluster_id": -1,
                    "cluster_label": "无效文本",
                    "confidence": None,
                    "distance": None,
                    "keywords": [],
                    "metadata": {},
                    "assignment_status": STATUS_INVALID,
                    "noise_reason": entry.reason,
                    "confidence_version": CONFIDENCE_VERSION,
                    "distance_metric": "cosine",
                }
            )
            continue
        unique_index = index_to_unique[occurrence_index]
        entry = corpus.unique[unique_index]
        occurrence = occurrence_by_index[occurrence_index]
        state = item_states.get(unique_index, {"status": STATUS_NOISE, "cluster": -1, "confidence": None, "distance": None, "noise_reason": "unclustered"})
        cluster_id = int(labels[unique_index])
        cluster_label = next((item["label"] for item in clusters if item["cluster_id"] == cluster_id), "未归类文本")
        if state["status"] == STATUS_NOISE:
            cluster_id = -1
            cluster_label = "未归类文本"
        items.append(
            {
                # 每条原始输入用自己的 ID：重复文本的每一份都必须是独立可回溯的记录
                "id": getattr(occurrence, "sample_id", f"row-{occurrence_index + 1}"),
                "text": entry.text,
                "cluster_id": cluster_id,
                "cluster_label": cluster_label,
                "confidence": None if state["confidence"] is None else round(float(state["confidence"]), 4),
                "distance": state["distance"],
                "keywords": [],
                "metadata": dict(getattr(occurrence, "metadata", {}) or {}),
                "assignment_status": state["status"],
                "noise_reason": state["noise_reason"],
                "confidence_version": CONFIDENCE_VERSION,
                "distance_metric": "cosine",
            }
        )

    noise_members = [index for index in range(total_unique) if int(labels[index]) < 0]
    noise_size = sum(frequencies[index] for index in noise_members)
    invalid_size = corpus.invalid_count

    # 噪声使用统一展示桶"未归类文本"：它**不是一个语义簇**——
    # 没有质心、没有语义代表、quality 与 confidence 均为 null。
    # 这里只额外给最多 3 条示例，且与代表文本严格区分。
    noise_examples = [
        {"id": corpus.unique[index].primary_id, "text": texts[index], "reason": item_states.get(index, {}).get("noise_reason")}
        for index in noise_members[:3]
    ]
    if noise_size or invalid_size:
        clusters.append(
            {
                "cluster_id": -1,
                "label": "未归类文本",
                "cluster_name": "未归类文本",
                "name_source": "system_bucket",
                "name_evidence": None,
                "naming_version": NAMING_VERSION,
                "size": int(noise_size + invalid_size),
                "unique_size": int(len(noise_members)),
                "percentage": round(100.0 * (noise_size + invalid_size) / max(1, total), 4),
                "keywords": [],
                "cohesion": None,
                "separation": None,
                "quality_score": None,
                "quality_status": "not_applicable",
                "quality_version": QUALITY_VERSION,
                "confidence_version": CONFIDENCE_VERSION,
                "distance_metric": "cosine",
                "representative_texts": [],
                "representative_samples": [],
                "metadata_distribution": {},
                "noise_examples": noise_examples,
                "is_noise_bucket": True,
            }
        )

    macro = float(np.mean(cluster_quality_values)) if cluster_quality_values else None
    weighted = (
        float(np.average(cluster_quality_values, weights=cluster_quality_sizes)) if cluster_quality_values else None
    )
    aggregate = {
        "unique_count": total_unique,
        "duplicate_count": corpus.duplicate_count,
        "invalid_count": invalid_size,
        "noise_size": int(noise_size),
        "noise_ratio": round(noise_size / max(1, total), 6),
        "coverage": round(1.0 - (noise_size / max(1, total)), 6),
        "macro_quality": None if macro is None else round(macro, 6),
        "weighted_quality": None if weighted is None else round(weighted, 6),
        "overall_quality": None if macro is None else round(macro * (1.0 - (noise_size / max(1, total))), 6),
        "quality_version": QUALITY_VERSION,
        "confidence_version": CONFIDENCE_VERSION,
        "tokenizer_version": TOKENIZER_VERSION,
        "stopword_version": STOPWORD_VERSION,
        "naming_version": NAMING_VERSION,
        "selected_k": selected_k,
        "final_k": len(live),
        "total_samples": total,
        "warnings": warnings,
    }
    return {"clusters": clusters, "items": items, "aggregate": aggregate}


def _cluster_separation(space, centers, labels, cluster, core) -> float | None:
    """簇与"最强竞争簇"之间的分离支持（核心成员上的宏平均）。"""

    if centers is None or centers.shape[0] < 2 or not core:
        return None
    from ..features.semantic import cosine_to_centers

    similarity = cosine_to_centers(space.sem[np.asarray(core)], centers)
    own = similarity[:, cluster]
    others = np.delete(similarity, cluster, axis=1)
    if others.size == 0:
        return None
    best_other = others.max(axis=1)
    a = np.maximum(1.0 - own, 0.0)
    b = np.maximum(1.0 - best_other, 0.0)
    proxy = (b - a) / np.maximum(np.maximum(a, b), 1e-6)
    return float(np.clip(proxy, -1.0, 1.0).mean())


__all__ = [
    "CONFIDENCE_VERSION",
    "NAMING_VERSION",
    "QUALITY_VERSION",
    "STOPWORDS",
    "TOKENIZER_VERSION",
    "build_semantic_digest",
    "char_ngrams",
    "class_tfidf",
    "cluster_quality",
    "cluster_terms",
    "dedupe_names",
    "document_terms",
    "member_confidence",
    "name_cluster",
    "name_from_text",
    "negation_polarity",
    "pick_representatives",
    "tokenize",
]
