"""边界与契约测试：特征端点、评分退化情形、只读脚本的导入安全性。

这里的用例大多在守护"不该发生的事"，而非验证正常路径。
"""

import subprocess
import sys
import numpy as np
import pytest
from retrain_cluster.evaluation.metrics import QbEvaluator
from retrain_cluster.features.pipeline import FeaturePipeline
from retrain_cluster.types import FeatureSpec
from retrain_cluster.optimization.runner import optimize
from tests.conftest import ExactNeighbors, ROOT


def test_feature_endpoints_and_batch_sizes(arrays):
    """beta 的两个端点必须精确退化，且不受检索分批大小影响。

    beta=0 应完全等于近邻均值；beta=1 应完全等于原始向量（逐位相等，非近似）。
    分别在 batch=1/13/64 下验证，可捕获"分批处理导致数值路径不同"的问题。
    """
    X, _, db = arrays
    query = ExactNeighbors(db)
    for k in [1, 7]:
        means = np.array([row.mean(axis=0) for row in query.query(X, k).values])
        for batch in [1, 13, 64]:
            for beta, expected in [(0.0, means), (1.0, X)]:
                actual = FeaturePipeline(query, batch).transform(X, FeatureSpec(beta=beta, n_results=k))
                np.testing.assert_array_equal(actual, expected)


def test_scoring_noise_and_single_cluster():
    """退化情形：全噪声或单簇时评分必须是哨兵值 -1，且不产出成对指标。"""
    evaluator = QbEvaluator()
    for labels in [[-1] * 4, [0] * 4]:
        result = evaluator([0, 0, 1, 1], labels)
        assert result["score"] == -1 and "ari" not in result
    # 完美预测时总分应为 1.0（各分项权重之和为 1）
    result = evaluator([0, 0, 1, 1], [0, 0, 1, 1])
    assert result["score"] == pytest.approx(1.0)
    # 噪声不参与成对指标计算，故 ARI 仍为 1.0，但噪声比例被单独统计
    result = evaluator([0, 0, 1, 1], [0, -1, 1, 1])
    assert result["noise_ratio"] == 0.25
    assert result["ari"] == 1.0


def test_resolved_fixed_parameters_saved(arrays):
    """固定传入的 n_results/pca_dim 应出现在 resolved_params，而不进入采样参数。"""
    X, y, db = arrays
    study = optimize("agglomerative", X, y, ExactNeighbors(db), n_results=3, pca_dim=0, n_trials=2, n_jobs=1)
    resolved = study.best_trial.user_attrs["resolved_params"]
    assert resolved["n_results"] == 3 and resolved["pca_dim"] == 0
    assert "n_results" not in study.best_params


def test_imports_do_not_read_business_inputs_or_connect():
    """入口脚本与包模块必须"导入安全"。

    脚本按**路径**加载而非模块名，这样即使脚本搬家本测试依然有效。
    直接执行仍会运行 main()；这里只断言导入是安全的。
    严格的边界是：导入期间不得触碰三个输入文件、不得写产物目录、不得开套接字。
    """
    code = r"""
import builtins, importlib, importlib.util, pathlib, socket, os, sys
sys.path.insert(0, os.path.join(os.getcwd(), 'src'))
original = builtins.open
original_path = pathlib.Path.open

def guard(file, *args, **kwargs):
    normalized = str(file).replace('\\','/').lower()
    assert not any(x in normalized for x in ['reference.json','labels.json','database.txt','/output/','/artifacts/']), normalized
    return original(file, *args, **kwargs)
def path_guard(self, *args, **kwargs):
    return guard(self, *args, **kwargs)
def no_connect(*args, **kwargs):
    raise AssertionError('network access on import')
builtins.open = guard
pathlib.Path.open = path_guard
socket.socket.connect = no_connect

SCRIPTS = ["scripts/analysis/summarize_runs.py", "scripts/analysis/export_predictions.py"]
PACKAGE = ['retrain_cluster', 'retrain_cluster.cli',
           'retrain_cluster.services.clustering', 'retrain_cluster.api.app']

for relative in SCRIPTS:
    spec = importlib.util.spec_from_file_location('probe_' + relative.replace('/', '_'), relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
for name in PACKAGE:
    importlib.import_module(name)
print('safe imports')
"""
    # 用子进程是为了让上述 monkeypatch 不污染当前测试进程
    completed = subprocess.run([sys.executable, "-c", code], cwd=ROOT, text=True, capture_output=True)
    assert completed.returncode == 0, completed.stderr
