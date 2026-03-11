# GPU Provider (Windows RTX Workstation)

这个服务是 **真实推理后端**，用于接收 Cloudflare Worker 转发的 CTA 数据并执行真实流程：

1. DICOM/ZIP -> NIfTI（`dcm2niix`）  
2. 多类分割（`TotalSegmentator` + `build_real_multiclass_mask.py`）  
3. 自动测量与术前指标 JSON（`pipeline_runner.py`）

本服务已禁用 placeholder/stub 输出：没有真实推理链路会直接报错。

---

## 1) 在你的 Win + RTX 5060 机器上启动

在 `gpu_provider` 目录打开 PowerShell：

```powershell
.\run_windows_gpu.ps1 -Quality fast
```

默认监听 `0.0.0.0:8000`，健康检查：

```powershell
curl http://127.0.0.1:8000/health
```

---

## 2) 必要组件说明

- Python 3.11+
- NVIDIA 驱动（支持 CUDA）
- `dcm2niix` 可执行文件（需在 PATH 中）
- `TotalSegmentator`（已在 `requirements.txt`）

可选增强（用于后续瓣膜专模）：
- `MONAI`
- `nnU-Net v2`
- `VMTK`（建议 conda 安装：`conda install -c vmtk vmtk`）

---

## 3) 对接 Cloudflare Worker

Worker 需要指向你的 Win GPU 服务公网/内网地址（推荐 Tailscale/ZeroTier 内网地址）：

```bash
./scripts/switch_to_provider.sh https://<your-win-gpu-host>:8000/infer
```

---

## 4) INFER_CMD（可选）

如果你有更完整的自定义 pipeline，可设置 `INFER_CMD` 覆盖内置 `pipeline_runner.py`。

模板变量：
- `{input_path}`
- `{output_mask}`
- `{output_json}`
- `{job_id}`
- `{study_id}`

要求：
- 必须生成真实 `mask_multiclass.nii.gz`
- 必须生成真实结果 `result.json`
- 禁止返回虚假/模拟结果

---

## 5) 结果契约

`/infer` 成功返回：
- `mask_base64`：真实多类分割掩膜
- `result_json`：真实几何测量与 VSRR/PEARS/TAVI 指标
- `metrics`：推理耗时

失败返回：
- `status=failed`
- `error_message`

---

## 6) 备注

当前测量链路已经是“真实分割 + 真实几何计算”；  
冠脉开口高度、瓣叶三尖精细几何等高级指标，需要专门瓣膜/冠脉模型进一步增强（不做伪造）。
