# AorticAI 失败模式与测试

固定覆盖：
- coronary detection failure
- leaflet geometry failure
- centerline instability
- MPR absence
- UX non-clinical

统一回退规则：
- `value = null`
- `uncertainty.flag != NONE`
- `clinician_review_required = true`

默认 showcase case 必须同时展示：
- 成功项
- unavailable 项
- legacy 项
- inferred / historical 项

## English summary

Failure handling is explicit. Missing or low-confidence outputs must return `null` with non-`NONE` uncertainty and `clinician_review_required=true`. The showcase case intentionally demonstrates both success and fallback states.
