# Docker 一键部署文档（演示 v4）

核电工程隐患智能识别与定级系统的离线 Docker 部署说明。镜像包位于 `D:\datas\images\智能识别和定级\演示-v4`，包含网页/API 与 Python 聚类两份镜像的离线归档（含本地 BGE 语义模型），目标电脑**无需安装 Node.js、Python，也无需联网下载模型**。

---

## 1. 部署前准备

### 1.1 硬件要求

| 项目 | 最低要求 |
|---|---|
| CPU | Intel / AMD x86_64（镜像为 linux/amd64） |
| 内存 | 16 GB（Docker 至少分配 8 GB） |
| 磁盘 | 预留 15 GB 以上空闲空间 |
| 网络 | 部署本身不需要联网；仅「图片 AI 识别」功能需能访问模型 API |

### 1.2 软件要求

- Windows 10/11（64 位）或 macOS / Linux。
- **Docker Desktop**（Windows 需切换到 Linux containers 模式），且已启用 Compose v2（Docker Desktop 自带）。
  下载地址：<https://www.docker.com/products/docker-desktop/>
- 不需要安装 Node.js、Python 或任何开发环境。

### 1.3 演示包内容清单

将整个 `演示-v4` 文件夹复制到演示电脑本地磁盘（**不要只拷单个文件**，脚本按目录结构工作）。文件夹内文件如下：

| 文件 | 作用 |
|---|---|
| `hazard-demo-v4.tar` | 两份镜像的离线归档（约 1.4 GB，含本地聚类模型） |
| `images.json` | 镜像 tag、镜像 ID、归档 SHA256、构建时间 |
| `images.sha256` | 归档文件校验值（供 `sha256sum -c` 使用） |
| `compose.yaml` | 两套服务的编排与健康检查配置 |
| `启动演示.bat` / `start.bat` | Windows 一键启动入口 |
| `start.ps1` | 实际启动脚本（由 bat 调用，支持 `-Port` 参数） |
| `停止演示.bat` / `stop.bat` | 停止服务 |
| `logs.bat` | 查看服务日志 |
| `start.sh` / `stop.sh` | macOS / Linux 启动与停止 |
| `data/` | 首次启动自动创建，存放模型配置、导入规则、聚类作业 |
| `启动说明.md`、`验证记录.md` | 原始说明与验证记录 |

镜像信息（构建于 2026-09-13）：

| 镜像 Tag | 说明 |
|---|---|
| `nuclear-hazard-demo:demo-v4` | 网页 + API 服务（Node.js，端口 3001） |
| `nuclear-hazard-clustering:demo-v4` | Python 聚类引擎（FastAPI，容器内端口 8000，不对外暴露） |

---

## 2. 安装并启动 Docker Desktop（Windows）

如果演示电脑已装好 Docker Desktop 并能正常运行，跳过本节。

1. 双击下载的 `Docker Desktop Installer.exe` 安装，安装时保持默认（启用 WSL 2 后端）。
2. 安装完成后启动 Docker Desktop（开始菜单 → Docker Desktop）。
3. 等待右下角鲸鱼图标变为稳定状态（引擎运行中）。
4. 确认使用 **Linux containers** 模式：右键任务栏鲸鱼图标，若显示「Switch to Windows containers...」即为 Linux 模式（正确）；若显示「Switch to Linux containers...」请点击切换。
5. （建议）设置 → Resources → Memory 调整到 **8 GB 以上**。
6. 验证：打开 PowerShell 执行 `docker version`，能看到 Server 版本号即就绪。

> 注：启动脚本本身也会自动拉起 Docker Desktop 并等待就绪，此步骤手动做一遍只是更稳妥。

---

## 3. 一键启动（Windows）

1. 确认整个 `演示-v4` 文件夹已在本地磁盘（例如 `D:\datas\images\智能识别和定级\演示-v4`）。
2. **双击 `启动演示.bat`**（或 `start.bat`）。脚本会依次自动完成：
   1. 检查 Docker 命令与引擎是否就绪（未启动则自动拉起 Docker Desktop 并等待，最长 3 分钟）；
   2. 校验是否已切换到 Linux containers 模式；
   3. 对比 `images.json` 中两个镜像的 tag 与 ID —— 若本机已存在且一致则跳过导入；否则校验 `hazard-demo-v4.tar` 的 SHA256 后执行 `docker load` 导入（约 1.4 GB，需数分钟）；
   4. 创建 `data/`、`data/jobs`、`data/engine` 目录及初始配置文件；
   5. `docker compose up -d --wait` 启动两个服务并等待健康检查通过（超时 10 分钟）；
   6. 请求 `http://localhost:3001/api/model` 确认 API 正常；
   7. 打印绿色的 `Demo is ready: http://localhost:3001` 并自动打开浏览器。
3. 看到浏览器打开系统首页即部署成功。

> macOS / Linux 用户：在文件夹内执行 `bash start.sh`，流程相同。

