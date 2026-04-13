# AorticAI 交接文档 — 2026-04-04

> 执行者：Claude (claude-sonnet-4-6)
> 指挥官：Adams

---

## 本次会话完成的工作

### 1. 修复 Worker 名冲突导致的 `/` 路由随机失败

**问题**：`heartvalvepro.edu.kg/` 约 50% 概率转圈打不开，`/?v=20260404` 始终正常。

**根本原因**：wrangler.toml 改名为 `aortic-ai-api-production` 后，旧 worker `aortic-ai-api` 没有删除。两个 worker 同时绑定 `heartvalvepro.edu.kg/*`，Cloudflare 随机路由，两者 JS 文件哈希不同。

**修复**：
- `wrangler.toml`: name 改回 `aortic-ai-api`
- `npx wrangler delete --name aortic-ai-api-production --force`
- 重新部署
- 验证：两个 URL 均返回 `app.98b8678b52e0.js` ✅

**commit**: 无独立 commit（wrangler.toml 已在 `b75f856` 后修改，未单独提交）

---

### 2. 冠脉开口检测各向异性修复

**问题**：`coronary_heights_mm: {left: null, right: null}` — P0 安全问题。

**根本原因诊断**（三级失败链）：
1. `binary_dilation(iterations=6)` 用 XY spacing (0.71mm) 计算迭代次数，但 3D dilation 在 Z 方向也用同样迭代数 → Z 方向扩展 6×3mm=18mm（目标 4.5mm）
2. Frangi filter sigmas (0.8, 1.2, 1.8mm) 全小于 Z voxel size (3mm) → 无法感知 Z 方向上的管状结构
3. `binary_opening(np.ones((2,2,2)))` 要求所有方向 ≥2 体素，而冠脉在 Z 方向只有 1 体素 → 全部清除 → `detected: []`

**修复** (`gpu_provider/geometry/coronary_detection.py`):
- 在 Frangi 执行前，将 ROI crop 重采样到近似各向同性 (~1mm)
- Frangi + 形态学操作在各向同性空间运行
- 检测到候选点后，用逆 zoom 变换把坐标映射回原始体素空间

**commit**: `aaf2cd7`

---

### 3. TotalSegmentator 分割质量修复

**问题**：GPU 运行给出瓣环=37-41mm（应为~24mm），lumen 只有 56K 体素（正常为 191K+）。

**根本原因**：`build_real_multiclass_mask.py` 无论 quality 如何，总是加 `--fast` 标志（line 342）。`--fast` 将 CT 降采样到 3mm，而 AVT D1 CT 本身 Z=3mm，无法获得足够的 aortic root 细节。

4月3日那次正确的 80+ 分钟 CPU 跑用的是系统 Python TotalSegmentator（无 `--fast`），标准全分辨率模型，才得到了可信的 24.36mm 瓣环。

**修复** (`gpu_provider/build_real_multiclass_mask.py`):
- `quality=fast` → 保留 `--fast`
- `quality=high` → 去掉 `--fast`，用全分辨率模型

**commit**: `9d7fc9c`

---

## 未解决 / 待验证问题

### A. TotalSegmentator 标准模式结果仍未验证

去掉 `--fast` 后运行了一次（`mask_hq.nii.gz`），结果仍为 annulus=41mm——比 fast 更差。说明问题不只是 `--fast` flag，TotalSegmentator 对这个 CT 的 aortic root 标签本身就不可靠。

**下一步调查方向**：
1. 查看 `build_real_multiclass_mask.py` 里的 seed detection 和 `track_component_along_z` 逻辑，看是否 `aorta` label 包含了太多结构
2. 对比 fast mask 和 hq mask 的实际体素分布（哪些区域被标记为 label=1 aortic_root）
3. 考虑：AVT D1 CT 本身 Z=3mm，TotalSegmentator 对粗切片 CT 的 aortic root 分割天然不准，需要更细化的 post-processing

### B. 冠脉开口检测是否生效

修复代码（`coronary_detection.py`）通过 SCP 传到了 Windows，但 Python `__pycache__` 可能还在用旧的 `.pyc`。测试时观察到 `detected: []`——需要确认新代码是否加载。

**验证方法**：
```bash
ssh admin@192.168.11.2 "del C:\AorticAI\gpu_provider\geometry\__pycache__\coronary_detection*.pyc"
# 然后重新运行 pipeline 并检查 result.coronary_detection.detected 列表是否非空
```

### C. 最关键：用真实可信的分割 mask 重跑 pipeline

需要找回或重新生成一个 annulus~24mm 的可信 mask。选项：
1. **AVT 数据集本身提供了 ground-truth 分割** —— AVT figshare 14806362 提供了 `.nrrd` 格式的分割标注。可以下载 D1 的标注，转换为 NIfTI，作为输入 mask 跑 `--skip-segmentation`
2. **手动调整 TotalSegmentator 后处理** —— 调试 `build_real_multiclass_mask.py` 的 root/ascending 分割逻辑
3. **换 CT 数据** —— AVT D1 的 3mm Z spacing 对 TotalSegmentator 天然不友好；找一个 1mm 各向同性的 TAVI CTA

---

## 当前代码状态

| 文件 | 状态 |
|------|------|
| `gpu_provider/geometry/coronary_detection.py` | ✅ 各向异性修复已推送 (commit aaf2cd7) |
| `gpu_provider/build_real_multiclass_mask.py` | ✅ 去掉 quality=high 时的 --fast (commit 9d7fc9c) |
| `wrangler.toml` | ✅ name=aortic-ai-api，已重新部署 |
| `heartvalvepro.edu.kg` | ✅ 稳定可访问 |
| Windows `demo_pipeline_output/` | ⚠️ 包含多次测试结果，mask 文件被覆盖 |

## Windows Git 状态

Windows 机器（192.168.11.2）比 origin/main 多 2 个本地 commit（解决冲突的），但因为无 TTY 无法通过 SSH 推送（credential prompt 失败）。需要直接在 Windows 上操作：

```powershell
cd C:\AorticAI
git push
```

---

## 关键认知

1. **AVT D1 CT Z=3mm 是硬约束** — 影响 TotalSegmentator、Frangi filter、binary morphology 的所有环节
2. **4月3日那次正确的 24.36mm 结果来自 80分钟 CPU 跑的标准质量 TotalSegmentator mask**，该 mask 已丢失（被本次测试覆盖）
3. **Windows SSH 通过 admin 用户连接**，IP 已变为 192.168.11.2（原来是 192.168.1.173）
4. **不要在 Mac 上处理 GPU/pipeline 相关文件**，直接在 Windows 上操作

---

*生成时间：2026-04-04*
*下次继续前请先阅读本文件*
