"""Legacy-v1 超参搜索空间：从历史实验原样抽取，**分布与采样顺序均未改动**。

为什么强调"未改动"：Optuna 的 TPE 采样器对"第几个被采样的参数"敏感，若调整
``suggest_*`` 的调用顺序或上下界，即使算法没变，搜索轨迹也会完全不同，
导致论文中的调参结果无法复现。

三个特殊约定：
  * ``n_results`` / ``pca_dim`` 传入负值（-1）时表示"交给搜索决定"；
  * 当 ``n_results == 0``（不启用检索）时，``beta`` 无意义，固定为 1.0 而不采样；
  * ``pca_dim`` 非负时表示固定该维度，此时也不会采样。
"""

from types import SimpleNamespace


def agglomerative(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    distance_threshold = trial.suggest_float("distance_threshold", 0.1, 4)
    beta = trial.suggest_float("beta", 0.0, 1.0) if self.n_results != 0 else 1.0
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    return {"distance_threshold": distance_threshold, "beta": beta, "pca_dim": pca_dim, "n_results": n_results}


def hdbscan(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    min_cluster_size = trial.suggest_int("min_cluster_size", 2, 20)
    cluster_selection_epsilon = trial.suggest_float("cluster_selection_epsilon", 0.0, 2.0)
    alpha = trial.suggest_float("alpha", 0.1, 1.0)
    beta = trial.suggest_float("beta", 0.0, 1.0) if self.n_results != 0 else 1.0
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "min_cluster_size": min_cluster_size,
        "cluster_selection_epsilon": cluster_selection_epsilon,
        "alpha": alpha,
        "beta": beta,
        "n_results": n_results,
        "pca_dim": pca_dim,
    }


def radbscan(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    eps = trial.suggest_float("eps", 0.1, 5.0)
    min_pts = trial.suggest_int("min_pts", 2, 20)
    beta = trial.suggest_float("beta", 0.0, 1.0) if self.n_results != 0 else 1.0
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "eps": eps,
        "min_pts": min_pts,
        "beta": beta,
        "n_results": n_results,
        "pca_dim": pca_dim,
    }


def optics(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    min_samples = trial.suggest_int("min_samples", 2, 20)
    xi = trial.suggest_float("xi", 0.001, 0.2)
    # 注意：OPTICS 的 min_cluster_size 是浮点比例，与其它算法的整数含义不同
    min_cluster_size = trial.suggest_float("min_cluster_size", 0.001, 0.2)
    beta = trial.suggest_float("beta", 0.0, 1.0) if self.n_results != 0 else 1.0
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    return {
        "min_samples": min_samples,
        "xi": xi,
        "min_cluster_size": min_cluster_size,
        "beta": beta,
        "pca_dim": pca_dim,
        "n_results": n_results,
    }


def affinity_propagation(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "damping": trial.suggest_float("damping", 0.5, 0.99),
        "preference": trial.suggest_float("preference", -100.0, 0.0),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),  # AP 恒启用检索，beta 始终采样
        "n_results": n_results,
    }


def dbscan(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "eps": trial.suggest_float("eps", 0.1, 5.0),
        "min_samples": trial.suggest_int("min_samples", 2, 20),
        "leaf_size": trial.suggest_int("leaf_size", 10, 100),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),
        "n_results": n_results,
    }


def chinese_whispers(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "n_neighbors": trial.suggest_int("n_neighbors", 5, 50),
        "weighting": trial.suggest_categorical("weighting", ["top", "lin"]),
        "iterations": trial.suggest_int("iterations", 10, 50),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),
        "n_results": n_results,
    }


def birch(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    threshold = trial.suggest_float("threshold", 0.1, 1)

    branching_factor = trial.suggest_int("branching_factor", 20, 200)
    beta = trial.suggest_float("beta", 0.0, 1.0) if self.n_results != 0 else 1.0
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    return {
        "threshold": threshold,
        "branching_factor": branching_factor,
        "beta": beta,
        "pca_dim": pca_dim,
        "n_results": n_results,
    }


def leader(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "threshold": trial.suggest_float("threshold", 0.1, 5.0),
        "metric": trial.suggest_categorical("metric", ["euclidean", "cosine", "manhattan", "l2"]),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),
        "n_results": n_results,
    }


def canopy(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    t2 = trial.suggest_float("t2", 0.1, 4.0)
    # 约束 t1 > t2：把 t1 的下界设为 t2 + 0.01，采样空间随 t2 动态收缩
    t1 = trial.suggest_float("t1", t2 + 0.01, 5.0)
    return {
        "t1": t1,
        "t2": t2,
        "metric": trial.suggest_categorical("metric", ["euclidean", "cosine", "manhattan", "l2"]),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),
        "n_results": n_results,
    }


def mean_shift(trial, *, n_results=-1, pca_dim=0):
    self = SimpleNamespace(n_results=n_results, pca_dim=pca_dim)
    n_results = trial.suggest_int("n_results", 1, 7) if self.n_results < 0 else self.n_results
    pca_dim = (
        trial.suggest_categorical("pca_dim", [16, 32, 64, 128, 256, 512, 768]) if self.pca_dim < 0 else self.pca_dim
    )
    return {
        "bandwidth": trial.suggest_float("bandwidth", 0.1, 5.0),
        "cluster_all": trial.suggest_categorical("cluster_all", [True, False]),
        "max_iter": trial.suggest_int("max_iter", 100, 500),
        "pca_dim": pca_dim,
        "beta": trial.suggest_float("beta", 0.0, 1.0),
        "n_results": n_results,
    }


# 算法名 -> 搜索空间函数；与 clustering.registry.ALGORITHMS 的键保持一致
SPACES = {
    "agglomerative": agglomerative,
    "hdbscan": hdbscan,
    "radbscan": radbscan,
    "optics": optics,
    "affinity_propagation": affinity_propagation,
    "dbscan": dbscan,
    "chinese_whispers": chinese_whispers,
    "birch": birch,
    "leader": leader,
    "canopy": canopy,
    "mean_shift": mean_shift,
}
