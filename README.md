# 核电工程隐患智能识别与定级系统（Demo）

**Nuclear Power Engineering Hazard Intelligent Identification & Grading System**

面向核电工程建设现场的 **AI 辅助** 安全隐患识别与 A/B/C/D 智能定级演示系统。上传工程现场图片后，系统通过多模态大模型识别隐患，结合「通用法规 / 核电专用标准 / 企业内部文件 / 历史相似案例」四类知识源，输出可追溯的隐患分析结果、定级依据与整改建议，并支持在原图上标注隐患区域。

> ⚠️ 本系统为 **AI 辅助判断** 工具，页面持续提示：**最终结果应由专业安全人员结合有效受控文件复核确认。**

---

## 一、核心能力

- **多模态图像识别**：0~10 条隐患候选，自动判断「未发现明确安全隐患」；
- **四类知识源 RAG**：通用标准、核电专用标准、企业文件、历史案例（keyword 检索，预留 `KnowledgeRetriever` 接口）；
- **Agent Runtime 显式工作流**：Preflight → Vision → RAG → Rules → Context → Reasoning → Validation → Result；
- **真实流式进度**：工作台通过 SSE 接收 run / step / tool / retrieval / cache / fallback 事件，不再使用前端假进度；
- **可观测与可追踪**：每次分析生成 conversation / session / task / run / trace ID，结果固化 workflow / prompt / rule / knowledge 版本与缓存、耗时指标；
- **Agent 上下文 Token 可观测**：按 Session → Agent → Turn → LLM Step 保存请求前不可变 Context Snapshot，并把六类 item 估算与 Provider actual usage、缓存、耗时和累计 Ledger 分开展示；支持当前构成、Step/Turn 趋势、stable-ID Diff 与原文明细；
- **A/B/C/D 隐患智能定级**：输出 `等级 + 定级理由 + 严重度/可能性/风险值`，风险值 = 严重度 × 可能性 辅助计算，机器风险规则守卫模型输出；
- **法规依据展示**：每一条引用均展示文件、编号、条款、原文与引用原因；
- **历史相似案例 TOP3**：相似度可视化 + 历史定级 + 历史整改措施；
- **原图 bbox 标注**：等级配色方框、编号标签、点击联动、隐藏标注、导出「隐患说明图」PNG；
- **目录导航**：`隐患发现 · 隐患识别 · 隐患管理 · 隐患测试 · 聚类分析 · 隐患防控 · 隐患知识库 · Token 统计 · 系统设置`，其余功能收纳为子菜单；
- **聚类分析（聚类展示 / 聚类测试）**：对隐患文本做无监督聚类，输出簇结构、关键词、代表样本与二维（PCA）散点分布；算法与向量化由独立的 Python 聚类服务（`cluster-engine`，11 种算法 / 20 个 profile / 本地 BGE 中文向量模型）提供，前端不做任何算法近似；「聚类测试」页可查看服务就绪状态、算法与 profile 可用性，并对同一批数据做多算法横向对比；
- **人工干预**：修改定级、编辑隐患描述、编辑整改建议（立即/整改/预防三类）；
- **隐患发现**：固定摄像头抓拍识别 + 具身智能机器人自动巡检（多点位画面分析、进度与结果汇总），一键转入隐患台账；
- **隐患防控**：隐患台账闭环管理（排查-登记-整改-复查-销号），支持来源、等级、状态流转、责任人/时限与台账导出；
- **定级规则库**：内置 A/B/C/D 分级规则 + 行业判定规则 **TXT / CSV 双格式导入**；导入规则会按正确的 a/b/c 业务 taxonomy 参与匹配与上下文注入，星标规则触发人工复核，不会被误映射为风险等级；
- **知识图谱**：定级规则**圆球（径向）知识图谱**——根球在圆心，子节点按层级分布同心环；**点击圆球展开 / 收回**对应子节点，带 +/− 标记、搜索自动展开命中路径并高亮、节点详情、滚轮缩放 / 全部展开与收回、**导出 PNG**；
- **结果管理**：保存到 localStorage、刷新恢复、隐患记录页、导出 HTML 报告（可打印 PDF）。

