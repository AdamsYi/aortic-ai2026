# AorticAI — Commander Instructions for Codex

> **你的角色：** 你是执行者（Codex）。这份文件是指挥官给你的命令。每次你收到任务，先读这份文件，确保你的行动符合这里的原则和架构。完成任务后必须向指挥官汇报：做了什么、遇到什么问题、下一步建议。

---

## 项目本质（一句话定义，永远不要忘记）

**AorticAI = Structural Heart Planning + Digital Twin Platform (based on CTA)**

这不是一个 AI 影像工具，不是一个分割工具，不是一个3D展示网站。
这是一个**结构性心脏手术规划系统**，核心是从 CTA 构建主动脉根部数字孪生模型，用于 TAVI、VSRR、PEARS 手术的测量、规划、模拟和决策支持。

---

## 核心数据对象（The Single Source of Truth）

所有工作都围绕一个核心对象：

```
AorticRootComputationalModel
```

这是系统的"数字孪生核心"。系统流程必须是：

```
CTA
  → segmentation (GPU-only)
  → centerline extraction
  → anatomical landmark detection
  → AorticRootComputationalModel  ← 这是核心，所有下游必须从这里派生
      → measurements (annulus, STJ, sinus, coronary height, leaflet geometry)
      → planning (TAVI sizing, VSRR sizing, PEARS parameters)
      → simulation
      → artifacts (STL, JSON, PDF report)
          → services/api
              → apps/web workstation
```

**绝对禁止：** 任何测量、规划结果直接从CT切片上读取，不经过解剖模型。

---

## 系统最终形态（用户体验目标）

用户打开系统的体验应该像打开 **3mensio**：

- 打开网站/应用 → 已经加载一个完整病例
- 可以直接查看解剖、测量结果、手术规划、3D模型
- **不需要** 上传CT、等待计算、跑模型、配置环境

这个"完整病例"的标准是什么？系统必须已经包含：

| # | 数据项 | 状态要求 |
|---|--------|---------|
| 1 | CTA 分割结果 | 完成，储存为 artifact |
| 2 | Centerline | 完成，JSON格式 |
| 3 | 主动脉根部解剖模型 | 完成，aortic_root_model.json |
| 4 | 瓣环平面 (Annulus plane) | 完成，annulus_plane.json |
| 5 | STJ 定位 | 完成，在 model 内 |
| 6 | 窦部 (Sinus) 几何 | 完成 |
| 7 | 冠脉开口 (Coronary ostia) | 完成，高置信度 |
| 8 | 瓣叶几何 (Leaflet geometry) | 完成，三叶独立 |
| 9 | 所有测量值 | 完成，measurements.json |
| 10 | 手术规划结果 | 完成，planning.json |
| 11 | STL meshes | 完成，aortic_root/leaflets/ascending_aorta |
| 12 | PDF 报告 | 完成 |

---

## 当前系统关键问题（开发优先级排序）

以下问题按严重程度排序，所有工作必须以解决这些核心问题为导向，不做无关的界面小修改：

### P0 — 阻塞性问题（必须先解决）
1. **冠脉开口检测不稳定** — 这是最关键的临床安全问题。检测失败或低置信度时必须有明确的 `DETECTION_FAILED` 标记和 `clinician_review_required: true`
2. **瓣叶几何不可信** — 三叶独立几何（leaflet_L/R/N）必须从解剖模型正确派生，不能是占位符

### P1 — 核心功能缺失
3. **Centerline 仍需稳定化** — 当前已有 centerline 输出，但质量评分、异常检测、自动修复仍未完成，所有测量（coronary height等）依赖它
4. **前端工作站已具备基础 MPR，但 CPR / double-oblique 仍缺失** — 生产站点已上线，下一步重点是把临床视图能力补齐

### P2 — 系统成熟度
5. **整体看起来像 Demo 而不是临床工具** — 所有 `PLACEHOLDER_ONLY` 和 `NOT_AVAILABLE` 的字段必须逐步被真实数据替换

---

## 工程原则（不可违反）

### 用户体验约束
- 用户**不能**跑命令行
- 用户**不能**手动部署
- 系统必须**一键启动 / 自动更新**
- Mac 本地**不保存** CT / STL / 大文件（这些在云端或 GPU 节点）

### 计算架构约束
- GPU 节点（Windows）：只负责分割 (segmentation)
- CPU / 云端：几何计算、测量、规划、模拟
- `services/api` 层提供所有数据接口
- Cloudflare Worker 作为 adapter 层

