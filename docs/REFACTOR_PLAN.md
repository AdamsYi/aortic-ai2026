# AorticAI 前端重构计划

> 创建：2026-04-13 | 状态：进行中

## 背景

`apps/web/src/main.ts` 6486 行，整个前端在一个文件里。60+ 全局变量，`.innerHTML` 字符串拼接，CSS class 切换做工作流。`src/index.ts` 7760 行，268 行 if 语句做路由。

不是重写，是整理——把一个全塞在一个抽屉里的工具箱分成隔层。

## 决策记录

| 被砍掉的方案 | 原因 |
|-------------|------|
| 正式状态机（WorkflowEngine） | 4 个 tab 不需要，过度设计 |
| 组件化渲染（替换 innerHTML） | 改几百处，用户零感知 |
| IndexedDB 会话持久化 | 给单用户产品加数据库级复杂度 |
| 客户端 PDF 生成 | 浏览器生成医疗 PDF 不可靠 |
| 运行时 Schema 验证（Zod/ajv） | Pipeline 输出端验证即可，不需每次请求验 |

---

## Step 1：前端文件拆分

**目标：** `main.ts` 6486 行 → 7 个模块文件 + 1 个入口

**拆分方案：**

| 新文件 | 内容 | 从 main.ts 提取的区域 |
|--------|------|----------------------|
| `types.ts` | 所有 type/interface 定义、常量 | 行 1-388（类型）、行 335-349（常量） |
| `i18n.ts` | `t()` 函数、`currentLocale`、`applyLocale()` | 已有 i18n/en.ts 和 zh-CN.ts，整合入口 |
| `viewer-mpr.ts` | Cornerstone.js 初始化、viewport 管理、cine、software fallback | Cornerstone 相关函数 |
| `viewer-three.ts` | Three.js 场景、STL 加载、mesh 可见性、landmark overlay | Three.js 相关函数（最独立的子系统） |
| `panels.ts` | 右面板所有 render 函数：测量、规划、QA、手动审查、下载 | `render*Panel`、`render*Card` 系列函数 |
| `workflow.ts` | Tab 切换、焦点平面、centerline 导航 | `setActiveWorkflowStep`、`focusPlane` 等 |
| `annotations.ts` | 测量标注桥接、undo 栈、CRUD | annotation 相关函数 |
| `shell.ts`（入口） | `renderShell()`、`bootstrap()`、DOM ref 缓存、全局事件、键盘快捷键 | 保留为主入口，import 其他模块 |

**原则：**
- 每个模块管理自己的全局变量，只 export 必要接口
- `DOM` ref 对象提升为共享模块（`dom-refs.ts`）
- `activeCase` 留在 shell.ts，通过函数参数传递给其他模块
- 构建系统（esbuild）天然支持多文件打包，不需改 build 脚本

**验证：** 每提取一个模块后 `npm run build:web` + `wrangler dev` 确认不报错

---

## Step 2：后端路由拆分

**目标：** `src/index.ts` 268 行 if 路由 → 按域分组的 handler 模块

| 路由域 | 文件 | 覆盖端点 |
|--------|------|---------|
| Case | `services/api/caseRoutes.ts` | `/api/cases/*` |
| Job | `services/api/jobRoutes.ts` | `/api/jobs/*`、`/api/submit-case` |
| Upload | `services/api/uploadRoutes.ts` | POST 上传相关 |
| Provider | `services/api/providerRoutes.ts` | `/api/provider/*` |
| Static | `services/api/staticRoutes.ts` | `/assets/*`、`/default-case/*`、HTML 页面 |

主 `fetch` handler 变成 thin dispatcher：匹配路由前缀 → 调用对应模块。

---

## Step 3：测量数据类型化

**目标：** `Record<string, unknown>` → 强类型测量信封

```typescript
interface MeasurementEnvelope<T = number> {
  algorithm_value: T | null;
  user_override: T | null;
  effective_value: T | null;  // computed: override ?? algorithm
  unit: string;
  evidence: { source: string; method: string };
  uncertainty: { type: string; value: number };
  status: 'normal' | 'borderline' | 'abnormal' | 'missing';
}

interface CaseMeasurements {
  annulus_equivalent_diameter_mm: MeasurementEnvelope;
  annulus_area_mm2: MeasurementEnvelope;
  sinus_diameter_mm: MeasurementEnvelope;
  stj_diameter_mm: MeasurementEnvelope;
  coronary_height_left_mm: MeasurementEnvelope;
  coronary_height_right_mm: MeasurementEnvelope;
  // ... 其他字段
}
```

每个 `render*Panel` 函数接收 `CaseMeasurements` 而不是 `Record<string, unknown>`。

---

## 不做的事

- 不引入 React/Vue/Svelte（bundle size 敏感）
- 不改变 API 接口（前后端契约不变）
- 不改变部署流程（`npm run build:web` → `wrangler deploy`）
- 不改变用户可见行为（纯内部重构）
