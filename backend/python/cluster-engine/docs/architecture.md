# 模型架构与启动脚本

本文以**当前工作区代码为准**，描述 retrain-cluster 的模型架构、数据流与启动方式。
历史对照与重构决策见 [`docs/refactoring/`](refactoring/README.md)。

> **术语澄清**：本项目的"训练/retrain"指 **Optuna 聚类超参数搜索**，不涉及嵌入模型训练。
> 嵌入向量由远程或本地预训练模型产出，模型权重不在本仓库内。

- [1. 总体数据流](#1-总体数据流)
- [2. 模型架构](#2-模型架构)
- [3. 聚类内核](#3-聚类内核)
- [4. 超参搜索空间](#4-超参搜索空间)
- [5. 产物契约](#5-产物契约)
- [6. 启动脚本](#6-启动脚本)
- [7. 扩展点](#7-扩展点)

## 1. 总体数据流

一次聚类请求（`POST /api/v1/clusterings` 或 `cluster` 命令）的完整链路：

```
                    ┌──────────────────────────── 输入 ────────────────────────────┐
                    │ items: [{id, text}]                                          │
                    └───────────────────────────┬──────────────────────────────────┘
                                                ▼
        profile = Catalog.profile(profile_id)   校验 profile / 算法参数 / 样本上限
                                                ▼
        texts ──► EmbeddingCache.key(texts, 模型指纹, raw-v1)
                        │
              ┌─────────┴─────────┐
        命中  │                   │ 未命中
              ▼                   ▼
        复用 .npy         EncoderRegistry.get(spec, 指纹).encode(texts)  ──► 回写缓存
              └─────────┬─────────┘
                        ▼
                  X  (n × d)                       validate_matrix：2 维 / 有限 / 维度匹配
                        ▼
        ┌── n_results == 0 ──► R = X （纯向量）
        │
        └── n_results > 0 ──► ChromaRetriever.query(批大小 query_batch, k=n_results)
                              ──► 每个样本单独 np.mean 得 R  (n × d)
                              ──► Z = β·X + (1−β)·R
                        ▼
        pca_dim > 0 ──► DimReducer 降维（PCA / UMAP）
        legacy-radbscan-v1 且 n_results > 0 ──► 融合后**额外再降一次维**（历史行为）
                        ▼
        clusterer = validate_params(algorithm, params, backend)  签名绑定 + 取值域校验
                        ▼
        pred = clusterer(Z, **algorithm_params)                  (n,) 整数标签，-1 为噪声
                        ▼
        result.json + manifest.json（原子写，manifest 最后写作为 commit marker）
```

关键约束（`services/clustering.py`）：

- **先校验再计费**：检索器在发起潜在计费的嵌入请求**之前**完成初始化与完整性校验。
- **诚实标注**：`warnings` 会带上 `REMOTE_MODEL_REVISION_UNPINNED`、
  `HISTORICAL_EMBEDDINGS_NOT_VERIFIED`、`LEGACY_SEPARATE_REDUCTION`、`LEGACY_CW_LABEL_MAPPING` 等。
- **输出校验**：标签形状必须是 `(n,)` 且为整数类型，否则 `500 INVALID_CLUSTER_OUTPUT`。
- **样本下限**：`hdbscan` / `optics` 的批次必须不小于其邻域参数，否则 `422 INVALID_SAMPLE_COUNT`。

## 2. 模型架构

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ 入口层                                                                │
│   cli.py           9 个命令的 argparse 分发                           │
│   api/             FastAPI 应用 + 路由 + Pydantic 契约 + spawn 执行器  │
├──────────────────────────────────────────────────────────────────────┤
│ 编排层                                                                │
│   services/clustering.py    ClusteringService  单次推理               │
│   services/experiments.py   ExperimentService  Optuna 调参 + 测试评估  │
├──────────────────────────────────────────────────────────────────────┤
│ 领域层                                                                │
│   features/      融合 fuse(β) + 近邻均值 + 降维 DimReducer            │
│   clustering/    11 个内核 + 显式注册表 registry                      │
│   optimization/  TPE runner + search_spaces（历史搜索空间）           │
│   evaluation/    QbEvaluator 复合评分                                 │
├──────────────────────────────────────────────────────────────────────┤
│ 适配层（可替换，Protocol 定义）                                        │
│   embeddings/    Encoder  ×4 实现                                     │
│   retrieval/     Retriever ×1 实现（ChromaDB）                        │
├──────────────────────────────────────────────────────────────────────┤
│ 基础设施                                                              │
│   config.py     Settings / Catalog / 指纹校验                         │
│   data/         加载 loaders + 校验 validation                        │
│   artifacts/    嵌入缓存 / 运行清单 / 内容指纹（原子写 + 校验和）      │
│   types.py      5 个数据契约 dataclass                                │
│   errors.py     ClusterError(code, message, status)                   │
└──────────────────────────────────────────────────────────────────────┘
```

依赖方向严格单向：`api → services → {features, clustering, embeddings, retrieval}`。
底层（`types` / `errors` / `artifacts`）不反向依赖上层。

### 2.2 数据契约（`types.py`）

| 类型 | 字段 | 说明 |
|---|---|---|
| `TextDataset` | `dataset_id, sample_ids, texts, labels, label_names, source_fingerprint` | 数据集快照，行序与原文保留 |
| `EmbeddingBatch` | `sample_ids, values, model_fingerprint, processing_fingerprint` | 嵌入批次 |
| `NeighborBatch` | `ids, values, knowledge_base_id, distances` | 检索结果 |
| `FeatureSpec` | `beta, n_results, pca_dim, reduction, version` | 特征配置，**冻结**且构造即校验 |
| `ResolvedPipelineConfig` | `profile_id, algorithm, model_id, algorithm_params, features, knowledge_base_id, ...` | 已解析 profile |

`FeatureSpec.version` 目前只有两个合法值，代表两条不可变行为口径：

- `legacy-v1` —— 常规路径。
- `legacy-radbscan-v1` —— RADBSCAN 专用：融合后额外再做一次降维。

### 2.3 嵌入层

`embeddings/registry.py` 的 `PROVIDERS` 决定后端选择，`EncoderRegistry` 按**模型指纹**缓存实例
（同一进程内不重复加载权重）：

| provider | 实现类 | 池化 | 依赖 |
|---|---|---|---|
| `openai_compatible` | `OpenAICompatibleEncoder` | provider 侧 | openai |
| `sentence_transformer` | `SentenceTransformerEncoder` | 实现内定 | sentence-transformers |
| `simcse` | `SimCSEEncoder` | `cls` | torch |
| `sccl` | `SCCLEncoder` | `mean` | torch |

- 远程路径：按 `batch_size` 分批调用，**校验返回行序**（`index` 必须等于批次内下标），
  顺序不符直接抛 `502 EMBEDDING_ORDER_INVALID`；客户端**不做归一化**（沿用历史口径）。
- 本地路径：必须提供 `file_checksums` / `required_files` 清单，逐文件 SHA-256 校验，
  并递归校验 `tokenizer_source`（`config.verify_local_model`）；任一不符 → `503 MODEL_UNAVAILABLE`。
- 凭证仅读环境变量（`api_key_env`，默认 `EMBEDDING_API_KEY`），不进入指纹。

### 2.4 检索层

`retrieval/chroma.py` 的 `ChromaRetriever` 只接收向量、返回近邻，不感知标签、评分与算法。

- 索引使用 **HNSW + l2** 空间，集合名固定 `micro`。
- 初始化时三重校验：`count` 一致、`hnsw.space == l2`、`records_sha256` 与清单一致。
- 清单要求 `status=completed` 且 `verification=verified`，且 `model_fingerprint` / `dimension` 匹配。
- 查询前校验 HNSW 不能返回未填充邻居：行数与每行近邻数不足即 `503 INVALID_NEIGHBORS`。

`retrieval/build.py` 的 `build_knowledge_base` 构建索引：目录**不可预先存在**（绝不复用旧索引），
先写 `status=building` 清单，分批（2048/批）插入，最后回写 `completed` 与 `records_sha256`。

### 2.5 特征层

`features/pipeline.py` 是融合与降维的唯一入口，**不读取标签**：

```python
Z = β·X + (1−β)·R            # fuse：原始向量与近邻均值按 beta 线性融合
R = [np.mean(row_i, axis=0)] # neighbor_means：逐样本均值，保留历史累加路径
```

- `n_results=0` 时不做检索，`beta` 取 1.0，`Z = X`。
- 检索按 `query_batch` 分批，避免一次性载入全部近邻。
- `pca_dim > min(X.shape)` 时抛 `422 INVALID_REDUCTION`（超出批次秩上限）。
- 两个降维分支各自 `fit_transform`（历史行为：X 与 R 分别拟合再融合）。

### 2.6 API 层与执行模型

`api/execution.py` 的 `SyncExecutor` 用一个**常驻 spawn 子进程**承载聚类：

- 用 `spawn` 而非 fork，与重依赖（torch / chromadb）隔离，避免父进程污染。
- 子进程启动后回送 `("ready", None)`；父进程轮询就绪，超时即 `504`。
- 准入用非阻塞锁：已有一个请求在执行时立即 `429 SERVICE_BUSY`，不做排队。
- 单次调用有硬 deadline（`timeout_seconds`）；超时或管道断裂会 `close()` 后重启工作进程，
  **绝不留下超时任务继续占用资源**。
- 返回结果通过管道序列化，子进程内的 `ClusterError` 原样还原为对应 HTTP 状态码。

`api/app.py` 的 `RequestBoundary` 中间件在进入路由前做请求体体积把关（默认 2 MiB），
并为每个请求生成 `x-request-id`，透传进所有错误响应体。

## 3. 聚类内核

`clustering/registry.py` 的 `ALGORITHMS` 是唯一注册表，值形如
`(模块名, 函数名, 依赖探测名)`；`API_ALGORITHMS` 排除 `mean_shift`（仅 CLI 可用）。

| 算法 | 实现位置 | 后端 | 依赖 |
|---|---|---|---|
| `agglomerative` | `sklearn_algorithms.py` | sklearn | ward + `distance_threshold` |
| `birch` | `sklearn_algorithms.py` | sklearn | `n_clusters=None` |
| `optics` | `sklearn_algorithms.py` | sklearn | — |
| `hdbscan` | `hdbscan.py` | hdbscan | hdbscan |
| `radbscan` | `radbscan.py` | sklearn | 论文 Algorithm 1/3，可带 forwarding matrix |
| `affinity_propagation` | `affinity_propagation.py` | sklearn | — |
| `dbscan` | `dbscan.py` | sklearn | — |
| `chinese_whispers` | `chinese_whispers.py` | chinese-whispers | + networkx，kd_tree 建图 |
| `leader` | `leader.py` | sklearn | 增量式，中心点为运行均值 |
| `canopy` | `canopy.py` | sklearn | t1 > t2 |
| `mean_shift` | `mean_shift.py` | sklearn | **仅 CLI**，API 不暴露 |

`validate_params` 做两道校验：**签名绑定**（参数名必须完整匹配）与**取值域**（正数、整数下限、
`damping ∈ [0.5, 1)`、`xi ∈ (0, 1)`、`t1 > t2`、`metric` / `weighting` 枚举等），
任一不符统一抛 `422 INVALID_PROFILE`。`backend` 只接受 `"python"`，其他值 `503 BACKEND_UNAVAILABLE`。

## 4. 超参搜索空间

`optimization/search_spaces.py` 逐字段复刻历史分布与**建议顺序**（顺序影响 TPE 的确定性）：

| 算法 | 搜索参数 |
|---|---|
| `agglomerative` | `distance_threshold ∈ [0.1, 4]`、`beta`、`pca_dim`、`n_results` |
| `hdbscan` | `min_cluster_size ∈ [2,20]`、`cluster_selection_epsilon ∈ [0,2]`、`alpha ∈ [0.1,1]` |
| `radbscan` | `eps ∈ [0.1,5]`、`min_pts ∈ [2,20]` |
| `optics` | `min_samples ∈ [2,20]`、`xi ∈ [0.001,0.2]`、`min_cluster_size ∈ [0.001,0.2]` |
| `affinity_propagation` | `damping ∈ [0.5,0.99]`、`preference ∈ [-100,0]` |
| `dbscan` | `eps ∈ [0.1,5]`、`min_samples ∈ [2,20]`、`leaf_size ∈ [10,100]` |
| `chinese_whispers` | `n_neighbors ∈ [5,50]`、`weighting ∈ {top,lin}`、`iterations ∈ [10,50]` |
| `birch` | `threshold ∈ [0.1,1]`、`branching_factor ∈ [20,200]` |
| `leader` | `threshold ∈ [0.1,5]`、`metric ∈ {euclidean,cosine,manhattan,l2}` |
| `canopy` | `t2 ∈ [0.1,4]`、`t1 ∈ [t2+0.01, 5]`、`metric` 同上 |
| `mean_shift` | `bandwidth ∈ [0.1,5]`、`cluster_all ∈ {True,False}`、`max_iter ∈ [100,500]` |

三个固定维度参数的语义：

- `n_results = -1`（调参）→ 搜索 `[1,7]`；`= 0` → 强制无检索且 `beta` 恒为 1.0；`> 0` → 固定该值。
- `pca_dim = -1`（调参）→ 搜索 `{16,32,64,128,256,512,768}`；`= 0` → 不降维；`> 0` → 固定该值。
- `beta` 仅在启用检索时参与搜索。

`optimization/runner.py` 的 `optimize()` 用 `TPESampler(n_startup_trials=15, seed=42, multivariate=True)`，
方向 `maximize`，目标为 `QbEvaluator` 的 `score`。每个 trial 都写入：

- `resolved_params` —— **算法参数与特征参数合并后**的完整实际执行设置（含固定参数）。
- 各项指标 —— `ari` / `nmi` / `vm` / `fms` / `ami` / `hs` / `cs` / `n_clusters` / `noise_ratio` / `score`。

这是对历史缺陷 E04 的修补：旧版 `best_params` 不含固定参数，复现时容易丢参数。

## 5. 产物契约

所有写入都是**临时文件 + fsync + `os.replace`** 的原子写，且 `manifest.json` **最后写**作为
commit marker。

```
artifacts/
├── embeddings/
│   ├── <key>.json          # 指针：file / shape / dtype / sha256 / verification / source
│   └── <key>.<uuid>.npy    # 不可变数据文件（唯一名，避免并发写混用）
├── knowledge_bases/
│   └── <kb_id>/
│       ├── manifest.json   # status / verification / metric / fingerprint / count / records_sha256
│       └── index/          # ChromaDB 持久化目录
└── runs/
    └── run_<32位hex>/
        ├── result.json     # 单次推理结果（API GET 会校验其校验和）
        ├── manifest.json   # commit marker
        ├── profile.json    # 仅 tune：导出的新 profile
        ├── best.json       # 仅 tune：sampled / resolved 参数 + 指标
        ├── trials.json     # 仅 tune：全部 trial
        └── test.json       # 仅 tune：测试集指标 + sample_ids + labels
```

指纹体系（`artifacts/fingerprints.py`）统一用 SHA-256：

| 指纹 | 计算方式 | 用途 |
|---|---|---|
| `fingerprint(value)` | 规范化 JSON（键排序、紧凑分隔符）→ SHA-256 | profile、集合等结构化对象 |
| `file_hash(path)` | 分块读文件 → SHA-256 | 模型文件、输入文件、结果文件 |
| `array_hash(values)` | `shape + dtype + 字节流哈希` 三者再哈希 | 嵌入、特征矩阵 |
| `model_fingerprint(spec)` | 模型 spec 去掉 `api_key_env` 后哈希 | 缓存键、知识库绑定，**凭证不参与** |

`RunStore.path()` 只接受 `run_[0-9a-f]{32}`，用一个正则同时挡住路径穿越与错误 ID。

## 6. 启动脚本

### 6.1 环境准备

```bash
python -m venv .venv
.venv\Scripts\activate                                   # Windows
# source .venv/bin/activate                              # Linux / macOS
pip install -e ".[api,retrieval,algorithms,dev]"
```

需要的可选组取决于使用路径：只用远程嵌入 + 检索需要 `remote,retrieval,api,algorithms`；
用本地模型再加 `local`。

### 6.2 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `RETRAIN_CONFIG` | 配置文件路径（等价于 `--config`） | `configs/app.toml` |
| `EMBEDDING_API_KEY` | 远程嵌入服务凭证（`models.toml` 的 `api_key_env`） | 无，缺失则 `503` |
| `RETRAIN_ARTIFACTS_DIR` | 产物根目录 | `configs/` 同级的 `../artifacts` |
| `RETRAIN_MAX_SAMPLES` | 单请求样本上限 | 300000 |
| `RETRAIN_HOST` / `RETRAIN_PORT` | 服务监听地址 | `127.0.0.1` / `8000` |
| `N_TRIALS` / `N_JOBS` / `SEED` | 覆盖 `[experiment]` 搜索规模 | 200 / 8 / 42 |

### 6.3 启动步骤

```bash
# ① 校验配置与 profile 是否能被解析
retrain-cluster --config configs/app.toml profiles

# ② 构建知识库（仅在 profile 使用 n_results > 0 时需要）
retrain-cluster --config configs/app.toml build-kb \
    --model-id bge-large-zh-v1.5 --id bge-large-raw-lines-v1 --input data/database.txt

# ③ 启动 REST 服务
retrain-cluster --config configs/app.toml serve --host 127.0.0.1 --port 8000

# ④ 健康检查
curl http://127.0.0.1:8000/health/live      # {"status":"alive"}
curl http://127.0.0.1:8000/health/ready     # {"status":"ready"}；工作进程未就绪则 503

# ⑤ 提交一次聚类
curl -X POST http://127.0.0.1:8000/api/v1/clusterings \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"bge-large-agglomerative-nr0-legacy-v1",
       "items":[{"id":"r1","text":"焊缝表面存在裂纹"},{"id":"r2","text":"管道接口渗漏"}]}'
```

### 6.4 调参流程

```bash
# 在 reference.json 上搜索、在 labels.json 上评估；产物写入 artifacts/runs/run_<hex>/
retrain-cluster --config configs/app.toml tune \
    --profile bge-large-agglomerative-nr0-legacy-v1 \
    --n-results -1 --pca-dim 0 --n-trials 200 --n-jobs 8 --seed 42

# 查看对比表与完整性校验
python scripts/analysis/summarize_runs.py --output summary.json
python scripts/analysis/export_predictions.py --run run_<32位hex> --output clusters.csv
```

`tune` 产出的 `profile.json` 就是可复用的新 profile：把 `features` 与 `algorithm_params` 拷回
`configs/profiles/` 即可固化为配置（注意 `source_result` / `source_sha256` 会被清空）。

### 6.5 常见启动失败

| 症状 | 原因 | 处理 |
|---|---|---|
| `503 MODEL_UNAVAILABLE` | 凭证未设置 / 本地模型缺校验清单 / 文件校验和不符 | 设 `EMBEDDING_API_KEY`，或对模型目录跑 `model-manifest` 生成清单 |
| `503 KNOWLEDGE_BASE_UNAVAILABLE` | 知识库缺失、未完成、或与模型指纹/维度不符 | 重新 `build-kb`；注意 id 不可复用 |
| `503 ALGORITHM_UNAVAILABLE` | 算法依赖未安装（如 hdbscan / networkx） | `pip install -e ".[algorithms]"` |
| `429 SERVICE_BUSY` | 已有一次聚类在执行 | 等待完成，或扩容多个实例（单实例不排队） |
| `504 CLUSTERING_TIMEOUT` | 超过 `timeout_seconds`（默认 60s） | 调大 `timeout_seconds` 或缩小批次 |
| `413 REQUEST_TOO_LARGE` | 请求体超过 2 MiB | 拆分批次 |
| `422 INVALID_PROFILE` | 算法参数不满足契约 / profile 字段非法 | 对照 `validate_params` 的取值域 |
| `503 WORKER_NOT_READY` | 工作进程仍在加载重依赖 | 稍后重试；`/health/ready` 返回 200 后再提交 |

## 7. 扩展点

两处 Protocol（`@runtime_checkable`）是替换实现的官方入口，无需改动上层代码：

| Protocol | 位置 | 约定 |
|---|---|---|
| `Encoder` | `embeddings/base.py` | `encode(texts) -> np.ndarray (n × d)` |
| `Retriever` | `retrieval/base.py` | `query(vectors, k) -> NeighborBatch` |

```python
from retrain_cluster.services import ClusteringService

service = ClusteringService(settings, encoders=MyRegistry(), retriever_factory=MyRetriever)
```

`ClusteringService` 支持注入 `encoders` 与 `retriever_factory`，测试即通过这两个参数装配
确定性替身（见 `tests/conftest.py` 的 `FixedEncoder` / `ExactNeighbors`）。

**新增算法**需要同步四处：`clustering/<name>.py` 实现 → `registry.ALGORITHMS` 注册 →
`optimization/search_spaces.py` 加 `SPACES` 条目 → `configs/profiles/` 加 profile。
`tests/unit/test_clustering.py` 会断言 `set(SPACES) == set(ALGORITHMS)`。
