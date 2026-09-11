# cjc-article-v5.3 — 最小可编译项目

从 `D:\paper\sp_zh\cjc-article-v5.3.tex` 抽离的最小可运行项目。
正文为单文件自包含（图表均为 TikZ/PGFPlots 代码内嵌），仅需同目录下的辅助文件即可完整编译出 PDF。

## 文件清单

| 文件 | 作用 |
|---|---|
| `cjc-article-v5.3.tex` | 论文主文件（正文） |
| `CjC.cls` | 《计算机学报》投稿模板文档类 |
| `ctex.sty` / `captionhack.sty` / `gbt7714.sty` | 本地宏包（与模板配套的覆盖/补丁版本） |
| `picins.sty` / `flushend.sty` | 模板类所需宏包（`flushend.sty` 为桩文件） |
| `gbt7714-numerical.bst` | 参考文献样式（GB/T 7714 数字制） |
| `ref.bib` | 参考文献数据库 |
| `fig_spear_framework_v2.tikz` | 图：SPEAR 总体框架（`\input` 引入） |
| `fig_purification_pipeline_v2.tikz` | 图：语义净化流程（`\input` 引入） |
| `fig_tpe_optimization_v3.tikz` | 图：TPE 优化流程（`\input` 引入） |
| `pgfdata/` | PGFPlots 统计图所需 16 个 `.dat` 数据文件 |

> 注意：以上本地文件必须与主文件**同目录**，否则编译会回退到系统宏包版本或直接报错。
> 无需任何外部图片/字体文件；正文使用系统字体 Times New Roman（Windows 自带）。

## 编译方式（XeLaTeX）

在项目目录下依次执行：

```
xelatex -interaction=nonstopmode cjc-article-v5.3.tex
bibtex  cjc-article-v5.3
xelatex -interaction=nonstopmode cjc-article-v5.3.tex
xelatex -interaction=nonstopmode cjc-article-v5.3.tex
```

或在 Windows 上直接双击运行 `build.bat`（需 xelatex/bibtex 已加入 PATH），
编译完成后 PDF 输出为 `cjc-article-v5.3.pdf`。

## 环境要求

- TeX Live（含 xelatex、bibtex），Windows 上已验证 TeX Live 2026 可正常编译
- Windows 系统字体 Times New Roman（`\setmainfont{Times New Roman}`）
- 中文字体由 ctex 默认方案提供
