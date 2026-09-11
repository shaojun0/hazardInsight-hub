"""簇摘要（展示辅助）。

**定位说明**：本模块不参与聚类决策。簇划分、噪声判定完全由 cluster-engine
的算法产出；这里只做三件"让结果可读"的事：

1. 用「与簇质心的余弦相似度」给每条样本排序，挑出代表样本；
2. 用 c-TF-IDF（类内词频 / 全语料词频）抽取簇关键词与单条样本关键词；
3. 统计每个簇的元数据分布（例如隐患级别、隐患分类的构成）。

第 2 步优先使用 jieba 分词（中文），未安装时自动退化为字符 n-gram，
两种路径都只是**展示口径**，不会改变任何聚类结果。
"""

from __future__ import annotations

from collections import Counter
from typing import Any

import numpy as np

from app.core.constants import NOISE_CLUSTER_ID
from app.core.errors import ClusteringError
from app.core.logger import get_logger

logger = get_logger(__name__)

#: 关键词抽取需要过滤的高频虚词与套话（不改结果，只影响可读性）。
_STOPWORDS = {
    "的", "了", "在", "是", "和", "与", "及", "或", "等", "对", "为", "从", "以",
    "并", "被", "把", "中", "上", "下", "内", "外", "后", "前", "到", "着", "过",
    "有", "无", "未", "不", "也", "都", "还", "就", "而", "之", "其", "该", "本",
    "进行", "存在", "情况", "问题", "要求", "作业", "现场", "人员", "管理",
    "工作", "设备", "隐患", "行为", "违规", "不符合", "不到位", "不规范",
    "未按", "没有", "发现", "导致", "造成", "部分", "相关", "应当", "必须",
}

#: 元数据分布最多展示的取值个数。
_META_TOP_VALUES = 6


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """按行做 L2 归一化；零向量保持为零向量。"""

    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _jieba_documents(texts: list[str]) -> list[str] | None:
    """用 jieba 分词构造文档；未安装 jieba 时返回 None。"""

    try:
        import jieba
    except ImportError:
        return None
    jieba.setLogLevel("ERROR")
    documents: list[str] = []
    for text in texts:
        words = [
            word
            for word in jieba.cut(text)
            if len(word) > 1 and word.strip() and word not in _STOPWORDS and not word.isdigit()
        ]
        documents.append(" ".join(words))
    return documents


def _term_matrix(texts: list[str]) -> tuple[Any, np.ndarray]:
    """构造 TF-IDF 词项矩阵。

    返回:
        (稀疏矩阵, 特征名数组)。中文优先走 jieba 词级切分，否则退化为
        字符 n-gram（``char_wb``），两者都是标准 TF-IDF。
    """

    from sklearn.feature_extraction.text import TfidfVectorizer

    documents = _jieba_documents(texts)
    try:
        if documents is not None:
            vectorizer = TfidfVectorizer(token_pattern=r"(?u)\S+", min_df=1, sublinear_tf=True)
            matrix = vectorizer.fit_transform(documents)
        else:
            vectorizer = TfidfVectorizer(
                analyzer="char_wb", ngram_range=(2, 4), min_df=1, sublinear_tf=True
            )
            matrix = vectorizer.fit_transform(texts)
    except ValueError as exc:
        # 语料全为空白/无效字符时 sklearn 会拒绝拟合。关键词属展示辅助，
        # 不应因此让整个聚类请求失败，因此降级为空矩阵。
        logger.warning("关键词抽取降级（无可用词项）：%s", exc)
        return None, np.array([])
    return matrix, np.asarray(vectorizer.get_feature_names_out())


def _top_terms(scores: np.ndarray, features: np.ndarray, limit: int) -> list[str]:
    """取分数最高的若干词项。"""

    if features.size == 0 or limit <= 0:
        return []
    order = np.argsort(scores)[::-1][:limit]
    return [str(features[index]) for index in order if scores[index] > 0]


def _value_counts(values: list[str], limit: int = _META_TOP_VALUES) -> list[dict[str, Any]]:
    """统计取值频次并返回前若干项。"""

    counter = Counter(value for value in values if value)
    return [
        {"value": value, "count": count}
        for value, count in counter.most_common(limit)
    ]


