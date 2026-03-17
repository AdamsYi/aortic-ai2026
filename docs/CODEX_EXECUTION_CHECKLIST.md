# AorticAI 执行检查清单

- `npm run build:web`
- `npx tsc --noEmit`
- `npm run test:schema`
- `npm run test:unit`
- `npm run test:e2e`

验收：
- `/demo` 首屏秒开
- planning panel 非空
- success + failure 共存
- QA / uncertainty 面板可见
- `/api/cases/default_clinical_case/summary` 与 `/workstation/cases/default_clinical_case` 关键字段一致
- `<15s` 默认病例 smoke gate

## English summary

Build the web bundle, run TypeScript checks, then execute schema, unit, and E2E tests. Accept only if the showcase case renders immediately, planning is non-empty, success and fallback coexist visibly, and summary/workstation payloads stay consistent.
