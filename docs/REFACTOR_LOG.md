# AorticAI 重构执行日志

> 创建：2026-04-18
> 负责人：Claude (Opus 4) · 指挥官：AdamsYi
> 参考：本仓库 `CLAUDE.md` + 本次对话中拟定的 8 PR 计划
> 对标产品：3mensio · CVI42 · Syngo.via Structural Heart · Laralab LARA Heart · HeartFlow

---

## 0. 为什么做这次重构（Why）

在本次审视中发现三件阻塞性问题，决定系统能否从 "demo-grade" 跨到 "research-grade preclinical planning"：

1. **手动标注回写断链** — 前端 `/api/annotations/auth` 被调用但后端无此路由，且 `manual_annotations` 表写入后 measurements summary 不合并。冠脉高度 = null 的 P0 安全红线因此无法通过"手动兜底"消除。
2. **`apps/web/src/main.ts` 单文件 6463 行** — `types.ts` Step 1 已拆出常量/类型，但后续 DOM/shell/viewer/tools/planning 全部堆在 main.ts 里，任何新功能都要改这一个文件。
3. **uncommitted 改动积压** — UI v12 → v13 "Light Clinical" 主题切换（+481/-197 CSS）、schema source_type 枚举、annotate 面板 DOM (+298 main.ts) 全部未提交；工作树不干净导致无法安全起新 PR。

**重构目标：** 把上面三件事一次打穿到底。不做新功能（DICOM / study list / vendor sizing 是下一批）。

---

## 1. 计划（Plan）

按依赖顺序执行：

| PR | 范围 | 为什么放这个顺序 |
|----|------|------------------|
| **PR #1** | 拆 2 个 commit 落盘未提交改动 | 任何重构都必须从干净工作树开始 |
| **PR #2** | 手动标注闭环（auth + CSS + summary merge） | 最高 ROI，解锁冠脉高度 P0 红线 |
| **PR #3** | 前端模块化 Step 2：`shell/` 抽出 | 为后续任何新功能（DICOM / study list）准备落点 |

**明确不在本次范围：** DICOM 导入 · study list · vendor sizing · CPR · virtual valve。这些在 PR #5 完成后才动。

---

## 2. 实际执行（What Actually Happened）

此小节在每个 PR 做完后即刻更新。

### PR #1 — 清理未提交改动
- 状态：✅ 已完成
- 拆成两个 commit 落盘：
  - `0f19db9` — `schema: add source_type enum for measurement/annotation provenance`
    - `schemas/manual_annotation.json` + `schemas/measurements.json` 增加 `source_type ∈ { auto_pipeline | manual_annotation | hybrid | external }`
  - `f918ad9` — `ui: v13 Light Clinical theme + annotate panel DOM scaffold`
    - `apps/web/src/styles.css` 切换淡色临床主题（3mensio 白底 + 医疗蓝强调色）
    - `apps/web/src/main.ts` 增加 annotate 面板 + 密码模态 DOM + 事件 stub
    - `wrangler.toml` BUILD_VERSION 碰版

### PR #2 — 手动标注闭环
- 状态：✅ 已完成，提交 `9ada02a`
- 打通从 password → token → 放置 landmark → D1 写入 → measurements summary 合并 的完整路径：
  - **后端 `src/index.ts`**
    - `POST /api/annotations/auth`：校验 `ANNOTATION_PASSWORD`（wrangler secret），用 HMAC-SHA256 签发 `{caseId, nonce, exp}` token，TTL 由 `ANNOTATION_TOKEN_TTL_SECONDS` 控制
    - `POST /api/cases/:id/annotations` 加 `requireAnnotationToken` 守卫
    - `handleCaseMeasurementsWithOverrides`：读 measurements 后 `mergeManualIntoMeasurements` 叠加 D1 `manual_annotations`；规则为
      - 不覆盖已有非 null 自动值
      - 盖戳 `evidence.source_type = 'manual_annotation'`
      - `uncertainty.flag: NOT_AVAILABLE → MANUAL_OVERRIDE`
      - 清 `clinician_review_required`
    - `MANUAL_MERGEABLE_KEYS = [coronary_height_left_mm, coronary_height_right_mm]` — 目前只合并冠脉高度（P0 安全红线要的字段）
  - **前端 `apps/web/src/styles.css`** 追加 ~158 行 annotate 面板 CSS（`.annotate-panel / .annotate-target-btn / body.annotate-mode` tint）
  - **`wrangler.toml`** 增加 `ANNOTATION_TOKEN_TTL_SECONDS = "3600"`；注释指引 `wrangler secret put ANNOTATION_PASSWORD`

