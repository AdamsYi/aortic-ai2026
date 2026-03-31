# AorticAI — 完整开发路线图

> 指挥官用于规划，Codex 用于了解全局。每个阶段完成后由指挥官验收，再解锁下一阶段。

---

## 全局阶段概览

```
Phase 1  本地工作站 UI + 数据      ← 已完成
Phase 2  Cloudflare Worker 生产环境 ← 已通过 Worker 替代完成
Phase 3  Pipeline + 多病例          ← 当前重点
Phase 4  临床算法深度               ← 持续迭代
```

---

## Phase 1：本地工作站（已完成）

**目标：** 打开本地 dev server，直接看到一个像 3mensio 一样的临床工作站，展示完整的默认病例。

### 1A — 工作站 UI 核心（Codex Sprint 1，已完成）
- TASK-001: MPR 四格视图 (Axial / Coronal / Sagittal / 3D) ✅
- TASK-002: 测量值面板（带置信度颜色编码） ✅
- TASK-003: 手术规划面板（TAVI / VSRR / PEARS tabs） ✅
- TASK-004: 3D STL 查看器升级（图层/透明度/截图） ✅

### 1B — 数据完整性（Codex Sprint 2，已完成）
- TASK-005: 完善 measurements.json（消灭 PLACEHOLDER_ONLY） ✅
- TASK-006: 完善 planning.json（真实 TAVI 规划结构） ✅
- TASK-007: Annulus Plane 可视化（3D + MPR 叠加） ✅

### 1C — 系统体验（Codex Sprint 3，已完成）
- TASK-008: 启动加载页 + 错误处理 ✅
- TASK-009: 病例信息头部栏 ✅
- TASK-010: PDF 报告内嵌查看器 ✅

**验收标准：** 本地运行后，任何人打开页面，5秒内看到完整工作站，无空白面板，无 placeholder 数据。

---

## Phase 2：生产部署（已由 Cloudflare Worker 替代完成）

**目标：** 把工作站部署到公网，任何人可以通过 URL 访问。

### 2A — 生产基础环境（已完成）
- TASK-011: 生产入口改为 Cloudflare Worker 直出静态前端 ✅
- TASK-012: HTTPS 通过 Cloudflare 域名接入完成 ✅
- TASK-013: Cloudflare Worker 生产部署（`wrangler deploy`） ✅
- TASK-014: 前端静态资源由 Worker assets 直接分发 ✅

### 2B — 自动更新系统（Sprint 4-6，已完成）
- TASK-015: GitHub Actions CI/CD pipeline ✅
  - push to main → 自动构建 → 自动部署到 VPS
- TASK-016: 版本号自动注入（`build_version` 字段） ✅
- TASK-017: 健康检查接口 `GET /health` ✅

### 2C — 安全与访问控制（Sprint 6，已完成）
- TASK-018: 简单访问密码（单密钥，不做完整 auth 系统） ✅
- TASK-019: CORS 配置（只允许指定域名） ✅
- TASK-020: 敏感文件保护（CT 文件不可直接 URL 访问） ✅

**验收标准：** 通过公网 URL 打开工作站，体验与本地一致，HTTPS，无报错。当前生产地址：`https://heartvalvepro.edu.kg`

---

## Phase 3：Pipeline + 多病例（VPS 稳定后）

**目标：** 系统能管理多个病例，有完整的 pipeline 追踪，可以从 GPU 节点接收新病例。

### 3A — Study Repository
- TASK-021: 病例列表页（study list，像 PACS 一样）
- TASK-022: 病例选择 → 进入工作站
- TASK-023: 病例元数据管理（患者ID匿名化、扫描日期、状态）

### 3B — Pipeline 追踪
- TASK-024: PipelineRun 记录接口（每次分析写入追踪日志）
- TASK-025: 病例状态追踪：`pending → running → completed → review_required`
- TASK-026: Artifact 版本管理（同一病例多次运行的结果对比）

### 3C — GPU 节点对接
- TASK-027: GPU 节点推送 artifact 的接口（POST /cases/{id}/artifacts）
- TASK-028: Windows GPU 节点部署脚本
- TASK-029: GPU → VPS 的安全认证（API Key）

**验收标准：** 上传一个新病例 JSON bundle，系统正确入库并可在工作站查看。

---

## Phase 4：临床算法深度（持续迭代）

**目标：** 解决当前已知的核心临床算法问题，让系统从 demo 级别升级到临床可信级别。

### 4A — 冠脉开口检测（P0 问题）
- TASK-030: 冠脉开口检测算法稳定化
- TASK-031: 检测置信度评分系统（基于几何特征）
- TASK-032: 低置信度时的 fallback UI（手动标注辅助模式）

### 4B — 瓣叶几何（P0 问题）
- TASK-033: 三叶独立几何派生（从 AorticRootComputationalModel）
- TASK-034: 瓣叶对合高度（coaptation height）计算
- TASK-035: 瓣叶形态分类（正常/增厚/钙化标记）

### 4C — Centerline 稳定性（P1 问题）
- TASK-036: Centerline 质量评分（平滑度、完整性检查）
- TASK-037: Centerline 异常检测 + 自动修复
- TASK-038: CPR（曲面重建）视图基于 centerline 实现

### 4D — 手术模拟
- TASK-039: TAVI 瓣膜植入模拟（几何叠加，不做有限元）
- TASK-040: 覆盖/遮挡风险可视化（coronary occlusion risk map）
- TASK-041: VSRR 管道尺寸验证模拟

**验收标准：** 对10个真实病例（去识别化）运行，冠脉检测成功率 >90%，无明显几何错误。

---

## 技术债务清理（穿插在各阶段）

| 文件 | 问题 | 建议处理 |
|------|------|---------|
| `apps/web/src/legacyPlanning.ts` | 遗留规划逻辑 | Phase 1C 完成后迁移或删除 |
| `tmp_online_demo_probe.mjs` | 临时调试脚本 | Phase 2 前评估后删除 |
| `tmp_showcase_ct_validate.mjs` | 临时验证脚本 | Phase 2 前评估后删除 |
| `src/index.ts`（278KB） | 过大，难以维护 | Phase 3 时拆分模块 |

---

*路线图版本：1.0*
*创建：2026-03-31*