### 首次导入较慢是正常现象

`docker load` 解压 1.4 GB 归档 + 聚类服务首次加载本地 BGE 模型，整体可能需要 5–10 分钟。脚本窗口会显示进度，请勿中途关闭。

---

## 4. 验证部署

任选以下方式确认：

1. **浏览器**：访问 <http://localhost:3001>，能打开系统首页。
2. **API 健康检查**：浏览器或 curl 访问 `http://localhost:3001/api/model`，返回 JSON 即正常。
3. **容器状态**（在演示包文件夹打开终端执行）：

   ```bat
   docker compose ps
   ```

   `app` 与 `clustering` 两个服务的 STATUS 应为 `Up (healthy)`。

4. **快速功能自检**：进入「聚类展示」或「聚类测试」页面，用内置 50 条样例跑一次语义聚类（本机验证约 63 秒，目标电脑耗时可能不同）。

---

## 5. 演示前配置（可选）

- **图片 AI 识别**：在「模型配置」页面填写视觉模型的 Base URL、API Key、模型名，测试连通后保存。此功能需访问模型 API 的网络；包内不携带任何 API Key。
- 聚类展示 / 聚类测试使用镜像内置的 BGE 中文模型，**断网可用**。

---

## 6. 日常操作

在演示包文件夹内执行（或直接双击对应 bat）：

| 操作 | 命令 / 入口 | 说明 |
|---|---|---|
| 查看日志 | 双击 `logs.bat`（即 `docker compose logs --tail 100 -f`） | Ctrl+C 退出跟踪 |
| 停止服务 | 双击 `停止演示.bat`（即 `docker compose stop`） | 不删除数据 |
| 再次启动 | 双击 `启动演示.bat` | 镜像已存在会跳过导入，秒级进入启动流程 |
| 彻底移除容器 | `docker compose down` | 数据仍在 `data/` 目录 |
| 查看容器状态 | `docker compose ps` | — |

### 更换端口

默认端口 3001 被占用时，在该文件夹打开终端执行：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Port 3014
```

然后访问 <http://localhost:3014>。端口范围 1024–65535。

---

## 7. 数据与持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| 模型配置、导入规则 | `data/.runtime-model.json`、`data/.rules-imported.json` | 挂载进容器，停止/重启不丢失 |
| 聚类作业产物 | `data/jobs/`、`data/engine/` | 同上 |
| 识别历史等前端数据 | 浏览器 localStorage | **换电脑/浏览器/端口不迁移**，需要时先从页面导出 |

⚠️ 配置 API Key 后 `data/.runtime-model.json` 会包含该 Key，请自行保管演示包文件夹。

---

## 8. 常见问题排查

| 现象 | 处理 |
|---|---|
| 提示找不到 docker 命令 | 未安装 Docker Desktop 或未加入 PATH；安装后重新双击启动脚本 |
| 启动卡在 "Waiting for Docker Desktop..." | 手动启动 Docker Desktop；确认其为 Linux containers 模式；磁盘空间不足也会导致引擎起不来 |
| 启动超时 / healthcheck 失败 | 双击 `logs.bat` 查看日志；检查 Docker 内存分配（≥8 GB）与磁盘剩余空间 |
| 端口被占用 | 用上节命令换端口启动，如 `-Port 3014` |
| 归档校验失败（checksum mismatch） | 归档拷贝不完整或损坏，重新完整复制整个 `演示-v4` 文件夹 |
| Apple Silicon Mac | 需 Docker 的 amd64 模拟，速度与兼容性未验证，建议用 x86 电脑 |
| 聚类运行很慢 | 聚类为 CPU 运行，先用内置 50 条数据演示；大规模任务耗时取决于机器性能 |

---

## 9. 附录：服务编排说明

`compose.yaml` 定义两个服务（项目名 `hazard-demo-v4`）：

- **app**（`nuclear-hazard-demo:demo-v4`）：Node.js 网页 + API。仅向本机回环地址暴露 `${DEMO_PORT:-3001}:3001`，不对局域网开放。健康检查探测 `/api/model`，依赖 clustering 就绪后启动。
- **clustering**（`nuclear-hazard-clustering:demo-v4`）：Python FastAPI 聚类引擎。不对外暴露端口，仅容器网络内供 app 通过 `PY_CLUSTER_URL=http://clustering:8000` 访问。健康检查探测 `/api/health`，启动等待期 60 秒。

两个镜像均为 `pull_policy: never`，编排只会使用本地已导入的镜像，不会联网拉取。

如需重新制作演示包，使用仓库内 `deploy/demo-v4/package.ps1`（已构建好镜像时可加 `-SkipBuild`）；日常演示不需要。

---

## 10. 维护

- 本文档位于仓库 `docs/部署/Docker一键部署文档.md`，已在 `docs/README.md` 登记。
- 演示包内的 `启动说明.md` 与本文档内容一致，面向演示操作者；本文档额外覆盖了安装 Docker 的完整前置步骤。