### PR #3 — 前端模块化 Step 2（shell 抽出）
- 状态：✅ 已完成，提交 `d2e599d`
- 新增 `apps/web/src/shell/` 三文件：
  - `html.ts` — `escapeHtml` + `renderViewportCard`（纯函数，零副作用）
  - `dom.ts` — `DOM` 句柄注册表（可变对象，仅声明，不写 `getElementById`）
  - `template.ts` — `renderShellHTML()` 返回 420 行静态 HTML 字符串
- `main.ts` 变化：
  - 删掉内联 `DOM = {...}` 114 行 → `import { DOM } from './shell/dom'`
  - `renderShell()` 里的 `APP_ROOT.innerHTML = \`...大段 HTML...\`` → `APP_ROOT.innerHTML = renderShellHTML()`
  - 删掉 `renderViewportCard` + `escapeHtml` 两个 helper
- **行数：6463 → 5917**（-546 行，-8.4%）
- 验证：
  - `npm run check:workstation` ✓
  - `npm run build` ✓
  - `npm run test:unit` 29/30（test #16 TAVI 名义尺寸是 `7a70a38` 真实 pipeline swap 带来的陈旧期望值，与本次重构无关）
- **DOM wiring 保留在 main.ts**：`getElementById → DOM.xxx` 赋值 + `addEventListener` 绑定块（~340 行）依赖 ~80 个 main.ts 模块级 handler（`setSubmitCaseModalOpen / submitAnnotationPassword / enterAnnotationMode / activeCase / setBootStage ...`），搬过去会形成 `shell → main → shell` 循环依赖。留给 PR #4 解决：先把 handler 按领域拆到 `viewer/ · tools/ · state/`，再把 wiring 按依赖图切片搬出。

---

## 3. 值得记录的事（Noteworthy）

### 3.1 启动前扫到的死角
- `.git/index.lock` 存了 4 天（0 字节），锁住了仓库——无 `git` 进程占用，确认是上次中断残留；直接删除后恢复。
- 构建一度 race 在 `dist/default-case/artifacts/annulus_plane.json` ENOENT：`build_default_case_bundle.mjs` 在源 artifact 还没拷到 dist 之前就尝试写 dir map；清掉 dist 重跑即消。不是本次重构引入的 bug，但值得记下来——下一次改 build 脚本时应显式 `await` artifact sync。

### 3.2 "不修跟当前任务无关的东西"
- `test:unit` 里 test #16 `showcase case includes complete tavi planning structure` 期望 `nearest_nominal_size_mm === 23`，实际 = 20。`git stash` + 重跑验证：**在我动代码之前就已经是红的**。
- 原因：`7a70a38 promote: real CTACardio pipeline output as default_clinical_case` 把默认病例从合成数据换成真实 CTA pipeline 结果，annulus 20.96mm → nominal 20mm；单测还写着旧的 23mm 期望。
- **决定：不顺手修**。理由：①不在本次 PR 范围；②"修"这个单测等于改断言，没有 schema / rule 变更来支撑，属于粉饰；③留给专门管 sizing rule 的 PR 来处理，避免重构 commit 里混业务改动。

### 3.3 循环依赖触发 PR #3 范围缩小
- 原计划 PR #3 把 `renderShell()` **整体**搬出去（包括 DOM wiring + event binding）。
- 动手后数了一下依赖：wiring 块 ~340 行 × ~80 个跨域符号 = 搬出去立刻 `shell → main` 循环导入。
- 决定：PR #3 只搬 **纯表述层**（HTML 字符串 + DOM 类型声明）；wiring 留在 main.ts，交给 PR #4 做 viewer / tools / state 切片后再搬——那时候被依赖的 handler 本身在 `viewer/ · tools/`，wiring 只需引用域模块，不会回环。
- **教训**：大重构之前先画一遍"被引用符号图"；看着文件大就整块搬是重构最常见的翻车姿势。

### 3.4 为什么 `shell/dom.ts` 用可变 `const` 而不是 class
- 现有 main.ts 到处 `DOM.headerStatus` 点访问。
- 若换成 `DOMRegistry` 类 + getter，要改 451 处调用点；与"零行为变更"的 PR 目标冲突。
- 所以保留 mutable plain object 语义，只把声明搬家。风格问题留给未来 state 模块化时一起处理。

