# AorticAI — Phase 1 任务表（无需 VPS）

> **执行者（Codex）阅读须知：**
> - 这是指挥官分配的 Phase 1 任务，全部可在本地完成，不需要 VPS、不需要 GPU
> - 每完成一个任务，在对应条目后面标注 ✅ 并汇报
> - 优先级从上到下，P0 最高
> - 执行前必须先读 `CLAUDE.md` 了解全局原则

---

## P0 — 工作站核心 UI（最重要，直接影响演示价值）

### TASK-001：实现真正的三视图布局（MPR Layout） ✅

**目标：** 把现有的单视口布局升级为临床标准的四格/三格布局

**具体要求：**
- 布局方案：`[轴位 Axial | 冠状 Coronal] / [矢状 Sagittal | 3D STL]`
- 每个视口独立可操作（缩放、平移、窗宽窗位）
- 视口间有十字准线联动（crosshair sync）
- 切换按钮：`2x2` / `1+3` / `全屏单视口`
- 样式要求：参考现有 `styles.css` 的 dark theme，不要改颜色系统

**文件位置：**
- `apps/web/src/main.ts` — 主要改动区
- `apps/web/src/styles.css` — 布局样式

**注意：** Cornerstone.js 已经引入，直接用其 `RenderingEngine` + `synchronizers` 实现联动，不要引入新的影像库。

---

### TASK-002：测量值面板（Measurements Panel） ✅

**目标：** 右侧面板展示所有解剖测量值，数据来自 `measurements.json`

**UI 要求：**
- 分区展示：`瓣环 (Annulus)` / `STJ` / `窦部 (Sinus)` / `冠脉 (Coronary)` / `瓣叶 (Leaflet)`
- 每个测量值显示：数值 + 单位 + 置信度指示器（颜色编码）
  - `NONE` → 绿色
  - `LOW_CONFIDENCE` / `BORDERLINE` → 黄色警告图标
  - `DETECTION_FAILED` / `PLACEHOLDER_ONLY` → 红色 + `⚠ Review Required`
  - `NOT_AVAILABLE` → 灰色虚线
- `clinician_review_required: true` 的字段必须有红色边框高亮
- 双语支持：中英文切换（用现有 i18n 系统）

**数据来源：**
- `cases/default_clinical_case/artifacts/measurements.json`
- 类型定义：`services/api/contracts.ts` 中的 `ScalarMeasurement`

**禁止：** 不要 hardcode 测量值，必须从 JSON 动态读取。

---

### TASK-003：手术规划面板（Planning Panel） ✅

**目标：** 展示 TAVI / VSRR / PEARS 规划结果

**UI 要求：**
- Tab 切换：`TAVI` | `VSRR` | `PEARS`
- TAVI 面板：
  - 推荐瓣膜尺寸（主要 + 备选）
  - 推荐入路（股动脉/经心尖/经主动脉）
  - 危险因素警告（冠脉遮挡风险、annulus 破裂风险）
  - Implant depth 建议
- VSRR 面板（David / Yacoub 术式）：
  - 推荐管道尺寸
  - 瓣环/STJ 直径
  - 重要几何比值
- PEARS 面板：
  - 外支撑装置参数建议
  - 主动脉根部顺应性估算
- 每个推荐值必须有 `evidence` 说明（悬停 tooltip 显示来源）

**数据来源：**
- `cases/default_clinical_case/artifacts/planning.json`

---

### TASK-004：3D 交互查看器升级 ✅

**目标：** 升级现有 THREE.js STL 查看器

**具体要求：**
- 加载所有可用 mesh：`aortic_root.stl` + `leaflets.stl` + `ascending_aorta.stl` + `annulus_ring.stl`
- 每个 mesh 独立控制显示/隐藏（图层面板）
- 每个 mesh 独立控制透明度（0-100% 滑块）
- 颜色方案：
  - 主动脉根部 → 半透明红 `rgba(220,80,80,0.6)`
  - 瓣叶 → 半透明米白 `rgba(240,230,200,0.8)`
  - 升主动脉 → 半透明粉 `rgba(220,150,150,0.4)`
  - 瓣环环 → 亮绿线框 `#5ee6b0`
- 测量标注覆盖层：显示 annulus plane、centerline 轨迹
- 截图按钮（导出当前视图为 PNG）

**文件位置：** `apps/web/src/main.ts`（THREE.js 部分已有基础）

---

## P1 — 数据质量与完整性

### TASK-005：完善 default_clinical_case 的 measurements.json

**目标：** 让默认病例的所有测量值都是临床上合理的真实范围数据

