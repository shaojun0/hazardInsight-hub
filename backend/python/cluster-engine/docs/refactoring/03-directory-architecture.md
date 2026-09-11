# 目录架构与迁移映射

## 目标目录（本次实现）

```text
retrain-cluster-main/
├── configs/ (app.toml, models.toml, profiles/*.json)
├── src/retrain_cluster/
│   __init__.py
│   __main__.py
│   api/__init__.py
│   api/app.py
│   api/execution.py
│   api/routes.py
│   api/schemas.py
│   artifacts/__init__.py
│   artifacts/cache.py
│   artifacts/fingerprints.py
│   artifacts/runs.py
│   cli.py
│   clustering/__init__.py
│   clustering/affinity_propagation.py
│   clustering/canopy.py
│   clustering/chinese_whispers.py
│   clustering/dbscan.py
│   clustering/hdbscan.py
│   clustering/leader.py
│   clustering/mean_shift.py
│   clustering/radbscan.py
│   clustering/registry.py
│   clustering/sklearn_algorithms.py
│   config.py
│   data/__init__.py
│   data/loaders.py
│   data/validation.py
│   embeddings/__init__.py
│   embeddings/base.py
│   embeddings/openai_compatible.py
│   embeddings/registry.py
│   embeddings/sccl.py
│   embeddings/sentence_transformer.py
│   embeddings/simcse.py
│   errors.py
│   evaluation/__init__.py
│   evaluation/metrics.py
│   features/__init__.py
│   features/fusion.py
│   features/pipeline.py
│   features/reduction.py
│   logging.py
│   optimization/__init__.py
│   optimization/runner.py
│   optimization/search_spaces.py
│   retrieval/__init__.py
│   retrieval/base.py
│   retrieval/build.py
│   retrieval/chroma.py
│   services/__init__.py
│   services/clustering.py
│   services/experiments.py
│   types.py
├── tests/ (unit, regression, integration, api, fixtures)
├── scripts/analysis/
├── data/ (原始输入，未修改)
├── models/ (本地权重，可设置为仓库外路径)
├── artifacts/ (embeddings, knowledge_bases, runs)
├── legacy/ (脱敏入口快照)
├── optimizer/, evaluator/ (旧实现回归对照)
├── output/, output_bge_large/ (历史结果，未修改)
└── docs/refactoring/
```

> **收口后状态**：上图中 `legacy/`、`optimizer/`、`evaluator/`、`output/`、`output_bge_large/`
> 以及根目录旧入口已从工作区删除，仅保留在 Git 历史；`data/` 改为用户自备输入并不再跟踪
> （见 `.gitignore`）。重构前指纹仍见 `baseline-manifest.json`。行为回归改由
> `tests/regression/test_golden_labels.py` 的标签摘要守护。

## 模块职责

| 旧入口/职责 | 新模块 | 依赖约束 |
|---|---|---|
| 根目录数据读取 | data/loaders.py、validation.py | 只依赖 types、numpy、文件指纹 |
| main / utils.cache 的 API 编码 | embeddings/openai_compatible.py | 只负责服务调用和行序验证 |
| bak 的本地模型包装器 | embeddings/{sentence_transformer,simcse,sccl}.py | 运行时按需导入重依赖 |
| 各 optimizer 的 collection.query | retrieval/chroma.py | 不知道标签、评分或算法 |
| 重复 np.mean / β 融合 / PCA | features/ | 不依赖 Optuna，不读取文件 |
| 完整 optimizer 的 _cluster | clustering/ | 只接收矩阵与参数；函数签名明确 |
| 各 estimate | optimization/search_spaces.py | 保留旧建议顺序；不加载数据模型 |
| train 和 trial 记录 | optimization/runner.py、services/experiments.py | 显式配置和完整参数导出 |
| QbEvaluator | evaluation/metrics.py | 指标逻辑原样保留 |
| 分散的缓存和结果 JSON | artifacts/ | 原子写入、校验和、版本清单 |
| 业务编排 | services/clustering.py | API 与 CLI 共用 |
| HTTP 与进程限制 | api/ | FastAPI、spawn、同步返回 |

DBSCAN/AP/MeanShift 各有很短的独立内核文件，便于与旧 _cluster 对照；Agglomerative/Birch/OPTICS 的薄 sklearn 调用合并在 sklearn_algorithms.py。未为了目录对称再加通用基类。

## 兼容入口

重构过渡期：根目录与 bak 的可执行脚本曾包在 main() 中，import 不触发文件访问或实验；完整历史优化器留在原位置供逐位回归使用。收口后这些文件（含 `svd_analysis.py` 等旧研究脚本）与历史结果目录一并删除，需要对照时从 Git 历史取出。旧研究脚本的已知缺陷不承诺修复；新分析脚本只消费新运行产物。

## 文件管理

models/、artifacts/ 的大文件不入 Git。configs、源代码、测试小样本、文档和历史已跟踪结果入 Git。运行清单中没有原文或凭证值；样本 ID 和输入内容哈希用于追溯。

安装包不把业务数据或模型打入 wheel；运行时显式传 `--config`，所有配置内相对路径以对应配置文件所在目录解析。离开仓库执行时请传配置绝对路径。
