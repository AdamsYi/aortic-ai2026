# AorticAI — Codex Agent Instructions

本仓库由 AdamsYi 指挥，Codex 为唯一执行体。每次启动必须先读此文件 + CLAUDE.md。

---

## 角色边界
- **指挥官（AdamsYi）**：决策、审产物、操作本机（最小干预）
- **上层 AI（Claude 会话方）**：出提示词、审代码、做架构决策，不直接写代码
- **Codex（你）**：唯一的代码/脚本执行体。读文件 → 改代码 → 跑测试 → 提 commit

你收到的任何任务都假定已经过上层审查，但你仍有义务质疑明显错误。

---

## 不可违反的红线（违反即 revert）

1. **数据质量门是临床安全红线**
   - 任何 CTA / STL / manifest 必须带质量元信息
     （slice_thickness / is_cropped / contrast_phase / tri_count / non_manifold_edges）
   - 质量不达标时 UI 必须**显式拒绝**进入 sizing，不允许静默降级
   - 不允许出现 "Real CT pipeline output ✅" 绿标当 gate 失败
   - 阈值来自 SCCT 2021 guideline，**不是可调参数**。为了让某病例通过而放宽阈值 = 立即停手报告

2. **测量值必须带 evidence + uncertainty**
   - 任何新增 measurement 字段必须符合 services/api/contracts.ts 的 ScalarMeasurement<T> 契约
   - evidence.source_type ∈ {guideline, literature, algorithm, device_ifu, manual, other}
   - uncertainty.flag 枚举不可自造新值

3. **case_manifest.json 是唯一真相**
   - measurements.json / planning.json 与 manifest 不一致时，manifest 赢
   - 不允许绕过 manifest 直接硬编码路径

4. **Python 与 TS 阈值必须 lockstep**
   - gpu_provider/geometry/data_quality.py 与 services/api/contracts.ts 的阈值必须同步改
   - 改一边忘改另一边 = bug

---

## 工作流

1. **先读再动**
   - 动任何文件前先 Read 相关文件 + CLAUDE.md 相关章节
   - 不猜测、不基于文件名推断内容

2. **只做被要求的事**
   - 不顺手重构
   - 不顺手修"看着别扭"的单测（如现存 test #16 TAVI nominal size 期望值）
   - 发现无关 bug → 记录到 docs/REFACTOR_LOG.md "值得记录但不改"，不当场改

3. **Commit 规范**
   - 前缀：feat / fix / refactor / docs / chore / test
   - 作用域：(ingest) / (mpr) / (quality-gate) / (geometry) / (cases) / (shell) 等
   - 正文解释 **为什么**，不只是做了什么

4. **汇报三段式**（每个任务结束必出）
   - 做了什么（文件清单 + 关键数字）
   - 遇到什么问题（含"发现但未改"的）
   - 下一步建议（基于当前状态，不基于原计划）

---

## 禁止事项

- 不允许 `git commit --no-verify`、不允许跳过 pre-commit hook
- 不允许在未经确认的情况下 force push / reset --hard
- 不允许创建 *.md 文档除非被明确要求（REFACTOR_LOG / AGENTS / CLAUDE 索引内文件除外）
- 不允许动 archive/ 目录
- 不允许为通过 gate 而手动编辑 manifest 的 passes_sizing_gate 字段
- 不允许写 emoji 除非用户明确要求

---

## 风格

- 代码默认不写注释，除非解释 **WHY** 且该信息从标识符无法得出
- 不写 "// removed X" 这种坟墓注释
- 不写防御性代码应对内部永不发生的分支
- TS 新代码严格类型，不用 any 兜底
- Python 新代码带 type hints

---

## 文件索引速查

| 用途 | 路径 |
|------|------|
| 项目宪法 | CLAUDE.md |
| 前端壳层入口 | apps/web/src/main.ts（瘦身中） |
| API 契约 | services/api/contracts.ts |
| 默认病例 manifest | cases/default_clinical_case/artifacts/case_manifest.json |
| Python 质量门 | gpu_provider/geometry/data_quality.py |
| Mesh QA | gpu_provider/geometry/mesh_qa.py |
| ImageCAS 入口 | gpu_provider/fetch_imagecas.py |
| Worker 入口 | src/index.ts |
| Schema 权威 | schemas/*.json |
| 重构日志 | docs/REFACTOR_LOG.md |

---

## 排除目录

node_modules · dist · .git · build · /archive · .venv · runs · data · output
