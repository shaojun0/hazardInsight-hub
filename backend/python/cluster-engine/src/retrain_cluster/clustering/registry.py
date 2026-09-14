"""算法注册表：算法名 -> 实现函数 的映射，以及统一参数校验。

所有算法函数都遵循同一签名约定：``fit_predict(X, **params) -> labels``，
其中 label 为整数数组，``-1`` 表示噪声。注册表额外记录每个算法依赖的可选包，
用于"环境没装依赖时优雅降级"而不是导入即崩。
"""

from importlib import import_module, util
import inspect
import math
from ..errors import ClusterError

# 算法名 -> (模块名, 函数名, 需要探测的可选依赖包)
ALGORITHMS = {
    "agglomerative": ("sklearn_algorithms", "agglomerative", "sklearn"),
    "hdbscan": ("hdbscan", "fit_predict", "hdbscan"),
    "radbscan": ("radbscan", "fit_predict", "sklearn"),
    "optics": ("sklearn_algorithms", "optics", "sklearn"),
    "affinity_propagation": ("affinity_propagation", "fit_predict", "sklearn"),
    "dbscan": ("dbscan", "fit_predict", "sklearn"),
    "chinese_whispers": ("chinese_whispers", "fit_predict", "chinese_whispers"),
    "birch": ("sklearn_algorithms", "birch", "sklearn"),
    "leader": ("leader", "fit_predict", "sklearn"),
    "canopy": ("canopy", "fit_predict", "sklearn"),
    "mean_shift": ("mean_shift", "fit_predict", "sklearn"),
    # semantic-v1：中文语义 Embedding + 有界 Auto-K + MiniBatchKMeans + 原空间后处理。
    # 它同样满足 fit_predict(X, **params) -> labels 的矩阵契约，但线上入口走
    # SemanticAutoKMeansStrategy（文本级去重/缓存/命名不在矩阵函数里）。
    "semantic_auto_kmeans": ("semantic_auto", "fit_predict", "sklearn"),
}
# mean_shift 只在 CLI 暴露、不走 API（见 docs/architecture.md 的口径说明）
API_ALGORITHMS = tuple(name for name in ALGORITHMS if name != "mean_shift")
# 需要实现版本 semantic-v1 才能使用的算法集合
SEMANTIC_ALGORITHMS = tuple(name for name in ALGORITHMS if name.startswith("semantic_"))
# 需要随结果一并返回给调用方的行为告警
WARNINGS = {
    "chinese_whispers": ["LEGACY_CW_LABEL_MAPPING", "UNSEEDED_LEGACY_ALGORITHM"],
    "semantic_auto_kmeans": [
        "AUTO_K_NO_UNIQUE_TRUTH",
        "AUTO_K_SAMPLING_MAY_MISS_RARE_TOPICS",
    ],
}

#: semantic-v1 的预算类参数白名单：``参数名 -> (下界, 上界)``，全部为整数。
SEMANTIC_INTEGER_RULES = {
    "k_cap": (2, 4096),
    "sample_size": (16, 200_000),
    "validation_size": (1, 200_000),
    "max_iter": (1, 10_000),
    "batch_size": (1, 100_000),
    "n_init": (1, 50),
    "pca_dim": (0, 4096),
    "pca_min_samples": (2, 1_000_000),
    "min_cluster_unique": (1, 1000),
    "split_budget": (0, 64),
    "merge_rounds": (0, 8),
    "refine_rounds": (0, 8),
    "seed": (0, 2**31),
}

#: semantic-v1 的浮点预算参数白名单（阈值类参数**不在此列**，见下方说明）。
SEMANTIC_FLOAT_RULES = {
    "sample_weight_cap": (0.0, 100.0),
}

#: 阈值类参数的键名。它们必须来自 ``semantic-calibration-v1.json``，
#: 不允许写在 profile 的 algorithm_params 里——否则"同一份校准"会随 profile 漂移。
SEMANTIC_CALIBRATION_KEYS = frozenset({"t_sem", "t_pair", "t_merge", "t_margin", "t_single"})


def available(algorithm):
    """探测算法在当前环境是否可用（依赖包是否已安装）。

    用 ``find_spec`` 只查"包是否存在"，不真正导入，因此探测本身很轻量。
    chinese_whispers 额外需要 networkx 来构图。
    """
    item = ALGORITHMS.get(algorithm)
    return bool(
        item
        and util.find_spec(item[2])
        and util.find_spec("sklearn")
        and (algorithm != "chinese_whispers" or util.find_spec("networkx"))
    )


def get_clusterer(algorithm, backend="python"):
    """按算法名取回实现函数；不可用时抛出明确的领域错误。"""
    if backend != "python":
        raise ClusterError("BACKEND_UNAVAILABLE", "Only the frozen Python backend is provided", 503)
    if not available(algorithm):
        raise ClusterError("ALGORITHM_UNAVAILABLE", "Algorithm dependencies are not installed", 503)
    module, function, _ = ALGORITHMS[algorithm]
    return getattr(import_module(f"{__package__}.{module}"), function)