**要求：**
- 所有 `PLACEHOLDER_ONLY` 字段替换为合理数值
- 数值必须符合临床范围（参考文献）：
  - Annulus diameter: 20–30 mm（TAVI 常见范围）
  - STJ diameter: 25–40 mm
  - Sinus of Valsalva: 28–45 mm
  - Coronary height (LCA): 10–20 mm
  - Coronary height (RCA): 10–20 mm
  - Leaflet coaptation height: 8–15 mm
- `uncertainty.flag` 应该是 `"NONE"` 或 `"LOW_CONFIDENCE"`（不能是 `PLACEHOLDER_ONLY`）
- `evidence.confidence` 应该在 0.75–0.95 之间
- 保持 JSON Schema 校验通过（对照 `schemas/measurements.json`）

---

### TASK-006：完善 planning.json 使 TAVI 规划合理

**目标：** 让默认病例的规划结果像真实的 TAVI 规划报告

**TAVI 规划必须包含：**
```json
{
  "tavi": {
    "recommended_prosthesis": {
      "primary": { "brand": "...", "size_mm": 26, "type": "..." },
      "alternative": { "brand": "...", "size_mm": 29, "type": "..." }
    },
    "access_route": {
      "recommended": "transfemoral",
      "alternatives": ["transaortic"],
      "evidence": {...}
    },
    "coronary_occlusion_risk": {
      "lca": { "risk_level": "low|moderate|high", "vh_distance_mm": 12.5, ... },
      "rca": { "risk_level": "low|moderate|high", "vh_distance_mm": 14.2, ... }
    },
    "implant_depth_recommendation": {
      "value_mm": 4,
      "range_mm": [2, 6],
      "evidence": {...}
    },
    "annulus_rupture_risk": "low|moderate|high"
  }
}
```

---

### TASK-007：Annulus Plane 可视化

**目标：** 在 3D 查看器和 MPR 视图中叠加显示 annulus plane

**数据来源：** `cases/default_clinical_case/artifacts/annulus_plane.json`

**显示要求：**
- 3D 视图：显示为绿色半透明圆盘，带法向量箭头
- MPR 视图：在轴位图上显示瓣环轮廓
- 点击可切换显示/隐藏

---

## P2 — 系统体验

### TASK-008：加载状态与错误处理

**目标：** 系统启动时有优雅的加载状态，数据加载失败有明确提示

**要求：**
- 启动加载页：AorticAI logo + 进度条（加载 default case 各组件）
- 每个组件加载状态独立：mesh / measurements / planning / imaging
- 如果某组件加载失败：显示警告但不崩溃整个界面
- 失败提示必须明确（"测量数据加载失败，请刷新" 而不是空白）

---

### TASK-009：病例信息头部

**目标：** 工作站顶部显示病例基本信息

**显示内容（来自 case_manifest.json）：**
- 病例ID（匿名化）
- 扫描日期
- Pipeline 版本号
- Build 版本号
- 当前系统质量状态（`AcceptanceStatus`：pass / needs_review / blocked）

**样式：** 紧凑顶部栏，不超过 40px 高度，用现有 dark theme

---

### TASK-010：PDF 报告查看器

**目标：** 在工作站内可以直接查看/下载报告

**要求：**
- 右下角或菜单栏放一个 `📄 Report` 按钮
- 点击后弹出侧边栏或模态框，内嵌 PDF 查看器（用 `<iframe>` 或 pdf.js）
- 提供下载按钮
- 数据来源：`cases/default_clinical_case/reports/report.pdf`

---

## 不需要 VPS 的原因说明

以下工作全部在本地运行：
- 前端 UI → `npm run dev` 或 `npx vite`，纯本地
- Default case 数据 → 全是本地 JSON/STL 文件
- API 层 → `services/api` 可以用 `wrangler dev` 本地模拟
- 测试 → `npx playwright test`，本地运行

**只有以下需要 VPS（Oracle）才能做：**
- 生产环境部署和公网访问
- 持续集成 / 自动更新
- 多病例存储（不只是 default_clinical_case）
- GPU 分割节点调用（实际上 GPU 是 Windows 机器，VPS 只是中间层）

---

## Codex 开始方式

1. 读 `CLAUDE.md`（项目原则）
2. 从 `TASK-001` 开始
3. 每完成一个 task，在此文件对应条目加 ✅ + 简短说明
4. 遇到阻塞立即汇报，不要自行决定跳过

---

*创建于：2026-03-31*
*当前阶段：Phase 1（本地开发，无需 VPS）*
*下一阶段：Phase 2（VPS 部署 + 多病例支持）待 Oracle VPS 到位后规划*