def build_digest(
    *,
    sample_ids: list[str],
    texts: list[str],
    labels: np.ndarray,
    vectors: np.ndarray,
    metadata: list[dict[str, Any]],
    top_keywords: int,
    representatives: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """生成簇摘要与逐条样本描述。

    参数:
        sample_ids: 样本 ID，顺序与 ``texts``/``labels`` 一致。
        texts: 原始文本。
        labels: cluster-engine 给出的簇标签，"−1" 为噪声。
        vectors: 送入聚类算法的特征矩阵（用于计算质心与相似度）。
        metadata: 每条样本的元数据（例如隐患级别、隐患分类）。
        top_keywords: 每个簇展示的关键词个数。
        representatives: 每个簇返回的代表样本个数。

    返回:
        ``(簇列表, 样本列表)``，均为可直接序列化为 API 响应的字典。
    """

    if len(sample_ids) != len(labels) or vectors.shape[0] != len(sample_ids):
        raise ClusteringError("样本数与标签/特征矩阵不一致，无法生成结果摘要。")

    normalized = _l2_normalize(np.asarray(vectors, dtype=np.float64))
    term_matrix, features = _term_matrix(texts)

    # 逐条样本关键词：取本条 TF-IDF 向量中权重最高的词项（即"最能代表这条文本的词"）。
    item_keywords: list[list[str]] = [[] for _ in texts]
    if term_matrix is not None:
        for index in range(len(texts)):
            row = np.asarray(term_matrix[index].todense()).ravel()
            item_keywords[index] = _top_terms(row, features, top_keywords)

    cluster_ids = sorted({int(label) for label in labels})
    clusters: list[dict[str, Any]] = []
    item_labels: dict[int, str] = {}

    for cluster_id in cluster_ids:
        member_indices = [i for i, label in enumerate(labels) if int(label) == cluster_id]
        if cluster_id == NOISE_CLUSTER_ID:
            label = "未归簇（噪声）"
        else:
            label = f"类别 {cluster_id}"
        for index in member_indices:
            item_labels[index] = label

        members = normalized[member_indices]
        centroid = members.mean(axis=0) if len(members) else np.zeros(normalized.shape[1])
        centroid_norm = np.linalg.norm(centroid)
        safe_centroid = centroid / centroid_norm if centroid_norm > 0 else centroid
        similarities = members @ safe_centroid if len(members) else np.array([])
        distances = np.linalg.norm(members - centroid, axis=1) if len(members) else np.array([])

        # 代表样本：与质心最接近的若干条
        order = np.argsort(similarities)[::-1][: max(1, representatives)]
        representative_samples = [
            {
                "id": sample_ids[member_indices[position]],
                "text": texts[member_indices[position]],
                "confidence": round(float((similarities[position] + 1) / 2), 4),
                "distance": round(float(distances[position]), 4),
            }
            for position in order
        ]

        # 簇关键词：把簇内成员的词项向量取均值，再取权重最高的词项（c-TF-IDF 思路）
        keywords: list[str] = []
        if term_matrix is not None and member_indices:
            mean_scores = np.asarray(term_matrix[member_indices].mean(axis=0)).ravel()
            keywords = _top_terms(mean_scores, features, top_keywords)

        # 元数据分布：把关键业务字段在每个簇内的构成展示出来
        metadata_distribution: dict[str, list[dict[str, Any]]] = {}
        if metadata:
            keys = [key for key in metadata[0] if key]
            for key in keys:
                values = [str(metadata[i].get(key, "")) for i in member_indices]
                counts = _value_counts(values)
                if counts:
                    metadata_distribution[key] = counts

        clusters.append(
            {
                "cluster_id": cluster_id,
                "label": label,
                "size": len(member_indices),
                "keywords": keywords,
                "cohesion": round(float(similarities.mean()), 4) if len(similarities) else None,
                "representative_samples": representative_samples,
                "metadata_distribution": metadata_distribution,
                "similarities": similarities,
                "distances": distances,
            }
        )

    # 用簇级别的相似度把"置信度"归一到 0~1，方便前端做视觉区分
    all_confidences = np.concatenate(
        [(cluster["similarities"] + 1) / 2 for cluster in clusters if len(cluster["similarities"])]
    ) if clusters else np.array([0.0, 1.0])
    lowest = float(all_confidences.min()) if all_confidences.size else 0.0
    highest = float(all_confidences.max()) if all_confidences.size else 1.0
    span = highest - lowest or 1.0

    items: list[dict[str, Any]] = []
    for cluster in clusters:
        cluster_id = cluster["cluster_id"]
        member_indices = [i for i, label in enumerate(labels) if int(label) == cluster_id]
        for position, index in enumerate(member_indices):
            raw_confidence = float((cluster["similarities"][position] + 1) / 2)
            items.append(
                {
                    "id": sample_ids[index],
                    "text": texts[index],
                    "cluster_id": cluster_id,
                    "cluster_label": cluster["label"],
                    "confidence": round((raw_confidence - lowest) / span, 4),
                    "distance": round(float(cluster["distances"][position]), 4),
                    "keywords": item_keywords[index],
                    "metadata": metadata[index] if metadata else {},
                }
            )
    # 结果按簇、再按置信度降序排列，前端表格默认顺序即可读
    items.sort(key=lambda item: (item["cluster_id"] == NOISE_CLUSTER_ID, item["cluster_id"], -item["confidence"]))
    for cluster in clusters:
        cluster.pop("similarities", None)
        cluster.pop("distances", None)
    return clusters, items
