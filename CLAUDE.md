# AorticAI — Codex Instructions

## 项目简介
AorticAI = 基于 CTA 的结构性心脏手术规划平台，核心是主动脉根部数字孪生模型，支持 TAVI / VSRR / PEARS 手术规划。

---

## 技术栈
- **Runtime**: Cloudflare Workers (edge, no server)
- **Frontend**: Vanilla TS + Cornerstone.js (MPR) + Three.js (3D mesh)
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
│   ├── main.ts            # 入口 & renderShell()（~6400行）
│   ├── styles.css         # 全局样式（单一:root设计令牌）
│   └── i18n/              # 双语
├── cases/default_clinical_case/
│   ├── artifacts/         # JSON: measurements, planning, model
│   ├── meshes/            # STL文件
│   └── qa/                # 质量门
├── services/api/          # API 层
│   ├── contracts.ts       # 类型定义（核心）
│   ├── defaultCaseHandlers.ts
│   └── defaultCaseStore.ts
├── gpu_provider/          # GPU 节点（Python pipeline + geometry）
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
| 全局样式 | `apps/web/src/styles.css` |
| API 类型定义 | `services/api/contracts.ts` |
| 默认病例 manifest | `cases/default_clinical_case/artifacts/case_manifest.json` |
| 测量结果 | `cases/default_clinical_case/artifacts/measurements.json` |
| 规划结果 | `cases/default_clinical_case/artifacts/planning.json` |
| Worker 入口 | `src/index.ts` |
| 构建脚本 | `scripts/build_workstation.mjs` |

---

## 文档索引
- `docs/SYSTEM_ARCHITECTURE.md` — 系统架构图与数据流
- `docs/UI_UX_SPEC_ZH_EN.md` — UI/UX 规范与术语
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

## Codex 工作规范（核心约束）
1. **先读相关文件**再动手，不猜测
2. **只做被要求的事**，不做额外重构
3. 所有测量值必须有 `evidence` + `uncertainty`
4. `case_manifest.json` 是默认病例唯一真相来源
5. 完成后必须汇报：做了什么 / 遇到什么问题 / 下一步建议