### 生产地址
- Worker: `https://heartvalvepro.edu.kg`
- GPU: `https://api.heartvalvepro.edu.kg`

### 数据完整性约束
- `case_manifest.json` 是默认病例的唯一真相来源
- `planning.json` 是规划 artifact 的专用文件
- 每个病例必须可追踪 pipeline 版本和生成过程（`PipelineRun` 类型已定义）
- 每个测量值必须有 `evidence` + `uncertainty` + `UncertaintyFlag`

### 质量门约束
- 解剖合理性检查不是硬门槛而是分层临床判断：
  - `Normal` / `Borderline` / `Review Required` / `Not Assessable` / `Failed`
  - 只有明显自相矛盾或无法支持结论时才进入 Failed
- 所有临床结论必须有 evidence 溯源

---

## 现有代码结构（必须了解）

```
/
├── apps/web/              # 前端工作站 (showcase workstation)
│   └── src/
│       ├── main.ts        # 入口
│       ├── styles.css
│       └── i18n/          # 中英文双语 (en.ts, zh-CN.ts)
├── cases/
│   └── default_clinical_case/   # 默认病例（完整示范病例）
│       ├── artifacts/     # JSON artifacts
│       ├── meshes/        # STL文件
│       ├── qa/            # 质量门和失败标记
│       └── reports/       # PDF报告
├── schemas/               # JSON Schema 定义（所有数据结构的权威定义）
├── services/api/          # API层
│   ├── contracts.ts       # 类型定义（核心）
│   ├── defaultCaseHandlers.ts
│   └── defaultCaseStore.ts
├── src/
│   ├── index.ts           # Worker入口
│   └── generated/         # 构建生成的bundle
├── scripts/               # 构建脚本
├── tests/                 # 测试套件
└── docs/                  # 架构文档
```

### 关键类型（来自 services/api/contracts.ts）

```typescript
// 测量值必须携带的结构
ScalarMeasurement<T> = {
  value: T | null,
  unit: string,
  evidence: Evidence,        // 必须说明来源
  uncertainty: Uncertainty   // 必须标记置信度
}

// 不确定性标记枚举
UncertaintyFlag =
  "NONE" | "MISSING_INPUT" | "DETECTION_FAILED" | "LOW_CONFIDENCE" |
  "ANATOMY_CONSTRAINT_VIOLATION" | "OUT_OF_RANGE" |
  "IMAGE_QUALITY_LIMITATION" | "MODEL_INCONSISTENCY" |
  "PLACEHOLDER_ONLY" | "NOT_AVAILABLE"

// Pipeline追踪
PipelineRun = {
  source_mode: "stored" | "inferred" | "legacy",
  pipeline_version, build_version, provider_target, ...
}
```

---

## 对标系统（了解边界）

| 系统 | 主要功能 | AorticAI 的目标 |
|------|---------|----------------|
| 3mensio | TAVI规划 | 在自动化、数字孪生上超越 |
| Circle CVI | 心脏影像分析 | 聚焦主动脉根部深度 |
| Mimics | 工程建模 | 更好的临床决策支持 |

AorticAI 的差异化：**VSRR 和 PEARS 规划支持**（现有商业软件基本不做这块）

---

## Codex 工作规范

### 接受任务时必须做的
1. **先读这份 CLAUDE.md**，确认任务符合项目方向
2. **读相关文件**再动手，不猜测现有代码逻辑
3. **只做被要求的事**，不做额外的"改进"、重构、加注释
4. **保持类型安全**，所有新数据字段必须有对应的 Schema/Type 定义

### 完成任务后必须汇报
汇报格式：
```
## 完成汇报

**任务：** [任务描述]
**完成状态：** ✅ 完成 / ⚠️ 部分完成 / ❌ 阻塞

**做了什么：**
- [文件路径:行号] [改了什么]

**遇到的问题：**
- [具体问题]

**发现的风险/隐患：**
- [如果有]

**建议下一步：**
- [具体建议]
```

### 绝对禁止
- 直接在 CT 切片上做测量（必须经过解剖模型）
- 在没有 `evidence` 和 `uncertainty` 的情况下输出测量值
- 删除现有的质量门检查
- 绕过 `case_manifest.json` 直接读取 artifact 文件作为 summary 来源
- 用 `PLACEHOLDER_ONLY` 替代真实计算（除非是临时过渡，必须标注）
- 在没有 `clinician_review_required` 标记的情况下输出冠脉开口相关的低置信度结果

---

*最后更新：2026-03-31*
*指挥官：项目负责人*
*执行者：Codex*
