# AorticAI — Codex Instructions

## 项目简介
AorticAI = 基于 CTA 的结构性心脏手术规划平台，核心是主动脉根部数字孪生模型，支持 TAVI / VSRR / PEARS 手术规划。

---

## 技术栈
- **Runtime**: Cloudflare Workers (edge, no server)
- **Frontend**: Vanilla TS + Cornerstone.js (MPR) + Three.js (3D mesh)；`main.ts` 已拆 shell 子模块，持续瘦身中
- **Build**: `node scripts/build_workstation.mjs` → `wrangler deploy`
- **Imaging**: NIfTI volume loader (`cornerstone-nifti`)
- **Data**: JSON artifacts + STL meshes (R2/远端), case_manifest.json 为唯一真相
- **API layer**: `services/api/` — contracts.ts 定义所有类型
- **i18n**: `apps/web/src/i18n/` (en.ts / zh-CN.ts)
- **Schema**: `schemas/` — JSON Schema 权威定义
- **Test**: `npm run test:unit` / `npm run test:schema`
- **Deploy**: `npm run deploy` (build + wrangler deploy)

---

## 目录结构
```
/
├── apps/web/src/          # 前端工作站
│   ├── main.ts            # 入口 & renderShell()（持续瘦身中）
│   ├── shell/             # HTML/DOM/template 子模块（PR #3 拆出）
│   ├── styles.css         # 全局样式（单一:root设计令牌）
│   └── i18n/              # 双语
├── cases/default_clinical_case/
│   ├── artifacts/         # JSON: measurements, planning, model
│   ├── imaging_hidden/    # NIfTI 体数据（.nii.gz）
│   ├── meshes/            # STL文件
│   └── qa/                # 质量门
├── services/api/          # API 层
│   ├── contracts.ts       # 类型定义（核心）
│   ├── defaultCaseHandlers.ts
│   └── defaultCaseStore.ts
├── gpu_provider/          # GPU 节点（Python pipeline + geometry）
│   └── geometry/          # STL 生成：root_model / leaflet_model / lumen_mesh / landmarks
├── schemas/               # JSON Schema
├── src/index.ts           # Cloudflare Worker 入口
├── scripts/               # 构建/部署脚本
├── migrations/            # D1 数据库迁移
├── tests/                 # 单元测试 + E2E
├── docs/                  # 架构文档（见索引）
└── archive/               # 归档（不读）— 含旧 frontend、bat、colab
```

---

## 常用文件路径
| 用途 | 路径 |
|------|------|
| 工作站 HTML 结构 | `apps/web/src/main.ts` → `renderShell()` |
| Shell 壳层（HTML 辅助） | `apps/web/src/shell/html.ts` |
| Shell 壳层（DOM 句柄登记） | `apps/web/src/shell/dom.ts` |
| Shell 壳层（静态模板） | `apps/web/src/shell/template.ts` |
| 全局样式 | `apps/web/src/styles.css` |
| API 类型定义 | `services/api/contracts.ts` |
| 默认病例 manifest | `cases/default_clinical_case/artifacts/case_manifest.json` |
| 测试 CTA 体数据 | `cases/default_clinical_case/imaging_hidden/ct_showcase_root_roi.nii.gz` |
| 测量结果 | `cases/default_clinical_case/artifacts/measurements.json` |
| 规划结果 | `cases/default_clinical_case/artifacts/planning.json` |
| STL 生成：根部/升主 | `gpu_provider/geometry/root_model.py`, `lumen_mesh.py` |
| STL 生成：瓣叶 | `gpu_provider/geometry/leaflet_model.py` |
| 地标检测 | `gpu_provider/geometry/landmarks.py`, `coronary_detection.py` |
| 测量算法 | `gpu_provider/geometry/measurements.py` |
| Worker 入口 | `src/index.ts` |
| 构建脚本 | `scripts/build_workstation.mjs` |

---