## 二、技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite 6 + 自研组件 / CSS 设计系统（桌面优先，蓝白企业风） |
| 后端 | Node.js + Express 5 + Multer（图片上传）+ Zod（Schema 校验） |
| 聚类服务 | Python 3.12 + FastAPI + scikit-learn / hdbscan / sentence-transformers（本地 BGE 向量模型）+ Pydantic（契约校验），算法层为内置的 `cluster-engine` |
| 模型 | 抽象 Multimodal Provider，默认 `OpenAI 兼容` 视觉接口（纯 fetch，无供应商 SDK） |
| 知识库 | 本地 JSON + 轻量关键词/类别加权检索（预留 ES / Milvus / pgvector 替换点） |

## 三、快速开始

```bash
npm install
npm run dev
```

- 前端：<http://localhost:5175>
- API：<http://localhost:3001>

打开页面后，先在「模型配置」中配置真实多模态模型，然后：
1. 点击「使用演示样例」载入任意一张内置演示图，或上传本地 JPG/JPEG/PNG/WebP 图片；
2. 点击「**AI 智能识别**」；
3. 查看识别结果、绘制标注、修改等级与整改建议、导出报告。

### 启用聚类分析（可选，独立 Python 服务）

聚类分析依赖独立的 Python 服务，未启动时**不影响**其余功能，聚类页面会明确提示「服务未就绪」。

```bash
# 1) 一次性准备 Python 环境（Python 3.12）
cd backend/python
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Linux/macOS 用 .venv/bin/pip

# 2) 回到项目根目录，一条命令同时拉起 Node API + Vite + Python 聚类服务
cd ../..
npm run dev:all
```

也可以只启动聚类服务：`npm run dev:py`（默认 `http://127.0.0.1:8000`）。

首次启动会校验本地向量模型（`backend/python/cluster-engine/models/bge-large-zh-v1.5`，约 1.3GB），需要数十秒；期间「聚类测试」页的状态会显示为不可用，点「重新校验」即可。

### 生产模式

```bash
npm run build     # 类型检查 + 前端构建到 dist/
npm start         # NODE_ENV=production，Express 同时托管 API 与静态页面
# 访问 http://localhost:3001
```

生产模式下 Express 会把 `/api/clustering/*` 转发到 Python 聚类服务（见 `server/http/clustering.routes.ts`），因此部署时同样需要单独运行该服务；目标地址可用 `PY_CLUSTER_URL` 覆盖。

## 四、环境变量

复制 `.env.example` 为 `.env` 并配置真实模型（未配置时无法进行识别）：

```env
# OpenAI 兼容多模态接口
MULTIMODAL_API_BASE_URL=https://api.example.com/v1
MULTIMODAL_API_KEY=
MULTIMODAL_MODEL=vision-model-name

# 可选
PORT=3001
MULTIMODAL_JSON_MODE=0        # 置 1 时请求 response_format=json_object（部分供应商支持）
MULTIMODAL_TIMEOUT_MS=120000  # 请求超时
MULTIMODAL_CONTEXT_WINDOW=    # 可选；模型 Context Window，未知留空
MULTIMODAL_INPUT_PRICE_PER_MILLION=   # 可选；实际输入每百万 Token 价格
MULTIMODAL_OUTPUT_PRICE_PER_MILLION=  # 可选；实际输出每百万 Token 价格
MULTIMODAL_CACHE_READ_PRICE_PER_MILLION=  # 可选；缓存读取价格
MULTIMODAL_CACHE_WRITE_PRICE_PER_MILLION= # 可选；缓存写入价格
MULTIMODAL_PRICE_CURRENCY=CNY
```

> **界面直填换模型，无需改文件**：打开「模型配置」，直接填写 API 地址、API Key 与模型名称并保存，立即生效；配置持久化到项目根 `.runtime-model.json`（已 gitignore）。支持测试连接、切换配置及恢复 `.env` 默认。
>
> **颜色主题**：顶栏「主题」按钮或「系统设置 → 颜色主题」切换 5 套 Apple 风格主题（经典蓝 / 海洋青 / 石墨灰 / 能量绿 / 深空深色），选择持久化到浏览器。

