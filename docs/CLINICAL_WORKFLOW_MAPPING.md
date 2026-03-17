# AorticAI 临床工作流映射

- CTA：唯一输入
- AorticRootComputationalModel：唯一真值源
- Measurements：仅从模型派生
- Planning：仅从模型与派生测量结果派生
- Artifacts：JSON / STL / PDF

showcase case 在 Web 首屏直接展示：
- axial / sagittal / coronal MPR
- synchronized crosshair
- double-oblique 入口
- 3D anatomy
- centerline
- annulus / commissures / sinus peaks / STJ / coronary ostia
- measurements
- planning
- uncertainty / QA
- 下载入口

## English summary

The web showcase maps the workflow from CTA input to computational anatomy, measurements, planning, and artifacts. The first screen intentionally exposes both successful outputs and honest fallback states.
