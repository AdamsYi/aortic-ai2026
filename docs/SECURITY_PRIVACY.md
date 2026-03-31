# AorticAI 安全与隐私

固定要求：
- `Cache-Control: no-store`
- `Pragma: no-cache`
- 禁用 service worker 持久化患者数据
- Mac 不落盘真实 CTA / STL / 中间结果

默认 showcase case 允许入仓，因为它是明确选定的真实 CTA 金标准展示病例，只用于产品展示、接口基线和自动化验证，不作为新增患者数据采集流程的一部分。

未指定项：无特定约束。

## English summary

The template uses `no-store` headers and avoids persistent browser caching for case data. The bundled default showcase case is allowed in-repo because it is the explicitly selected real CTA gold showcase/reference case used for product demonstration and verification, not an ad hoc patient-data cache.