### 聚类服务相关变量

聚类服务有自己的一层配置（`backend/python`，前缀 `HAZARD_`，可用 `.env` 或环境变量覆盖），Node 侧只需一个转发地址：

| 变量 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PY_CLUSTER_URL` | Node 进程 | `http://127.0.0.1:8000` | Express 生产模式下转发 `/api/clustering/*` 的目标地址 |
| `VITE_PY_CLUSTER_TARGET` | 构建期 | `http://127.0.0.1:8000` | 开发模式 Vite 代理目标 |
| `PY_CLUSTER_PORT` / `PY_CLUSTER_HOST` | `npm run dev:py` | `8000` / `127.0.0.1` | Python 服务监听地址 |
| `HAZARD_TIMEOUT_SECONDS` | Python | `120` | 单次聚类的墙钟超时，超过返回 504 |
| `HAZARD_UPLOAD_MAX_BYTES` | Python | `10485760` | 上传数据文件大小上限 |
| `HAZARD_DEFAULT_PROFILE_ID` | Python | 空 | 指定默认 profile；留空则由网关自动挑选 |
| `HAZARD_CORS_ORIGINS` | Python | `5175 / 3001` 本地来源 | 直连（不经代理）调试时的允许来源，逗号分隔 |

> 前端**不硬编码**任何 Python 地址：开发走 Vite 代理、生产走 Express 转发，两条路径都只暴露同源 `/api/clustering/*`。

### GitHub OAuth 2.0 登录

1. 在 GitHub **Settings → Developer settings → OAuth Apps → New OAuth App** 创建应用；
2. 开发环境填写 Homepage URL `http://localhost:5175`，Authorization callback URL `http://localhost:5175/api/auth/github/callback`；
3. 在 `.env` 配置以下值并重启服务：

```env
GITHUB_OAUTH_CLIENT_ID=你的Client ID
GITHUB_OAUTH_CLIENT_SECRET=你的Client Secret
SESSION_SECRET=至少32字符的高强度随机字符串
APP_BASE_URL=http://localhost:5175
```

配置生效后，未登录访问会停留在独立登录页；登录成功后才会挂载工作台。除 `/api/auth/*` 外的业务 API 同样要求有效会话，不能通过绕过前端直接调用。服务端使用 Authorization Code + PKCE，登录只申请 `read:user`；Client Secret 和用户 access token 不会发送到前端。生产环境请把 Homepage、callback 与 `APP_BASE_URL` 一并改为 HTTPS 正式域名。

## 五、运行模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| **AI 模式** | auto 下 `MULTIMODAL_API_KEY` 已配置，或显式选择 AI | 真实调用多模态模型完成 Agent 工作流 |

系统仅支持真实模型识别。未配置模型时返回配置错误；视觉模型调用失败时报告错误，不再返回内置演示识别结果。无 Key 的内网网关可在「模型配置」中显式选择 AI 模式。

> 多模态 Provider 已抽象为 `MultimodalModelProvider`（`vision / chat / healthCheck`），位于 `server/providers/`，可扩展任意 OpenAI 兼容或自研视觉服务。

## 六、项目结构

