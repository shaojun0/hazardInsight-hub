# REST API 参考

`retrain-cluster serve` 暴露的 HTTP 接口。所有端点均为 **同步**（阻塞到聚类结束），
`POST /api/v1/clusterings` 是唯一的写操作。

- **Base URL**：`http://127.0.0.1:8000`（由 `[app]` 的 `host` / `port` 决定）
- **API 版本前缀**：`/api/v1`
- **内容类型**：请求与响应均为 `application/json; charset=utf-8`
- **OpenAPI**：服务启动后可访问 `/docs`（Swagger UI）、`/redoc`、`/openapi.json`

服务默认只绑定 `127.0.0.1`。**对外暴露前请自行加鉴权反代**，本服务自身不含认证与 TLS。

---

## 目录

- [端点总览](#端点总览)
- [快速上手](#快速上手)
- [健康检查](#健康检查)
- [算法列表](#算法列表)
- [配置档列表](#配置档列表)
- [提交聚类](#提交聚类)
- [查询历史结果](#查询历史结果)
- [错误处理](#错误处理)
- [错误码表](#错误码表)
- [行为告警](#行为告警)
- [并发与超时](#并发与超时)
- [部署与配置](#部署与配置)
- [客户端示例](#客户端示例)

---

## 端点总览

| 方法 | 路径 | 状态码 | 说明 |
|---|---|---|---|
| `GET` | `/health/live` | 200 | 存活探针，进程在即返回 |
| `GET` | `/health/ready` | 200 / 503 | 就绪探针，工作进程预热完成才返回 200 |
| `GET` | `/api/v1/algorithms` | 200 | 列出 API 暴露的 10 种算法及依赖可用性 |
| `GET` | `/api/v1/profiles` | 200 | 列出可用配置档及不可用原因 |
| `POST` | `/api/v1/clusterings` | 201 | 提交一次聚类 |
| `GET` | `/api/v1/clusterings/{run_id}` | 200 / 404 | 取回历史结果 |

除以下两类带参数外，所有端点**不接受任何查询参数或请求体**：

| 端点 | 参数 | 位置 | 约束 |
|---|---|---|---|
| `/api/v1/clusterings/{run_id}` | `run_id` | 路径 | `run_` + 32 位小写十六进制 |
| `/health/live`、`/health/ready`、`/api/v1/algorithms`、`/api/v1/profiles` | 无 | — | 传入多余查询参数会被忽略 |

---

## 快速上手

```bash
# 1) 启动服务（首次需先备好本地模型权重，见后文「模型加载」）
retrain-cluster --config configs/app.toml serve --host 127.0.0.1 --port 8000

# 2) 确认工作进程已预热（未预热会返回 503 WORKER_NOT_READY）
curl -s http://127.0.0.1:8000/health/ready

# 3) 选一个可用的 profile
curl -s http://127.0.0.1:8000/api/v1/profiles | jq '.profiles[] | select(.available) | .profile_id'

# 4) 提交聚类
curl -s -X POST http://127.0.0.1:8000/api/v1/clusterings \
  -H 'Content-Type: application/json' \
  -d '{
        "profile_id": "bge-large-agglomerative-nr0-legacy-v1",
        "items": [
          {"id": "r1", "text": "焊缝表面存在裂纹"},
          {"id": "r2", "text": "管道接口渗漏"}
        ]
      }'
```

> **注意**：`curl` 若受 `HTTP_PROXY` / `HTTPS_PROXY` 影响，会把 `127.0.0.1`
> 的请求也发给代理，产生 `502 upstream connect failed`。请先 `unset http_proxy https_proxy`
> 或改用 `--noproxy 127.0.0.1`。

> **可用性**：默认 `configs/models.toml` 走**本地加载**，备好权重后
> 10 个 `nr0` profile 即可用；另外 10 个 `nr1` profile 还需要知识库
> （`unavailable_reason` 为 `KNOWLEDGE_BASE_UNAVAILABLE`，用 `build-kb` 构建）。
> 若本地权重未就绪，全部 profile 会返回
> `"available": false` / `"unavailable_reason": "MODEL_UNAVAILABLE"`，
> 此时 `POST /api/v1/clusterings` 返回 `503`。这属于**部署未完成**，不是服务故障。

---

## 健康检查

### `GET /health/live`

存活探针。只要进程还在就返回 200，用于容器编排判断是否重启。

```json
{"status": "alive"}
```

### `GET /health/ready`

就绪探针。执行器（spawn 工作进程）已完成初始化才返回 200；否则返回 503，
供负载均衡摘除流量。

**200**：

```json
{"status": "ready"}
```

**503**：

```json
{
  "error": {
    "code": "WORKER_NOT_READY",
    "message": "Execution worker is warming up",
    "request_id": "3f2a9c1b8e7d4a5f9c0b1e2d3a4b5c6d"
  }
}
```

> 首次调用 `ready()` 会尝试读取子进程发来的握手消息，此后复用缓存结果，
> 因此健康检查不会每次产生额外 IO。模型加载慢时，`/health/ready` 会持续 503 一段时间。

推荐编排配置：`livenessProbe` 指向 `/health/live`，`readinessProbe` 指向 `/health/ready`。

---

## 算法列表

### `GET /api/v1/algorithms`

列出 API 暴露的算法及当前环境的依赖可用性。**不含 `mean_shift`**（仅 CLI 可用）。

```json
{
  "algorithms": [
    {
      "algorithm": "agglomerative",
      "available": true,
      "backend": "python",
      "implementation_version": "legacy-v1",
      "max_samples": 500,
      "warnings": []
    },
    {
      "algorithm": "chinese_whispers",
      "available": true,
      "backend": "python",
      "implementation_version": "legacy-v1",
      "max_samples": 500,
      "warnings": ["LEGACY_CW_LABEL_MAPPING", "UNSEEDED_LEGACY_ALGORITHM"]
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `algorithm` | string | 算法名，可作为 profile 的 `algorithm` |
| `available` | bool | 依赖包是否已安装（`find_spec` 探测，不实际导入） |
| `backend` | string | 固定为 `"python"`（唯一冻结后端） |
| `implementation_version` | string | 实现口径版本，当前为 `legacy-v1` |
| `max_samples` | int | 该算法的单次请求样本上限 |
| `warnings` | string[] | 该算法固有告警，见[行为告警](#行为告警) |

返回顺序固定为 10 个算法名，与注册表 `ALGORITHMS` 的声明顺序一致：

```
agglomerative, hdbscan, radbscan, optics, affinity_propagation,
dbscan, chinese_whispers, birch, leader, canopy
```

> `available: false` 表示缺依赖（如未装 `hdbscan` / `chinese-whispers` / `networkx`）。
> 装齐依赖后重启服务即可。

---

## 配置档列表

### `GET /api/v1/profiles`

列出可通过 API 使用的配置档及其可用状态。**只返回 API 白名单内的算法**，
因此默认 20 个 profile 中 `mean_shift` 相关的会被过滤（默认配置下即为 20 个可用 profile）。

```json
{
  "profiles": [
    {
      "profile_id": "bge-large-dbscan-nr1-legacy-v1",
      "algorithm": "dbscan",
      "model_id": "bge-large-zh-v1.5",
      "knowledge_base_id": "bge-large-raw-lines-v1",
      "features": {
        "beta": 0.5322057960368363,
        "n_results": 7,
        "pca_dim": 0,
        "reduction": "PCA",
        "version": "legacy-v1"
      },
      "algorithm_params": {"eps": 0.3812072317632657, "min_samples": 5, "leaf_size": 63},
      "compatibility_status": "legacy",
      "implementation_version": "legacy-v1",
      "max_samples": 500,
      "available": false,
      "unavailable_reason": "MODEL_UNAVAILABLE",
      "warnings": []
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `profile_id` | string | 提交聚类时使用 |
| `algorithm` | string | 算法名 |
| `model_id` | string | 嵌入模型 ID |
| `knowledge_base_id` | string \| null | 知识库 ID；`n_results=0` 时为 `null` |
| `features` | object | 特征配置，见下表 |
| `algorithm_params` | object | 算法超参，只读（不可由请求覆盖） |
| `compatibility_status` | string | `legacy` / 其它历史标记 |
| `implementation_version` | string | 实现口径版本 |
| `max_samples` | int | `min(500, 全局上限, profile 自身上限)` |
| `available` | bool | 当前是否可执行 |
| `unavailable_reason` | string \| null | 不可用原因（错误码），可用时为 `null` |
| `warnings` | string[] | 该算法固有告警 |

`features` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `beta` | float | 融合权重 ∈ [0,1]，`Z = βX + (1−β)R` |
| `n_results` | int | 检索近邻数，`0` 表示不做检索增强 |
| `pca_dim` | int | 降维目标维度，`0` 表示不降维 |
| `reduction` | string | 降维方法（`PCA` / `UMAP`） |
| `version` | string | 特征行为版本（`legacy-v1` / `legacy-radbscan-v1`） |

### 可用性判定逻辑

`available` 由服务端逐层探测得出，**只查不建**（不产生任何副作用）：

1. 算法参数通过 `validate_params` 校验；
2. 模型可解析且通过 `check_model`（依赖已装、凭证已配、本地权重校验和一致）；
3. 若 `n_results > 0`，知识库 manifest 存在、校验和一致、维度与模型匹配。

任一步失败即 `available: false`，`unavailable_reason` 为对应错误码。
**列表接口不会触发嵌入请求或构建索引**，因此可以安全地高频轮询。

> 出于安全考虑，响应中**不包含**文件系统路径、模型 `provider` 原始配置与任何凭证信息。

---

## 提交聚类

### `POST /api/v1/clusterings`

**这是唯一会产生副作用（写入产物、可能计费的嵌入调用）的端点。**

#### 请求体

```json
{
  "profile_id": "bge-large-agglomerative-nr0-legacy-v1",
  "items": [
    {"id": "r1", "text": "焊缝表面存在裂纹"},
    {"id": "r2", "text": "管道接口渗漏"},
    {"id": "r3", "text": "支吊架安装偏差超标"}
  ]
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `profile_id` | string | 是 | 长度 1–128；必须存在于 `/api/v1/profiles` |
| `items` | array | 是 | 长度 **2–500**（至少 2 条才谈得上聚类） |
| `items[].id` | string | 是 | 长度 1–128，**批内唯一** |
| `items[].text` | string | 是 | 长度 1–4000，**不得为纯空白** |

**严格模式**：请求体启用 `extra="forbid"` + `strict=True`，因此

- 多传任何未声明字段（如 `algorithm_params`、`beta`）→ `422 INVALID_REQUEST`；
- 类型不匹配（如 `id` 传数字 `123`、`text` 传 `null`）→ `422 INVALID_REQUEST`，**不做隐式转换**。

算法参数与特征配置只能由 `profile_id` 决定，**不能在请求中覆盖**——这是保证历史口径可复现的前提。

#### 响应 `201 Created`

响应头含：

| 响应头 | 说明 |
|---|---|
| `Location` | `/api/v1/clusterings/{run_id}`，指向本次结果的查询地址 |
| `x-request-id` | 本次请求的 ID，与服务端日志一致，排查问题时提供此值 |

响应体：

```json
{
  "run_id": "run_7d3f9a2b1c4e5f6089ab12cd34ef5678",
  "profile_id": "bge-large-agglomerative-nr0-legacy-v1",
  "algorithm": "agglomerative",
  "implementation_version": "legacy-v1",
  "n_samples": 3,
  "n_clusters": 2,
  "n_noise": 0,
  "assignments": [
    {"id": "r1", "cluster_id": 0},
    {"id": "r2", "cluster_id": 1},
    {"id": "r3", "cluster_id": 0}
  ],
  "warnings": [],
  "elapsed_ms": 412
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | `run_` + 32 位 hex，可用于查询结果与定位产物目录 |
| `profile_id` | string | 回显请求中的 profile |
| `algorithm` | string | 实际使用的算法 |
| `implementation_version` | string | 实现口径版本 |
| `n_samples` | int | 参与聚类的样本数 |
| `n_clusters` | int | 有效簇数，**不含噪声** |
| `n_noise` | int | 噪声样本数（`cluster_id == -1`） |
| `assignments` | array | 逐条归属，**顺序与请求 `items` 严格一致** |
| `assignments[].cluster_id` | int | 簇编号；`-1` 表示噪声 |
| `warnings` | string[] | 本次运行的行为告警，见[行为告警](#行为告警) |
| `elapsed_ms` | int | 服务端耗时（毫秒） |

**响应中不包含评估指标**（ARI / NMI 等）——那些需要真实标签，只在 `tune` / `replay` 的
离线产物中出现。API 只返回分配结果。

#### 簇编号语义

- `cluster_id` 从 `0` 开始连续编号，`-1` 固定表示噪声。
- **编号在同一批次内有意义，跨运行不稳定**：同一批文本两次提交，簇的编号可能不同（内容划分也可能因算法随机性而变）。
- 每次请求**整批重新聚类**，不支持增量追加；拆成多批提交**不等价于**一次全量聚类。

#### 准入校验顺序

服务端按以下顺序快速失败，任一环节不通过即返回错误，**不会进入可能计费的嵌入阶段**：

1. `profile_id` 是否存在 → 否则 `404 PROFILE_NOT_FOUND`
2. profile 的算法是否在 API 白名单内 → 否则 `422 ALGORITHM_NOT_EXPOSED`
3. 请求体是否规范 → 否则 `422 INVALID_REQUEST`（pydantic 校验）
4. 样本数是否超过 `min(全局 max_samples, profile.max_samples)` → 否则 `422 INVALID_SAMPLE_COUNT`
5. `hdbscan` / `optics` 额外检查样本数是否 ≥ 邻域下限 → 否则 `422 INVALID_SAMPLE_COUNT`
6. 文本长度是否超过 `max_text_length` → 否则 `422 INVALID_TEXT`
7. 并发准入（单请求） → 否则 `429 SERVICE_BUSY`
8. 交给工作进程执行；期间检查知识库/模型 → 否则 `503`

> 第 3 步之前还有一层中间件：请求体超过 2 MiB 会在**读取过程中**立即中断，
> 返回 `413 REQUEST_TOO_LARGE`，不会先把整包读进内存再拒绝。

---

## 查询历史结果

### `GET /api/v1/clusterings/{run_id}`

按 `run_id` 取回历史结果，响应体结构**与提交时的 `201` 完全一致**。
读取时会做完整性校验：manifest 状态必须为 `completed`，且 `result.json` 的
SHA-256 必须与 manifest 中记录的一致。

```bash
curl -s http://127.0.0.1:8000/api/v1/clusterings/run_7d3f9a2b1c4e5f6089ab12cd34ef5678
```

**404** —— `run_id` 格式非法或结果不存在：

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "Result not found",
    "request_id": "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6"
  }
}
```

**500** —— 结果文件存在但完整性校验失败（被篡改或写入不完整）：

```json
{
  "error": {
    "code": "ARTIFACT_INVALID",
    "message": "Result integrity check failed",
    "request_id": "c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"
  }
}
```

> `run_id` 采用白名单正则校验（`run_[0-9a-f]{32}`），因此 `../` 之类的路径穿越
> 输入会直接被判为 404，不会触及文件系统。

---

## 错误处理

所有错误统一返回如下结构：

```json
{
  "error": {
    "code": "SERVICE_BUSY",
    "message": "A clustering request is already running",
    "request_id": "a9b8c7d6e5f40312233445566778899a"
  }
}
```

| 字段 | 说明 |
|---|---|
| `code` | **稳定的机器可读错误码**，用于分支判断，不会随文案变化 |
| `message` | 面向人的简短说明，**不含内部堆栈、路径与凭证** |
| `request_id` | 与响应头 `x-request-id` 一致，用于在服务端日志中检索同一次请求 |

三条保障：

- **兜底**：任何未预期异常都返回 `500 INTERNAL_ERROR`，绝不外泄堆栈或文件路径。
- **契约违规**：pydantic 的详细报错被统一收敛为 `422 INVALID_REQUEST`，不向外暴露内部字段结构。
- **request_id 必然存在**：中间件在请求进入时即分配，错误响应中也一定带回。

---

## 错误码表

### 4xx

| 错误码 | 状态 | 触发条件 | 处理建议 |
|---|---|---|---|
| `INVALID_REQUEST` | 422 | 请求体不符合契约（缺字段、多字段、类型错） | 对照[请求体](#请求体)逐字段检查 |
| `PROFILE_NOT_FOUND` | 404 | `profile_id` 不存在 | 拉取 `/api/v1/profiles` 获取有效 ID |
| `MODEL_NOT_FOUND` | 404 | profile 引用的模型未在 `models.toml` 定义 | 检查配置（通常属部署问题） |
| `RUN_NOT_FOUND` | 404 | `run_id` 格式非法或结果不存在 | 确认 ID 拼写与格式 |
| `INVALID_PROFILE` | 422 | profile 字段非法、算法参数违规、知识库标识非法 | 检查 `configs/profiles/` 下对应 JSON |
| `ALGORITHM_NOT_EXPOSED` | 422 | 该算法仅限 CLI（当前仅 `mean_shift`） | 改用其它 profile |
| `INVALID_SAMPLE_COUNT` | 422 | 样本数超上限，或少于算法邻域下限 | 调整 `items` 数量 |
| `INVALID_TEXT` | 422 | 文本空白或超过 `max_text_length` | 清洗输入文本 |
| `DUPLICATE_SAMPLE_ID` | 422 | 批内 `id` 重复 | 保证 `id` 唯一 |
| `INVALID_EMBEDDINGS` | 422 | 向量矩阵非有限值、行数或维度不匹配 | 通常为模型/缓存问题，查日志 |
| `INVALID_REDUCTION` | 422 | PCA 维度超过批次秩上限 | 减小 `pca_dim` 或增加样本 |
| `REQUEST_TOO_LARGE` | 413 | 请求体超过 2 MiB | 拆批提交，或调大 `max_body_bytes` |
| `SERVICE_BUSY` | 429 | 已有请求在执行（并发准入为单请求） | 退避重试，参见[并发与超时](#并发与超时) |

### 5xx

| 错误码 | 状态 | 触发条件 | 处理建议 |
|---|---|---|---|
| `MODEL_UNAVAILABLE` | 503 | provider 依赖缺失、本地权重缺失或校验和不符、远程模式凭证未配 | 检查 `models.toml`；本地模式跑一次 `model-manifest` 对齐校验和 |
| `ALGORITHM_UNAVAILABLE` | 503 | 算法依赖包未安装 | 安装对应可选依赖组 |
| `BACKEND_UNAVAILABLE` | 503 | 后端非 `python` | 仅支持冻结的 Python 后端 |
| `KNOWLEDGE_BASE_UNAVAILABLE` | 503 | 知识库缺失、未验证或不兼容 | 重新执行 `build-kb` |
| `CACHE_INVALID` | 503 | 嵌入缓存完整性校验失败 | 清理对应缓存条目 |
| `INVALID_NEIGHBORS` | 503 | 知识库返回的近邻不完整 | 检查知识库规模与 `n_results` |
| `WORKER_NOT_READY` | 503 | 工作进程预热中 | `/health/ready` 转 200 后重试 |
| `WORKER_UNAVAILABLE` | 503 | 工作进程启动失败、断连或响应非法 | 服务会自动重启工作进程，可重试 |
| `CLUSTERING_TIMEOUT` | 504 | 超过 `timeout_seconds` | 增大超时或减少样本量 |
| `EMBEDDING_PROVIDER_ERROR` | 502 | 远程嵌入服务请求失败 | 检查上游服务可用性 |
| `EMBEDDING_ORDER_INVALID` | 502 | 上游返回的向量行序错乱 | **数据可信度问题，勿盲目重试**，反馈上游 |
| `ARTIFACT_INVALID` | 500 | 结果文件完整性校验失败 | 检查磁盘与产物目录 |
| `INVALID_CLUSTER_OUTPUT` | 500 | 算法返回的标签非法 | 通常为算法实现问题 |
| `INTERNAL_ERROR` | 500 | 未预期的服务端异常 | 带上 `request_id` 查服务端日志 |

---

## 行为告警

`warnings` 字段用于告知调用方"本次结果的固有行为特征"。它们**不是错误**，
但会影响结果的解释方式。

| 告警 | 出现条件 | 含义 |
|---|---|---|
| `LEGACY_CW_LABEL_MAPPING` | 使用 `chinese_whispers` | 保留历史缺陷（cluster→members 被当作 sample→cluster），刻意不修 |
| `UNSEEDED_LEGACY_ALGORITHM` | 使用 `chinese_whispers` | 历史算法未固定随机种子 |
| `REMOTE_MODEL_REVISION_UNPINNED` | 模型 revision 缺失或为 `unversioned` | 远程模型版本无法锁定，结果可能漂移 |
| `HISTORICAL_EMBEDDINGS_NOT_VERIFIED` | profile 带 `source_result` 字段 | 向量源自历史实验，未逐位验证 |
| `LEGACY_SEPARATE_REDUCTION` | profile 的 `pca_dim > 0` | 融合后额外做了一次降维（历史行为，刻意保留） |

> **修复任何历史缺陷都必须新增实现或新增特征版本**，不得修改 `legacy-v1` /
> `legacy-radbscan-v1` 两条既有口径，否则历史摘要与论文图表都会失效。

---

## 并发与超时

### 并发模型：单请求串行

服务用**常驻 spawn 子进程**执行聚类，外层的准入锁是**非阻塞**的：

- 同一时刻**只允许一个**聚类请求在执行；
- 已有请求在执行时，新请求**立即**返回 `429 SERVICE_BUSY`，**不排队**（排队会拖垮延迟）。

调用方应实现**指数退避重试**，而不是立即重试或无限并发：

```
第 1 次失败 → 等 0.5s
第 2 次失败 → 等 1s
第 3 次失败 → 等 2s
...
上限 8s，最多重试 5 次；仍失败则上报
```

### 超时语义

| 阶段 | 计入的超时 |
|---|---|
| 等工作进程就绪 | 共享同一个 deadline |
| 发送请求 → 等待结果 | 使用**剩余时间**，不是重新计满 |

即**从进入到返回共享一个总 deadline**（`timeout_seconds`，默认 60s），绝不无限等待。
超时返回 `504 CLUSTERING_TIMEOUT`，同时服务会**销毁并重启**工作进程，
确保已超时的任务不会继续占用资源。

工作进程因崩溃而断连时，同样会销毁重启，并把结果翻译为 `503 WORKER_UNAVAILABLE`。
这两种情况下**都可以安全重试**。

---

## 部署与配置

### 启动

```bash
retrain-cluster --config configs/app.toml serve [--host H] [--port P]
```

`--host` / `--port` 未指定时取配置中的 `host` / `port`。

### 相关配置项

位于 `configs/app.toml` 的 `[app]` 段，括号内为对应的环境变量覆盖名：

| 键 | 默认 | 说明 | 环境变量 |
|---|---|---|---|
| `max_samples` | 300000 | 单次请求最大样本数 | `RETRAIN_MAX_SAMPLES` |
| `max_text_length` | 4000 | 单条文本最大字符数 | — |
| `max_body_bytes` | 209715200 | 请求体上限（200 MiB） | — |
| `timeout_seconds` | 60.0 | 单次聚类执行超时 | `RETRAIN_TIMEOUT_SECONDS` |
| `query_batch` | 64 | 检索分批大小 | — |
| `host` | `127.0.0.1` | 监听地址 | `RETRAIN_HOST` |
| `port` | 8000 | 监听端口 | `RETRAIN_PORT` |

配置优先级（后者覆盖前者）：**文件默认值 < 配置文件 < 环境变量 < 显式 overrides**。

> `max_text_length` 与 `max_body_bytes` **没有**环境变量覆盖入口，
> 如需调整请改配置文件。
>
> `max_text_length` 的**请求级**校验（route 层）在 pydantic 的
> `Item.text` 上限（4000）之后执行。若把 `max_text_length` 调到 4000 以上，
> 实际生效的仍是 pydantic 的 4000 硬上限。

### 模型加载

`configs/models.toml` **默认走本地加载**（`provider = "sentence_transformer"`，`device = "cpu"`），
不需要任何凭证。服务启动时以及每次 `GET /api/v1/profiles` 都会用 `file_checksums`
逐文件校验本地权重，任一文件缺失或被改动即报 `MODEL_UNAVAILABLE`。

首次准备（约 1.3 GB 权重）：

```bash
retrain-cluster download-model --source BAAI/bge-large-zh-v1.5 \
  --revision main --destination models/bge-large-zh-v1.5
retrain-cluster model-manifest --directory models/bge-large-zh-v1.5 \
  --output models/bge-large-zh-v1.5/manifest.json
# 再把 manifest.json 中的 file_checksums 内联进 configs/models.toml
```

### 凭证（仅远程模式需要）

切回远程嵌入服务（`provider = "openai_compatible"`）时，凭证**只走环境变量**
（如 `EMBEDDING_API_KEY`），不写进配置文件，也不出现在任何产物清单中——
`model_fingerprint` 会显式排除 `api_key_env`，因此改密钥名不会让缓存失效、
也不会把密钥名泄漏到产物里。

> 本地与远程产出的向量**不是逐位相同**的，切换后需重建嵌入缓存与知识库。

### 生产部署注意

- 服务**不含认证与 TLS**，对外暴露前请置于带鉴权的反向代理之后。
- 服务默认绑定 `127.0.0.1`，仅本机可访问。
- 单请求串行意味着**吞吐受限**；如需提高并发，应部署**多个实例 + 前置负载均衡**，
  而不是提高单实例并发。
- 产物写入 `artifacts_dir`（默认 `../artifacts`，相对于配置文件），
  需保证该目录可写且**多实例间不共享**（避免 `run_id` 目录冲突）。
- `/health/ready` 在模型加载完成前持续返回 503，请给就绪探针配置足够的
  `initialDelaySeconds` 与 `failureThreshold`。

---

## 客户端示例

### Python（requests）

```python
import time
import requests

BASE = "http://127.0.0.1:8000"


def cluster(items, profile_id, retries=5):
    """提交聚类，对 429/503/504 做指数退避重试。"""
    for attempt in range(retries):
        response = requests.post(
            f"{BASE}/api/v1/clusterings",
            json={"profile_id": profile_id, "items": items},
            timeout=120,
        )
        if response.status_code == 201:
            return response.json()
        if response.status_code in (429, 503, 504):
            time.sleep(min(0.5 * 2**attempt, 8))
            continue
        # 4xx 属调用方问题，重试无意义
        raise RuntimeError(f"{response.status_code} {response.json()['error']}")
    raise RuntimeError("重试耗尽")


items = [{"id": "r1", "text": "焊缝表面存在裂纹"}, {"id": "r2", "text": "管道接口渗漏"}]
result = cluster(items, "bge-large-agglomerative-nr0-legacy-v1")
print(result["run_id"], result["n_clusters"], result["n_noise"])
for a in result["assignments"]:
    print(a["id"], "->", a["cluster_id"])
```

### Python（httpx，同步）

```python
import httpx

with httpx.Client(base_url="http://127.0.0.1:8000", timeout=120) as client:
    if client.get("/health/ready").status_code != 200:
        raise SystemExit("工作进程尚未就绪")

    available = [
        p["profile_id"]
        for p in client.get("/api/v1/profiles").json()["profiles"]
        if p["available"]
    ]
    if not available:
        raise SystemExit("没有可用 profile（检查模型与凭证配置）")

    response = client.post(
        "/api/v1/clusterings",
        json={
            "profile_id": available[0],
            "items": [{"id": "1", "text": "第一条"}, {"id": "2", "text": "第二条"}],
        },
    )
    response.raise_for_status()
    data = response.json()
    print(response.headers["x-request-id"], data["n_clusters"])
```

### curl + jq

```bash
# 提交并提取 run_id 与 Location
LOCATION=$(curl -s -D - -o /tmp/resp.json -X POST http://127.0.0.1:8000/api/v1/clusterings \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"bge-large-dbscan-nr0-legacy-v1","items":[{"id":"a","text":"甲"},{"id":"b","text":"乙"}]}' \
  | grep -i '^location:' | tr -d '\r' | awk '{print $2}')

echo "结果地址: $LOCATION"
curl -s "http://127.0.0.1:8000$LOCATION" | jq '{n_clusters, n_noise, warnings}'
```

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [README.md](../../README.md) | 快速开始、数据准备、CLI 命令 |
| [architecture.md](../architecture.md) | 模型架构、数据流、分层与产物契约 |
| [refactoring/](../refactoring/README.md) | 重构背景与历史缺陷说明 |
