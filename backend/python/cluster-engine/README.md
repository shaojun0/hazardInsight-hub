# retrain-cluster

面向**核电工程质量偏差短文本**的无监督聚类工程。对巡检/偏差记录做「检索增强嵌入 + 超参搜索 + 聚类」，
用于在标注不足的情况下发现未知问题类别。

> **一个重要澄清**：这里的"训练"指的是 **Optuna 聚类超参数搜索**，**不是**训练 BGE 等嵌入模型。
> 嵌入向量由外部或本地模型产出，模型权重不在本仓库内。

## 目录

- [快速开始](#快速开始)
- [数据准备](#数据准备)
- [启动方式](#启动方式)
- [文档索引](#文档索引)
- [工作原理](#工作原理)
- [配置](#配置)
- [Python API](#python-api)
- [指标口径](#指标口径)
- [结果与产物](#结果与产物)
- [已知限制](#已知限制)
- [开发](#开发)

## 快速开始

需要 Python 3.12 或更高（已在 3.12 / 3.13 上验证）。

```bash
python -m venv .venv
.venv\Scripts\activate                          # Windows；Linux/macOS 用 source .venv/bin/activate
pip install -e ".[api,retrieval,local,algorithms,dev]"  # 推荐：覆盖默认实验所需全部能力
```

> 也可以直接用已有的 conda 环境（本项目在 `models_trian` 环境上验证通过）：
> `conda activate models_trian && pip install -e ".[api,retrieval,local,algorithms,dev]"`

依赖按场景分组，核心依赖只有 numpy / scikit-learn / optuna / tqdm：

| 可选组 | 内容 | 用途 |
|---|---|---|
| `remote` | openai | 远程 OpenAI 兼容嵌入服务 |
| `retrieval` | chromadb | 知识库检索增强 |
| `local` | sentence-transformers, torch, transformers | **本地模型嵌入（默认路径）** |
| `algorithms` | hdbscan, chinese-whispers, networkx | 全部聚类算法 |
| `umap` | umap-learn | UMAP 降维分支 |
| `analysis` | matplotlib, pandas, scipy | 分析脚本 |
| `api` | fastapi, uvicorn | REST 服务 |
| `dev` | pytest, httpx, ruff | 开发与测试（`dependency-groups`） |

### 准备本地模型（默认走本地，不依赖外网）

`configs/models.toml` 默认使用 `provider = "sentence_transformer"` **本地加载**，
不需要任何 API 凭证。首次使用需下载权重并生成校验清单：

```bash
# 1) 下载 BGE 权重到 models/（约 1.3 GB）
retrain-cluster download-model \
  --source BAAI/bge-large-zh-v1.5 --revision main \
  --destination models/bge-large-zh-v1.5

# 2) 生成文件校验清单
retrain-cluster model-manifest \
  --directory models/bge-large-zh-v1.5 \
  --output models/bge-large-zh-v1.5/manifest.json

# 3) 把 manifest.json 里的 file_checksums 内联到 configs/models.toml
#    注意：verify_local_model 只接受内联 dict，不接受清单文件路径
```

`models/` 已在 `.gitignore` 中忽略，权重不随仓库分发。

随后三步跑通一次聚类：

```bash
# 1) 放入输入数据（见下一节）
#    仅跑 nr0（纯向量）profile 时不需要任何输入数据

# 2) 查看可用 profile（10 算法 × {nr0, nr1}）
retrain-cluster --config configs/app.toml profiles

# 3) 对一批文本做一次聚类
retrain-cluster --config configs/app.toml cluster --input request.json --output result.json
```

`request.json` 形如：

```json
{"profile_id": "bge-large-agglomerative-nr0-legacy-v1",
 "items": [{"id": "r1", "text": "焊缝表面存在裂纹"}, {"id": "r2", "text": "管道接口渗漏"}]}
```

> **关于结果**：profile 里的超参是在**全量调参集**上搜索得到的。
> 用小批量文本（如两三条）提交时，密度类算法（DBSCAN / HDBSCAN / OPTICS）很可能
> 把全部样本判为噪声（`cluster_id = -1`），这属于**样本量不足**，不是故障。

### 切换回远程嵌入服务

`configs/models.toml` 末尾保留了远程配置片段。把 `[[models]]` 整个替换成注释中的那段，
并配置凭证即可：

```bash
export EMBEDDING_API_KEY=sk-...                 # Windows: set EMBEDDING_API_KEY=sk-...
```

凭证**只走环境变量**，不写进配置文件，也不出现在任何运行清单里。

## 数据准备

输入**不随仓库分发**（体积大且含业务文本），已在 `.gitignore` 中忽略 `data/`。
路径在 [`configs/app.toml`](configs/app.toml) 的 `[experiment]` 段配置，默认指向仓库根目录 `data/`：

| 输入 | 格式 | 说明 |
|---|---|---|
| `data/reference.json` | `{文本: one-hot 标签向量}` | 调参集，取 `argmax` 得标签；键唯一，顺序保留 |
| `data/labels.json` | `{类别名: [文本, ...]}` | 测试集，同一文本可出现在多个类别 |
| `data/database.txt` | 每行一条 | 知识库语料，空行与结尾换行按原样保留 |

- 输入顺序、原始字符串、重复记录全部保留；标签只用于超参选择与评估，**不进入编码器或聚类器**。
- 三个文件都是可选的：只跑 `cluster` 只需要 `database.txt`（且仅当 profile 启用检索）。
- 加载约定由 `tests/unit/test_data_cache.py` 用合成样本锁定，不依赖真实数据即可验证。

## 启动方式

### REST 服务

```bash
retrain-cluster --config configs/app.toml serve [--host 127.0.0.1] [--port 8000]
```

服务在独立的 spawn 工作进程中执行聚类，外部请求与重依赖隔离：

| 端点 | 作用 |
|---|---|
| `POST /api/v1/clusterings` | 提交一批文本，返回 `run_id` 与逐条 `cluster_id` |
| `GET /api/v1/clusterings/{run_id}` | 取回历史结果（校验 `result.json` 校验和） |
| `GET /api/v1/profiles` | 列出可用 profile 及不可用原因（不泄露路径与凭证） |
| `GET /api/v1/algorithms` | 列出 API 暴露的 10 种算法 |
| `GET /health/live` / `GET /health/ready` | 存活探测 / 工作进程就绪探测 |

并发准入为**单请求**：正在执行时后续请求返回 `429 SERVICE_BUSY`；超过 `timeout_seconds`
返回 `504 CLUSTERING_TIMEOUT` 并重启工作进程。请求体上限 2 MiB，超限返回 `413`。

服务默认绑定 `127.0.0.1` 且**不含鉴权**，对外暴露前需自行加反代。
完整的请求/响应字段、全部错误码与客户端示例见 **[docs/api文档/](docs/api文档/README.md)**。

### 命令行

统一入口为 `retrain-cluster`，也可 `python -m retrain_cluster`。所有命令都接受
`--config` 指定配置文件（默认 `configs/app.toml`，未指定时读取环境变量 `RETRAIN_CONFIG`）。

| 命令 | 作用 |
|---|---|
| `profiles` | 列出所有可用 profile |
| `cluster --input req.json [--output r.json]` | 按 profile 对一批文本做一次聚类 |
| `serve [--host H] [--port P]` | 启动 REST 服务 |
| `build-kb --model-id X --id kb1 --input data/database.txt` | 构建 ChromaDB 知识库 |
| `tune --profile P [--n-results K] [--pca-dim D] [--n-trials N] [--n-jobs J] [--seed S]` | Optuna TPE 调参并在测试集上评估 |
| `replay --profile P --embeddings v.npy --output r.json [--labels y.npy]` | 用历史向量复现聚类 |
| `import-cache --model-id X --input texts.json --legacy old.npy` | 导入旧缓存（标记为 `unverified`） |
| `model-manifest --directory D --output m.json` | 生成本地模型文件校验清单 |
| `download-model --source R --revision V --destination D` | 下载 HuggingFace 模型快照 |

```bash
retrain-cluster build-kb --model-id bge-large-zh-v1.5 --id bge-large-raw-lines-v1 --input data/database.txt
retrain-cluster tune --profile bge-large-agglomerative-nr0-legacy-v1 --n-trials 200
```

### 只读分析脚本

不重跑聚类，只读 `artifacts/runs/`：

```bash
python scripts/analysis/summarize_runs.py --output summary.json
python scripts/analysis/export_predictions.py --run run_<32位hex> --output clusters.csv
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | **模型架构、数据流与启动脚本**（当前代码为准） |
| [docs/api文档/](docs/api文档/README.md) | **REST API 参考**（端点、字段、错误码、并发与部署） |
| [docs/refactoring/](docs/refactoring/README.md) | 重构背景、契约、旧缺陷清单与迁移映射 |
| [docs/refactoring/baseline-manifest.json](docs/refactoring/baseline-manifest.json) | 重构前逐文件 SHA-256 指纹（commit `52c85cf`） |
| [docs/项目论文/](docs/项目论文/cjc-article-v5.3/README.md) | 论文 LaTeX 源码与编译说明 |

## 工作原理

一次请求的处理链路（详见 [docs/architecture.md](docs/architecture.md)）：

```
文本 → 嵌入(缓存) → [检索近邻均值] → 融合 Z = βX + (1−β)R → [降维] → 聚类内核 → 标签
         │                    │                                        │
    EmbeddingCache      ChromaRetriever                      clustering/registry
```

- **嵌入**：按 `provider` 选择后端（远程 OpenAI 兼容 / sentence-transformers / SimCSE / SCCL），
  以 `模型指纹 + 文本 + 处理版本` 作缓存键，命中即复用。
- **检索增强**：`n_results > 0` 时按批查询 ChromaDB HNSW-l2 知识库，对每个样本**单独取均值**
  （保留历史累加路径），再按 `beta` 与原始向量线性融合。
- **降维**：`pca_dim > 0` 时走 PCA/UMAP；`legacy-radbscan-v1` 版本在融合后**额外再做一次降维**
  （历史行为，刻意保留）。
- **聚类**：11 个内核中的一种。`mean_shift` 只经 CLI/`tune` 暴露，API 只暴露其余 10 种。
- **超参搜索**：`tune` 走 Optuna TPE（`multivariate=True`），搜索空间与旧版逐字段一致；
  每个 trial 同时记录 `sampled_params` 与 `resolved_params`（含固定参数）。

依赖方向单向：`api → services → {features, clustering, embeddings}`，无反向引用。
两处扩展点用 Protocol 定义，可直接替换实现：`embeddings.base.Encoder`、`retrieval.base.Retriever`。

## 配置

```
configs/app.toml     应用与实验参数（路径均相对该文件所在目录解析）
configs/models.toml  模型定义（provider / source / dimension / revision / 校验清单）
configs/profiles/    20 个 profile = 10 种算法 × {nr0, nr1}
```

- **`configs/models.toml` 默认本地加载**（`provider = "sentence_transformer"`，`device = "cpu"`），
  需要 `models/bge-large-zh-v1.5/` 下的权重与内联的 `file_checksums` 校验和一致；
  文件末尾保留了远程配置片段，可整段替换以切回远程。切回后需配置 `EMBEDDING_API_KEY`。
- `local` provider 加载时强制 `local_files_only=True`，**绝不静默联网下载**——
  否则"实际用了哪个模型"会失控，破坏可复现性。
- 模型指纹（写进产物、用作缓存键）**不含凭据**：`api_key_env` 被显式排除在指纹计算之外。
- `nr0` = 纯向量聚类（`n_results=0, beta=1`）；`nr1` = 融合知识库近邻均值后再聚类。
- profile 记录 `source_result` / `source_sha256`，可回溯到历史实验结果。
- 环境变量覆盖：`RETRAIN_ARTIFACTS_DIR`、`RETRAIN_MAX_SAMPLES`、`RETRAIN_HOST`、`RETRAIN_PORT`
  等（对应 `[app]` 字段的大写形式）；实验参数可用 `N_TRIALS`、`N_JOBS`、`SEED` 覆盖。
- 凭证**只走环境变量** `EMBEDDING_API_KEY`：不写进配置文件，也不出现在任何运行清单里。

## Python API

```python
from retrain_cluster import Settings
from retrain_cluster.services import ClusteringService, ExperimentService

settings = Settings.load("configs/app.toml")
result = ClusteringService(settings).cluster(
    {"profile_id": "bge-large-agglomerative-nr0-legacy-v1", "items": items}
)
print(result["n_clusters"], result["assignments"])

ExperimentService(settings).run("bge-large-agglomerative-nr0-legacy-v1", n_trials=50)
```

包顶层只导出轻量符号（`Settings` / `Catalog` / `ClusterError` / 5 个 dataclass）；子包需显式导入
（`from retrain_cluster.services import ...`），以保持 `import retrain_cluster` 不加载
fastapi / chromadb / torch 等重依赖，并避免循环导入。

## 指标口径

```
CCA    = min(K_pred, K_true) / max(K_pred, K_true)          # 有效簇数比，排除 -1
Score  = 0.4·ARI + 0.3·NMI + 0.1·V-measure + 0.1·CCA + 0.1·(1 - noise_ratio)
```

ARI / NMI / V-measure / FMS / AMI / HS / CS 均在**非噪声样本**上计算。
有效簇少于 2 时 `score = -1` 且不产出其它指标。实现在 `evaluation/metrics.py`，口径与历史一致。

## 结果与产物

新运行统一写入 `artifacts/`（`embeddings/`、`knowledge_bases/`、`runs/`），全部为原子写：

- `artifacts/embeddings/<key>.json` + `<key>.<uuid>.npy` —— 缓存指针与不可变数据文件，含 shape/dtype/SHA-256
- `artifacts/knowledge_bases/<id>/manifest.json` + `index/` —— 知识库清单与 ChromaDB 索引
- `artifacts/runs/<run_id>/result.json` + `manifest.json` —— 结果与 **commit marker**
  （最后写入，含 profile / 模型 / 输入 / 嵌入 / 特征指纹、库版本、`cache_hit`）
- `artifacts/runs/<run_id>/{profile,best,trials,test}.json` —— `tune` 产出的导出 profile、
  best 参数、全部 trial、测试集指标与逐条标签

## 已知限制

- 每个请求**整批重新聚类**，簇 ID 不跨运行稳定；拆批不等价于全量聚类。
- profile 里的超参来自**全量调参集**的搜索。用小批量提交时，密度类算法
  （DBSCAN / HDBSCAN / OPTICS）很可能把全部样本判为噪声，属样本量不足，不是故障。
- 缺少历史向量与索引，仓库内测试基线标记为 `current-environment`，
  **不代表论文指标已在本地复现**。
- **本地模型与远程模型产出的向量不是逐位相同的**：远程服务端的池化/精度实现不公开，
  切到本地后，用历史远程向量建立的缓存与知识库需要重建。
- CW 算法保留 `LEGACY_CW_LABEL_MAPPING` 历史缺陷（cluster→members 被当作 sample→cluster），
  位于 `legacy-v1` 特征版本，不借重构之名改动结果。
- 修复任何历史缺陷都必须**新增实现或新增特征版本**，不得修改 `legacy-v1` /
  `legacy-radbscan-v1` 两条既有口径，否则历史摘要与论文图表都会失效。
- 使用远程模型时 revision 无法锁定：运行清单会带 `REMOTE_MODEL_REVISION_UNPINNED` 警告
  （本地 provider 通过 `file_checksums` 校验和锁定，无此问题）。

## 开发

使用项目虚拟环境，**不要**用系统解释器：

```bash
.venv\Scripts\python.exe -m pytest tests/ -q                      # Windows（Python 3.12）
python -m pytest tests/ -q                                        # Linux / macOS
.venv\Scripts\python.exe -m ruff check src tests scripts
```

也可用 conda 环境（Python 3.13 已验证，`requires-python = ">=3.12"`）：

```bash
conda activate models_trian
python -m pytest tests/ -q
```

现状：**202 passed**，ruff 全绿。测试覆盖 `unit / regression / integration / api` 四层，
禁止在导入期访问业务输入或联网（`tests/unit/test_boundaries.py` 用子进程 + 打桩 `open` 守护）。

行为回归由 `tests/regression/test_golden_labels.py` 守护：11 种算法 × 5 组
`(n_results, pca_dim)` 网格在冻结 fixture 上的聚类分配被记录为 SHA-256 摘要。
**摘要失配即意味着行为改变**——应当新增特征版本，而不是修改期望值。

---

*重构前的一切（`main.py`、`run_all_algos.py`、`optimizer/`、`evaluator/`、`bak/`、`utils/`、
`draw/`、`legacy/`、`output*/`）已从工作区删除，仅保留在 git 历史中，可用
`git show <commit>:<path>` 取出。当前唯一入口是 `retrain-cluster`。*
