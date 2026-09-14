"""全局常量。

网关只做「协议转换 + 展示加工」，算法与向量化口径全部由 cluster-engine
（`retrain_cluster`）决定，因此这里只保留与 HTTP 契约、展示层相关的常量。
"""

from __future__ import annotations

#: 噪声点簇 ID（密度类算法把未归簇样本标为 -1）。
NOISE_CLUSTER_ID = -1

#: 单次请求允许的最大样本数。
#: 上限放到 30 万条（全量数据级），与 cluster-engine 的 `app.toml:max_samples` 对齐。
#: 注意：放开个数限制不等于所有算法都能吃下这个量级 —— 层次聚类
#: （agglomerative / affinity_propagation）是 O(n²) 时空复杂度，30 万条会 OOM；
#: 实际能跑满量级的是 dbscan / hdbscan / birch / leader / canopy 等线性或近线性算法。
MAX_ITEMS = 300_000

#: 参与聚类所需的最小样本数（legacy-v1 口径）。
MIN_ITEMS = 2

#: semantic-v1 允许单条：单条唯一文本会返回 autoKStatus=singleton 并如实标注低支持，
#: 而不是伪装成一次正常的聚类。因此它的下限是 1。
MIN_SEMANTIC_ITEMS = 1

#: 单条文本最大字符数。与 cluster-engine 的 `Item.text` 上限（4000）对齐。
MAX_TEXT_CHARS = 4000

#: 上传文件允许的后缀。
SUPPORTED_UPLOAD_EXTENSIONS = {".csv", ".json", ".xlsx", ".txt"}

# ------------------------------------------------------------------ 异步作业

#: 作业状态。`queued → running → succeeded | failed | cancelled`，终态不可再变。
#:
#: 「取消」是独立状态而不是 failed 的一种：失败要人查原因，取消是调用方的意图，
#: 混在一起会让"是不是我点了取消"变成靠错误信息猜的判断题。
JOB_QUEUED = "queued"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_CANCELLED = "cancelled"

#: 终态集合。作业一旦进入终态，状态与结果都不再变化。
JOB_TERMINAL_STATUSES = frozenset({JOB_SUCCEEDED, JOB_FAILED, JOB_CANCELLED})

#: 活跃集合。容量上限按这个集合计数。
JOB_ACTIVE_STATUSES = frozenset({JOB_QUEUED, JOB_RUNNING})

#: 明细分页的默认页大小，以及单页硬上限。
#:
#: 上限的存在是为了守住"前端无需下载全部明细"这条约束：调用方不能靠调大 limit
#: 把一次分页变成全量导出。需要全量时应当显式走导出接口。
DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500

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
