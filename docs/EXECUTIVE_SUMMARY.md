# AorticAI 执行摘要

`default_clinical_case` 同时承担默认病例、showcase case、reference case。它现在是一个真实 CTA 金标准展示病例，随仓库一起交付，用于默认首屏、产品演示、接口契约和自动化测试基线。

系统固定为：
- Worker 是唯一公网入口
- `services/api` 是唯一业务真相源
- `case_manifest.json` 是默认病例唯一真相对象
- `planning.json` 是 planning panel 唯一 artifact 真相源
- GPU 仅用于分割；几何、测量、规划、模拟在 CPU
- 未指定项：无特定约束

该模板当前定位保持为 `research-grade preclinical planning platform`。

## English summary

`default_clinical_case` serves as the default case, showcase case, and reference case. It is now a committed real-CTA gold showcase bundle used for the default first screen, product demonstration, interface baselines, and automated tests.

System invariants:
- Worker is the only public entrypoint
- `services/api` is the only business-truth layer
- `case_manifest.json` is the single source of truth for the default case
- `planning.json` is the single source of truth for the planning panel
- GPU is segmentation-only; geometry, measurements, planning, and simulation stay on CPU
- Unspecified items: no specific constraint
