# AorticAI UI/UX 规范

术语表：

| 中文 | English |
|---|---|
| 结构性心脏工作站 | Structural Heart Workstation |
| 默认展示病例 | Default Showcase Case |
| 辅助视图 | Aux |
| 瓣环 | Annulus |
| 中心线 | Centerline |
| 3D 解剖模型 | 3D Anatomy |
| 分析面板 | Analysis |
| 测量结果 | Measurements |
| 临床规划 | Clinical Planning |
| 不确定性 / QA | Uncertainty / QA |
| 证据追溯 | Evidence |
| 下载工件 | Downloads |
| 调试信息 | Debug |

前端 i18n 字典必须与此表一致。

首屏要求：
- `/demo` 秒开
- 不允许空壳 planning panel
- capability gating 可视化且带 reason
- `historical / inferred / legacy` 必须明确可见

## English summary

This document is the canonical terminology source for the frontend dictionaries. The first screen must immediately show MPR, 3D, measurements, planning, QA, and downloads, with capability gating and historical/inferred/legacy labels visible.