## 文档索引
- `docs/SYSTEM_ARCHITECTURE.md` — 系统架构图与数据流
- `docs/UI_UX_SPEC_ZH_EN.md` — UI/UX 规范与术语
- `docs/REFACTOR_LOG.md` — 前端重构日志（PR 分批记录）
- `ROADMAP.md` — 完整开发路线图
- `TASKS_PHASE1.md` — Phase 1 任务表（无需 VPS）
- `docs/SECURITY_PRIVACY.md` — 安全与隐私规范
- `docs/CLINICAL_WORKFLOW_MAPPING.md` — 临床工作流映射
- `docs/EXECUTIVE_SUMMARY.md` — 执行摘要
- `docs/FAILURE_MODES_AND_TESTS.md` — 失败模式与测试覆盖

---

## 排除目录
`node_modules` · `dist` · `.git` · `build` · `/archive` · `.venv` · `runs` · `data` · `output`

---

## 生产地址
- Worker: `https://heartvalvepro.edu.kg`
- GPU API: `https://api.heartvalvepro.edu.kg`

---

## 当前进度快照（2026-04-20）→ 2026-04-22 更新

> ⚠ **诚实对账**：以下两栏分开看。"能 demo 的"只是屏幕上跑起来不等于临床可用。

### 能 demo 的（仅演示，未达临床标准）
- 默认病例 pipeline 跑通，annulus/sinus/STJ 数值能渲染到前端
- UI 布局、Workflow step tabs、键盘快捷键、Boot progress bar
- 前端 shell 拆分（PR #3）：html.ts / dom.ts / template.ts

### ✅ Phase B2b 已完成（2026-04-22）
- **ImageCAS case 1** 通过 SCCT 2021 TAVI sizing gate
  - slice_thickness=0.5mm, blood_pool=315HU, fov=193mm ✅
  - aortic_root=216K tris, ascending_aorta=49K tris ✅
  - PR #1 等待 merge: https://github.com/AdamsYi/aortic-ai2026/pull/1
- **自动化远程同步** — `git_sync` 命令 + bat 改进，不再需要手动 git 干预

### 进行中（临床可用的硬缺口）
- **MPR 临床工作流缺失**：没有真正的 Cornerstone3D `CrosshairsTool` 联动（当前只是 CSS 假十字线），没有 `ReferenceLines`，没有 Slab MIP / 可调 slab thickness，`ProbeTool` 已挂但 HU 读数未暴露到 footer
- **多病例支持缺失**：仅 1 例 ImageCAS，需要≥3 例验证 pipeline 稳健性

### P0 任务（必须严格按顺序）
1. ~~**数据层**：接 Zenodo TAVI dataset~~ → **已完成**（ImageCAS case 1 green，PR #1 pending merge）
2. ~~**Geometry 层**：提高 STL 分辨率~~ → **已完成**（root 216K tris, ascending 49K tris）
3. **MPR 临床工作流**：`CrosshairsTool` + `ReferenceLines` 替换 CSS 假十字线；三视窗支持 Slab MIP + slab thickness 滑块；Probe footer 暴露 HU 读数
4. **多病例扩展**：ingest ImageCAS case 2-10，验证 pipeline 稳健性

### 架构决策记录
- **CF Tunnel** — 用于远程控制 GPU 机器（未部署，计划中）
- **Planning 层分离** — planning rules 在 Workers 端跑，GPU 只做 CTA→model
- **数据真相** — case_manifest.json 是唯一真相，但 measurements.json / planning.json 之间可能不一致（已发现过 d17c320 bug）
- **UI 主题** — 淡色临床主题方向（2026-04-14 提出，参考 3mensio 白底 + 医疗蓝强调色）；**pending：优先级让位于数据层 + MPR 临床工作流**，下一次会话不要在此消耗上下文

---

## Codex 工作规范（核心约束）
1. **先读相关文件**再动手，不猜测
2. **只做被要求的事**，不做额外重构
3. 所有测量值必须有 `evidence` + `uncertainty`
4. **数据资产质量门（临床安全红线）**：所有 CTA / STL / manifest 必须带质量元信息（slice_thickness、is_cropped、contrast_phase、tri_count、non_manifold_edges 等）；质量不达标时 UI 必须**显式拒绝**进入 sizing 工作流并给出红色警告，不允许静默降级、不允许显示 "Real CT pipeline output ✅" 绿标
5. `case_manifest.json` 是默认病例唯一真相来源
6. 完成后必须汇报：做了什么 / 遇到什么问题 / 下一步建议
7. **UI 验收标准** — 用临床专家视角审视截图，不允许残留浅/深色混合
