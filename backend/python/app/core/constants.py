"""全局常量。

网关只做「协议转换 + 展示加工」，算法与向量化口径全部由 cluster-engine
（`retrain_cluster`）决定，因此这里只保留与 HTTP 契约、展示层相关的常量。
"""

from __future__ import annotations

#: 噪声点簇 ID（密度类算法把未归簇样本标为 -1）。
NOISE_CLUSTER_ID = -1

#: 单次请求允许的最大样本数。与 cluster-engine 的 API 上限（500）对齐。
MAX_ITEMS = 500

#: 参与聚类所需的最小样本数。
MIN_ITEMS = 2

#: 单条文本最大字符数。与 cluster-engine 的 `Item.text` 上限（4000）对齐。
MAX_TEXT_CHARS = 4000

#: 上传文件允许的后缀。
SUPPORTED_UPLOAD_EXTENSIONS = {".csv", ".json", ".xlsx", ".txt"}

#: 自动挑选 profile 时的算法优先顺序（先纯向量，再检索增强类）。
AUTO_PROFILE_ALGORITHM_PREFERENCE = (
    "agglomerative",
    "birch",
    "leader",
    "canopy",
    "dbscan",
    "hdbscan",
    "optics",
    "affinity_propagation",
    "radbscan",
    "chinese_whispers",
)