```text
nuclear-hazard-demo/
├── shared/                  # 前后端共享：类型 / 分级定义 / 报告 HTML 生成
│   ├── types.ts
│   ├── agent-protocol.ts
│   ├── grading-meta.ts
│   ├── clustering.ts        # 聚类接口契约（与 Python Pydantic 逐字段对齐）
│   └── report.ts
├── server/
│   ├── index.ts             # Express API（analyze/standards/cases/export/model/rules 等）
│   ├── agent/               # Agent Runtime：状态机、Context/Cache/Memory、Tools、Trace、Hazard Workflow
│   ├── pipeline.ts          # 旧调用兼容门面，内部转 Agent Runtime
│   ├── lib/                 # .env 加载 / Zod Schema / 系统 Prompt
│   ├── http/                # 路由层；clustering.routes.ts 为 Python 聚类服务的反向代理
│   ├── retrieval/           # 标准与历史案例检索（KnowledgeRetriever）
│   ├── grading/             # A/B/C/D 定级规则与护栏
│   ├── rules/               # 判定规则 TXT/CSV 解析与持久化
│   ├── providers/           # 多模态 Provider：openai-compatible + 工厂
│   └── data/                # 知识库 JSON + 规则演示样本（sample_rules.txt / sample_rules.csv）
├── backend/python/          # Python 聚类服务（独立进程，非主项目运行时依赖）
│   ├── app/                 # 网关：契约(schemas) / 服务(services) / 路由(api) / 预处理(processors)
│   ├── cluster-engine/      # 聚类引擎：11 种算法、20 个 profile、本地 BGE 向量模型、Optuna 调参
│   ├── samples/             # 内置示例数据（由 scripts/build_sample_dataset.py 从真实隐患抽样生成）
│   ├── scripts/             # 离线脚本（示例数据构建等）
│   └── tests/               # pytest（单元测试 + 默认跳过的 integration 端到端）
├── web/
│   ├── pages/               # 智能识别 / 隐患发现 / 隐患防控 / 定级规则 / 知识图谱 / 知识库 / 记录 / 设置 / 聚类展示 / 聚类测试
│   ├── components/          # ImagePanel、ImageAnnotator、HazardCard、EvidenceDrawer、ClusterScatter…
│   ├── lib/                 # API 客户端、localStorage（记录/台账/主题）、发现设备源、图谱布局、图片工具、hash 路由
│   ├── api/                 # 领域接口客户端（clustering.ts 等，统一拆封 success/data/error）
│   └── styles.css           # 设计系统 + 多主题
├── scripts/clustering/      # 跨平台 Python 启动/测试入口（py.mjs）
├── index.html
├── vite.config.ts
├── tsconfig.json
└── .env.example
```

## 七、核心接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/analyze` | `multipart/form-data`：`image=<file>`（可选 `scenario=<id>`）→ `AnalysisResult` |
| `POST /api/agent/runs/stream` | `multipart/form-data` 创建 Agent run，以 SSE 返回真实 workflow 事件与最终结果 |
| `GET /api/agent/runs/:runId` / `GET /api/agent/runs/:runId/events` | 查询 run 状态/结果与补取事件 |
| `GET /api/agent/traces/:traceId` | 查询本进程内 trace、step、tool、retrieval、cache 与 fallback 记录（Demo） |
| `GET /api/agent/runs/:runId/token-usage` | 查询单 Run 的聚合及每一次 LLM Call usage |
| `GET /api/agent/sessions/:sessionId/token-usage` / `GET /api/agent/conversations/:conversationId/token-usage` | Session / Conversation 累计 Token Usage |
| `GET /api/agent/token-usage?conversationId=&sessionId=` | Token 统计页面所需三级总览 |
| `GET /api/agent/context-observability?conversationId=&sessionId=` | Agent / Turn / LLM Step 上下文统计总览（不含大段 item 原文） |
| `GET /api/agent/context-observability/steps/:stepId` | 按需读取历史 Step 的完整不可变 Context Snapshot |
| `GET /api/agent/context-observability/export/:sessionId` | 导出可解析 Session Context Log |
| `GET /api/standards?type=` | 标准知识库列表（general / nuclear / enterprise） |
| `GET /api/cases?q=&category=&grade=` | 历史案例检索 |
| `POST /api/export` | 接收 `{ analysis }`，返回自包含 HTML 报告 |
| `GET /api/model` / `POST /api/model-config` / `POST /api/model-config/reset` | 模型信息 / 保存运行期配置 / 恢复 .env 默认 |
| `GET /api/rules` / `POST /api/rules/import` / `POST /api/rules/import-demo` / `POST /api/rules/import-demo-csv` / `POST /api/rules/clear` | 判定规则库查询 / TXT·CSV 导入 / 载入 TXT 演示样本 / 载入 CSV 演示样本 / 清空 |
| `GET /api/health-check` | Provider 连通性测试 |
| `GET /api/clustering/health` | 聚类服务健康检查：统一包裹，`data.engine` 报告引擎与本地向量模型就绪状态（顶层另有 `status` 供探针读取） |
| `GET /api/clustering/profiles` | 可用 profile 列表（20 个 profile 的算法、模型、样本上限与不可用原因）；`?refresh=true` 强制重新校验 |
| `GET /api/clustering/algorithms` | 引擎暴露的聚类算法及其依赖可用性 |
| `GET /api/clustering/sample` | 内置示例数据（真实核电工程隐患抽样 50 条） |
| `POST /api/clustering/datasets` | `multipart/form-data`：`file=<CSV/XLSX/JSON/TXT>` → 解析为聚类样本（自动识别文本列、ID 去重、文本清洗） |
| `POST /api/clustering/run` | 执行一次聚类 → 统计 + 簇摘要（关键词/代表样本/元数据分布）+ 逐条归属 + 二维 PCA 坐标 |
| `GET /api/health` | Python 聚类服务的探针（与 `/api/clustering/health` 同源路由，便于规范与前端代理各取所需） |

