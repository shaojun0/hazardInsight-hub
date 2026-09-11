# 当前项目结构与问题分析

## 业务目标

对核电工程质量巡检、偏差记录中的未知问题类别进行无监督分组。记录包含工程编号、时空信息和专名，论文将这些视为距离结构的干扰来源。标签用于超参数选择与评估，不作为编码器或聚类器输入。

## 原始工程结构

源码共有 25 个 Python 文件，约 4,321 行。根目录混合实验入口、图表、分析和环境兼容脚本；`optimizer/` 有精简与完整两套实现；`evaluator/` 包含复合评分；`utils/` 同时承担网络模型调用和指标计算；`bak/` 包含仍有参考价值的本地模型入口与包装器。

`main.py`：远程 BGE-large 编码、缓存、知识库、单算法 TPE、外部测试。
`run_all_algos.py`：同样的数据流程，比较十算法的 nr0 / nr-1，保存 trial/best/test。
`optimizer/cluster_optimizer_full.py`：十一算法，包含仅 CLI 保留的 MeanShift。
`analysis_data.py`、`hot.py`、`distance.py`、`svd_analysis.py`、`plot_clusters.py`：不同年代、不同参数和路径的分析分支。

## 实际数据流

```text
reference.json → 按键顺序取文本 → one-hot argmax → 调参集 X,y
labels.json → 按类别顺序 flatten → 测试集 X_test,y_test + 类别名映射
database.txt → read().split("\n") → 知识库向量 → HNSW(l2)

原始向量 X → top-k 检索 → 每个样本单独 np.mean → R
nr0: Z=X；nr-1: Z=βX+(1−β)R
Z → 可选历史降维 → fit_predict → 非噪声样本指标 + 全量噪声比例
调参集 TPE → best params → 测试集独立重新 fit_predict
```

数据盘点：reference 3,103 条、93 类；test 20,198 条、353 类，20,196 个不同文本；二者重叠 1,506 个不同文本。知识库按当前读法有 18,170 行、17,927 个不同字符串，含 1 个空行。知识库来源的 LLM 净化过程不在当前仓库。

## 问题、影响和处理

下列行号指 `baseline-manifest.json` 记录的重构前版本。旧入口现在加了函数封装，行号会移动；算法和评估器原文件未移动。

| ID | 证据 | 影响 | 本次处理 / 后续验收 |
|---|---|---|---|
| E01 | main.py:35–84、run_all_algos.py:101–167 | 导入就读文件、联网、建库 | 已加显式入口；测试禁止导入期间访问业务输入与网络 |
| E02 | main.py:74–81 | 冷启动覆盖训练 embeddings；目录不存在可能更早失败 | 旧路径隔离保存，新 Service 使用独立局部变量；不修改旧结果 |
| E03 | 两个 optimizer 模块的 estimate/_inference | 特征、检索、搜索、聚类耦合且重复 | 新包分离，旧文件作为回归对照保留 |
| E04 | main.py:101–105、run_all_algos.py:183 | best_params 不含固定参数，测试可能遗漏参数 | 新实验导出 sampled 与 resolved 两份参数，明确历史实际执行设置 |
| E05 | utils/cache.py、array_hash | 拼接文本边界冲突；模型、shape、dtype 不入键 | SHA-256 结构化指纹、清单和校验和 |
| E06 | run_all_algos.py:154、193 | 目录/结果文件存在即跳过，没有内容与版本校验 | 新知识库完成状态、模型绑定及内容校验；每次独立 run |
| E07 | main.py:23、run_all_algos.py:66 | 硬编码真实凭证 | 已改环境变量，旧快照也脱敏；账号方需撤销暴露凭证 |
| E08 | compat_sqlite.py:14–19 | 固定 Linux .so 导致平台耦合 | 仅 Linux 且显式指定库时预加载，默认检查 SQLite 版本 |
| E09 | README、requirements、pyproject | 入口、评分、依赖和默认行为不一致 | 文档重写；可选依赖组；旧锁文件已有版本不升级 |
| E10 | cluster_optimizer_full.py:762–764 | CW 将 cluster→members 错当 sample→cluster | 保留 legacy-v1，并返回 LEGACY_CW_LABEL_MAPPING 警示 |
| E11 | RADBSCAN _inference、其他算法降维 | 两路单独拟合后融合，RAD 额外降维 | 显式历史流程版本；k/PCA 多分支回归 |
| E12 | analysis_data.py:95、134–135、221–235 | KB 哈希路径不同、维度错误、可视化方法不同 | 隔离旧脚本，新图只读新实验产物；独立纠错不覆盖论文图 |

## 指标口径

有效簇数排除 -1。ARI/NMI/VM/FMS/AMI/HS/CS 在非噪声样本上计算。CCA=min(Kpred,Ktrue)/max(Kpred,Ktrue)。score=0.4ARI+0.3NMI+0.1VM+0.1CCA+0.1(1-noise)。有效簇少于 2 时 score=-1 且缺少其他指标。`min_noise_ratio` 等构造参数当前没有实际影响评分，兼容版本不赋予新含义。

## 结果来源

`output/` Agglomerative ARI 0.1543418489→0.2830101702，簇数 270→208。
`output_bge_large/` Agglomerative ARI 0.1543418489→0.2808186055，簇数 270→198。

两个目录属于不同运行，不互相覆盖。315 类 `labels_v2.json` 和重标注报告不替换当前 353 类测试输入。
