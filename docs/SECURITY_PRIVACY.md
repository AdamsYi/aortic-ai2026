# AorticAI 安全与隐私

固定要求：
- `Cache-Control: no-store`
- `Pragma: no-cache`
- 禁用 service worker 持久化患者数据
- Mac 不落盘真实 CTA / STL / 中间结果

默认 showcase case 允许入仓，因为它是纯占位数据，不含真实 CTA。

未指定项：无特定约束。

## English summary

The template uses `no-store` headers and avoids persistent browser caching for case data. The bundled default showcase case is allowed in-repo because it is placeholder-only and contains no real CTA.