## 八、API 数据结构要点

- 图片识别结果：结构化 JSON（`AnalysisResult`），每条隐患包含
  `title / category / description / confidence / bbox(0~1 归一化) / evidence / possibleConsequence / grade / gradeReason / severityScore / probabilityScore / riskScore / standardReferences / historicalReferences / rectification / manualReviewRequired`；
- v2 结果新增可选 `ruleReferences` 与 `agentMeta`，旧浏览器记录仍可兼容；
- bbox 使用 **0~1 归一化坐标**，前端按原图比例绘制方框；
- 模型输出一律经 **Zod 校验 + 容错**，无效数据不得进入前端；
- 全部拟引用法规/条款/案例均为**从知识库检索的真实条目**，推理层只允许按 key 引用，禁止编造。

## 九、数据声明

> **项目内法规、企业制度与历史案例均属于演示 Mock 数据，不代表任何真实核电项目的正式受控文件。**
> 生产使用前必须替换为经过审核且有效的企业法规标准库，并接入真实历史案例库、对 AI 定级建立专业人员复核与签字流程。

所有页面与导出报告均带有上述声明提示。

## 十、聚类分析模块

### 1. 架构与职责边界

聚类能力**不在 TypeScript 里重写**，而是原样复用已有的 Python 聚类引擎，由一层很薄的 FastAPI 网关把它包装成本项目的接口契约：

```text
web/pages/Clustering*.tsx
  → web/api/clustering.ts            （同源 /api/clustering/*，统一拆封 success/data/error）
    → Vite 代理（开发） / Express 转发（生产）
      → backend/python/app           （FastAPI 网关：契约校验、文件解析、结果加工）
        → backend/python/cluster-engine（算法、向量化、检索增强、降维 —— 唯一算法来源）
```

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| 前端页面 / 客户端 | 取数、渲染、交互、错误提示 | 不复现任何聚类或向量化逻辑 |
| FastAPI 网关 | 契约校验、上传解析、调用引擎、把结果加工成「统计 / 簇摘要 / 二维坐标」 | 不实现算法、不调超参 |
| cluster-engine | 向量化、特征融合、11 种聚类算法、Optuna 调参、产物落盘 | 不关心本项目的页面与文案 |

二维坐标（PCA）与簇摘要（代表样本 / c-TF-IDF 关键词 / 元数据分布）明确标注为**展示辅助**，不参与聚类决策 —— 簇划分与噪声判定完全以引擎输出为准。

### 2. 算法与配置档

引擎内置 11 种聚类算法，其中 10 种通过 API 暴露（`mean_shift` 仅 CLI）：

`agglomerative`、`hdbscan`、`radbscan`、`optics`、`affinity_propagation`、`dbscan`、`chinese_whispers`、`birch`、`leader`、`canopy`（+ CLI-only `mean_shift`）。

每个算法各有「纯向量（nr0）」与「检索增强（nr1，先用 ChromaDB 检索近邻再融合特征）」两类 profile，共 20 个。前端可选「自动选择」，由网关按「纯向量优先 + 算法偏好顺序」挑一个当前可执行的 profile；也可显式指定 `algorithm` 或 `profileId`。**参数由 profile 决定**，网关不虚构 `n_clusters` 之类的超参。