def validate_semantic_params(algorithm, params):
    """semantic-v1 的专属参数校验。

    与 legacy 分支的最大区别是**分区明确**：这里只接受预算类参数，
    任何阈值参数都会被明确拒绝并提示"阈值属于校准配置"。这样
    "同一份校准"就不会因为某个 profile 顺手写了个 ``t_sem`` 而悄悄漂移。
    """

    for key, value in params.items():
        if key in SEMANTIC_CALIBRATION_KEYS:
            raise ClusterError(
                "INVALID_PROFILE",
                f"Calibration threshold '{key}' must live in the calibration file, not in profile parameters",
                422,
            )
        if key in SEMANTIC_INTEGER_RULES:
            low, high = SEMANTIC_INTEGER_RULES[key]
            if type(value) is not int or not low <= value <= high:
                raise ClusterError("INVALID_PROFILE", f"Parameter '{key}' violates the semantic budget contract", 422)
            continue
        if key in SEMANTIC_FLOAT_RULES:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ClusterError("INVALID_PROFILE", f"Parameter '{key}' must be a finite number", 422)
            low, high = SEMANTIC_FLOAT_RULES[key]
            if not low <= float(value) <= high:
                raise ClusterError("INVALID_PROFILE", f"Parameter '{key}' is out of range", 422)
            continue
        raise ClusterError(
            "INVALID_PROFILE", f"Parameter '{key}' is not a semantic-v1 budget parameter", 422
        )
    # 跨字段约束：验证集不能比抽样集还大，PCA 目标维度不能超过拟合样本数
    sample_size = params.get("sample_size")
    validation_size = params.get("validation_size")
    if sample_size is not None and validation_size is not None and validation_size > sample_size:
        raise ClusterError("INVALID_PROFILE", "validation_size must not exceed sample_size", 422)
    return algorithm


def validate_params(algorithm, params, backend="python"):
    """在真正执行前校验超参，返回实现函数供调用方复用。

    校验分三层：
      1. 签名匹配——参数名/必填项必须与实现一致（``inspect.signature().bind``）；
      2. 通用取值范围——正数参数必须 > 0，计数参数必须为达标整数；
      3. 算法特有约束——如 AP 的 damping、OPTICS 的 min_cluster_size、Canopy 的 t1 > t2；
         semantic-v1 的算法额外走 ``validate_semantic_params`` 的预算白名单。

    任何一项不满足都统一收敛为 ``INVALID_PROFILE``（422），不泄漏内部异常类型。
    """
    function = get_clusterer(algorithm, backend)
    try:
        # 先试绑定（第一个参数是 X），参数名写错会在这里暴露
        inspect.signature(function).bind(None, **params)
    except TypeError:
        raise ClusterError("INVALID_PROFILE", "Algorithm parameter names are incomplete or invalid", 422) from None
    if algorithm in SEMANTIC_ALGORITHMS:
        validate_semantic_params(algorithm, params)
        return function
    # 必须严格为正数的参数
    positive = {"distance_threshold", "eps", "threshold", "t1", "t2", "bandwidth", "alpha"}
    # 必须是整数且不小于给定下界的参数
    integers = {
        "min_pts": 1,
        "min_samples": 1,
        "min_cluster_size": 2,
        "branching_factor": 2,
        "leaf_size": 1,
        "n_neighbors": 1,
        "iterations": 1,
        "max_iter": 1,
    }
    try:
        for key, value in params.items():
            # 浮点参数不允许 NaN/Inf；bool 不算数值（True 是 int 子类，要排除）
            if isinstance(value, (int, float)) and not isinstance(value, bool) and not math.isfinite(value):
                raise ValueError(key)
            if key in positive and (isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0):
                raise ValueError(key)
            # OPTICS 的 min_cluster_size 允许小数（表示比例），故从整数集合中排除
            if key in integers and not (algorithm == "optics" and key == "min_cluster_size"):
                if type(value) is not int or value < integers[key]:
                    raise ValueError(key)
        # 仿射传播：阻尼系数必须在 [0.5, 1) 才保证收敛
        if "damping" in params and not 0.5 <= params["damping"] < 1:
            raise ValueError("damping")
        # OPTICS：陡度参数必须在 (0, 1)
        if "xi" in params and not 0 < params["xi"] < 1:
            raise ValueError("xi")
        # OPTICS 的 min_cluster_size 既接受 (0,1] 的比例，也接受 >=2 的整数
        if algorithm == "optics" and not (
            0 < params["min_cluster_size"] <= 1
            or type(params["min_cluster_size"]) is int
            and params["min_cluster_size"] >= 2
        ):
            raise ValueError("min_cluster_size")
        if "cluster_selection_epsilon" in params and params["cluster_selection_epsilon"] < 0:
            raise ValueError("cluster_selection_epsilon")
        # Canopy 要求大阈值严格大于小阈值
        if "t1" in params and params["t1"] <= params["t2"]:
            raise ValueError("canopy thresholds")
        if "metric" in params and params["metric"] not in {"euclidean", "cosine", "manhattan", "l2"}:
            raise ValueError("metric")
        if "weighting" in params and params["weighting"] not in {"top", "lin", "linear", "log"}:
            raise ValueError("weighting")
    except (TypeError, ValueError, KeyError):
        raise ClusterError("INVALID_PROFILE", "Algorithm parameters violate the execution contract", 422) from None
    return function