### 3.5 i18n 本计划独立拆但没拆
- 原计划 `shell/i18n.ts` 吸收 `I18N` 常量 + `applyLocale()`。
- 看了一眼：`I18N` 已经 `import zhCN from './i18n/zh-CN'; import enUS from './i18n/en';`，自带独立目录；`applyLocale()` 依赖 `currentLocale` / `DOM.localeButtons` / 100+ `data-i18n` 属性的读取遍历。
- 结论：**没必要拆**。`apps/web/src/i18n/{zh-CN,en}.ts` 已经是独立模块；`applyLocale()` 就是个消费这两份词典的视图层 helper，留在 main.ts 没问题。重构以"必要性"为准，不追求机械对称。

---

## 4. PR #4a — 影像观感 + bug 修复（2026-04-20 追加）

> 指挥官一句话："先不说那些牛逼哄哄的功能，基础影像观感要做好，bug 排查好"。

### 4.1 排查方式
1. `npm run dev` → preview @ 1680×1000
2. 截图 + DOM inspect + console logs + network requests 全抓一遍
3. 静态扫 `TODO/FIXME` / `console.error` / catch blocks

### 4.2 发现的三个真实 bug（按用户可见严重度排序）

| # | Bug | 根因 | 修复 |
|---|-----|------|------|
| 1 | Header 按钮显示 `action.annotate` 原始 key | PR #1（`f918ad9`）加了按钮但没加词典条目；i18n miss 直接露底 | en/zh-CN 各加一条（"Annotate" / "人工标注"） |
| 2 | Viewport 方位标签 9px @ 55% 白——远看像脏像素，近看也糊 | 早期 UI 抄了深色 demo 的"克制美感"风格；临床标准是 11-13px 高对比 | 提到 12px @ 92% 白 + 更强 text-shadow |
| 3 | 3D 主动脉根模型只占画布 ~25%，小而远 | `positionThreeCameraForCase` 用**整场景** bbox 对角线作为相机距离。升主动脉拉长了 bbox，根部被挤到画面一角 | 当 annulus + STJ 原点都已知时，以它们中点为 target、`max(55, rootLength*3)` 为尺度——贴着根部 framing。无 landmark 时回退到旧行为 |

### 4.3 静态审计结论（无需改动）

- **9 个 `catch` 块**：要么 `showMprFailure / showThreeFailure / annotateSaveStatus / providerHealth` 这类更新 UI 的；要么是 `loadLatestCase` 刻意的三层降级（latest → fixture → showcase）；要么是清理 path 里的 best-effort `try/catch {}`。没有会让用户"看不到出错"的静默吞。
- **全文 0 个 `console.error / console.warn`**：错误一律走 UI 通道（boot overlay / MPR failure card / three fallback card）。评估良好，不改。

### 4.4 遗留但不改（需产品决策）

- **Step tab "completed" ✓ 语义**：当前含义 = "该步骤的测量值已存在于数据集中"。临床 UI（3mensio / Syngo.via）里 ✓ 通常指"医生已审核通过该步骤"。默认病例一载入就看到 STJ / Root 打勾，对新用户传达的是"工作已做完"的错误叙事。
- 真修需要新增 `step.reviewed_by_clinician` 状态 + 审阅按钮 + 审阅时间戳；这是 clinician workflow 功能，不是观感 bug。记在这里，下次做手动审核流程时一起动。

### 4.5 验证

- 实测：`#open-annotate.text === "Annotate"`；`.viewport-label` 计算样式 = `rgba(255,255,255,0.92)` / `12px`；截图确认 3D 根部填满 ~60% 画布。
- `npm run check:workstation` ✓
- commit `ae2cbac fix(ui): imaging workstation observation fixes (PR #4a)`

---

## 5. 下一批（未在本次重构中做）



按 ROADMAP 与 GAP_ANALYSIS：

1. PR #4 — main.ts 模块化 Step 3：`viewer/mpr.ts · viewer/three.ts · tools/annotate.ts · tools/measurements.ts`
2. PR #5 — main.ts 模块化 Step 4：`planning/ · state/ · api/client.ts`，目标 main.ts < 500 行
3. PR #6 — DICOM series 导入（`@cornerstonejs/dicom-image-loader`）
4. PR #7 — study list + 多病例路由（`/workstation?case=<id>`）
5. PR #8 — vendor-specific TAVI sizing（Edwards / Medtronic / Abbott IFU 规则引擎）