### 3. 两个页面的分工

| 页面 | 路由 | 面向 | 内容 |
| --- | --- | --- | --- |
| 聚类展示 | `/clustering/overview` | 演示 / 汇报 | 一键对示例或上传数据聚类；统计卡、二维散点图（可点击图例高亮簇）、簇卡片（关键词 / 元数据分布 / 代表样本）、样本归属明细与详情抽屉 |
| 聚类测试 | `/clustering/test` | 工程验证 | 服务与引擎就绪状态、算法与 profile 可用性清单、手工输入小批量文本做冒烟测试、单次运行逐条结果 + CSV 导出、**多算法横向对比**（簇数 / 噪声 / 耗时 / 向量缓存） |

两页共享 `web/lib/useClusterEngine.ts`（只读元信息），各自独立持有执行状态；簇颜色由 `web/lib/clusterColor.ts` 按 `cluster_id` 稳定分配，保证散点图、图例、卡片、表格同色。

### 4. 接口约定

- 所有接口返回统一包裹 `{ success, data, error }`；失败时 `error` 含 `code`（如 `UNSUPPORTED_FILE`、`PROFILE_UNAVAILABLE`、`SERVICE_BUSY`、`CLUSTERING_TIMEOUT`）与面向用户的中文 `message`，前端只需一套错误分支；
- Python 内部字段为 snake_case，对外统一序列化为 camelCase（Pydantic `alias_generator`），与 `shared/clustering.ts` 逐字段一致，前端不做任何键名转换；
- 网关为**单飞**模式：同一时刻只允许一个聚类请求进入引擎，其余请求返回 429，避免 CPU/内存被打满；
- 数据上限：单次 ≤ 500 条样本、单条文本 ≤ 4000 字符、上传文件 ≤ 10 MB；聚类墙钟超时默认 120 秒。

### 5. 运行与测试

```bash
npm run dev:py    # 仅启动 Python 聚类服务
npm run test:py   # 运行 Python 单元测试（integration 默认跳过）
npm run test:py -- -m integration   # 端到端（需本地向量模型，会真实跑一次聚类）
npm run typecheck # 前端与 Node 侧类型检查
npm run build     # 类型检查 + 构建
```

`backend/python/tests/` 覆盖：契约（camelCase 双向兼容、强校验、自由字典键名不被改写）、文本清洗、CSV/JSON/TXT/XLSX 解析（含 GBK、BOM、损坏文件）、簇摘要（分组、置信度归一、代表样本、元数据分布、长度不一致报错）、示例数据与上传解析、以及端到端接口。

### 6. 来源与数据声明

- 聚类算法层来自既有的 Python 聚类工程（`retrain-cluster`），迁移为本项目的 `backend/python/cluster-engine`，**未重写算法**；网关与其契约层为本次新增；
- 内置示例数据由 `backend/python/scripts/build_sample_dataset.py` 从本仓库的隐患抽样 CSV 生成（50 条，含隐患级别 / 分类 / 排查类型 / 作业区域等业务字段），仅用于演示；
- 聚类结果为**无监督的统计分组**，簇标签（`类别 0`、`类别 1`…）不代表任何业务语义或定级结论，需人工解读。

## 十一、Roadmap（可选增强）

- 替换 `KnowledgeRetriever` 为 BM25 / 向量检索（Elasticsearch、Milvus、pgvector）；
- 接入企业受控标准库与版本有效性校验；
- 隐患记录对接整改闭环系统与审批流；
- 多图对比、视频抽帧识别等。

完整的现状审计、Agent Runtime/Workflow、Context Cache、Memory/RAG/Rules/Tools、SSE、可观测性与迁移设计见 [`docs/架构设计/Agent运行时与工作流架构设计.md`](docs/架构设计/Agent运行时与工作流架构设计.md)；更多文档见 [`docs/README.md`](docs/README.md)。

---

*演示工程 · 仅供技术交流与产品原型演示使用*
