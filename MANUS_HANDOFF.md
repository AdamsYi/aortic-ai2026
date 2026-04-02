# Manus 临时指挥官 — 操作记录 & CC 交接文档

> **本文件由 Manus（临时指挥官）维护。**
> 用户（大飞）因 CC 额度耗尽，临时让 Manus 接替 CC 的指挥官角色。
> CC 额度恢复后将重新接手。本文件记录 Manus 期间的所有操作，确保无缝交接。

---

## CC 交接提示词

> **给 CC 的第一条消息（复制粘贴即可）：**
>
> 你好，CC。你之前因为额度耗尽中断了工作，大飞让 Manus 临时接替了你的指挥官角色。Manus 期间的所有操作记录在项目根目录的 `MANUS_HANDOFF.md` 文件中。请先完整阅读该文件，了解 Manus 做了什么、改了什么、当前项目状态如何，然后继续你的工作。CLAUDE.md 和 ROADMAP.md 没有变化。

---

## 一、CC 额度耗尽时的精确状态（2026-04-02 约 20:30）

CC 最后通过 SSH（Admin 用户，192.168.11.2:22）连接到 Windows，正在并行做两件事：

| 事项 | 状态 | 细节 |
|------|------|------|
| TAVI 数据集下载 | 中断在 ~50%（2.28GB / ~4.5GB） | `C:\AorticAI\gpu_provider\demo_data\tavi_data.zip`，用 curl 下载 |
| FastAPI 重启 | 已完成 | 用 `.venv\Scripts\python.exe`（nightly cu128），port 8000，`gpu: true` |
| Conv3d 验证 | 已通过 | `.venv` 中 PyTorch nightly cu128 在 RTX 5060 (sm_120) 上 Conv3d 可用 |
| process_downloaded_tavi.py | 已创建并 push | 跳过下载，用已有 zip 跑 pipeline 的备用脚本 |
| 下载完成监控脚本 | 已部署但未触发 | CC 设了后台监控等 zip 下完自动跑 pipeline |
| Cloudflare Tunnel | 未确认 | CC 重启了 FastAPI 但不确定 Tunnel 是否同时在跑 |
| sshd 配置 | 可能损坏 | 之前加了 `StrictModes no` 导致 sshd 启动失败过，后来修复但不确定最终状态 |

CC 额度耗尽后约 1 小时，用户关闭了 Windows，所有进程中断。

---

## 二、Manus 接手后的操作记录

### 2026-04-02：阅读材料 & 项目理解

**操作内容：** 纯阅读，未修改任何代码或配置。

1. 完整阅读了用户与 CC 的聊天记录（pasted_content.txt，11104 行）
2. 完整阅读了用户与 Codex 的聊天记录（pasted_content_2.txt，1514 行）
3. 通过 Mac desktop session 检查了项目文件结构、git log、git status
4. 阅读了以下关键文件：
   - `CLAUDE.md`（项目原则，未修改）
   - `ROADMAP.md`（路线图，未修改）
   - `wrangler.toml`（Cloudflare Worker 配置）
   - `gpu_provider/Start_AorticAI.bat`（一键启动脚本）
   - `gpu_provider/Start_AorticAI_GPU.bat`（桌面快捷方式，调用 Start_AorticAI.bat）
   - `gpu_provider/download_and_process_tavi.py`（Sprint 21 核心脚本）
   - `gpu_provider/process_downloaded_tavi.py`（跳过下载版本）
   - `gpu_provider/run_real_pipeline.bat`（一键跑真实 pipeline）
   - `gpu_provider/app.py`（FastAPI 入口，health 端点、build_pipeline_cmd、infer 端点）
   - `gpu_provider/save_as_default_case.py`
   - `cases/default_clinical_case/artifacts/case_manifest.json`
5. 验证了线上状态：
   - `heartvalvepro.edu.kg` → HTTP 200（前端正常）
   - `api.heartvalvepro.edu.kg/health` → 1033（Tunnel 断，Win 已关机）
6. 确认 git 状态：HEAD 在 `75d83e4`（`feat: add process_downloaded_tavi.py`），无未提交的重要变更
7. **创建了本文件 `MANUS_HANDOFF.md`**

**未修改的文件：** 无。Manus 在此阶段没有修改任何项目文件（除本文件）。

---

## 三、当前项目真实状态（截至 Manus 接手时）

### 已完成且稳定的

- **Sprint 1-20 全部完成**：前端工作站、Cloudflare Worker 部署、临床面板、PDF 报告、DICOM 支持、进度展示、数据来源 banner、人工标注工作流
- **Sprint 21 代码已就绪**：`download_and_process_tavi.py` + `process_downloaded_tavi.py` + `run_real_pipeline.bat` 已 push 到 main
- **Windows .venv 环境已配好**：PyTorch nightly cu128 + TotalSegmentator，Conv3d 在 RTX 5060 验证通过
- **前端线上正常**：heartvalvepro.edu.kg 返回 200

### 未完成的（Sprint 21 核心目标）

**用真实心脏 CTA（Zenodo TAVI 数据集）跑通 pipeline，产出真实测量值，替换默认病例的参考估算值。**

具体阻塞：
1. Windows 已关机，所有服务断开
2. TAVI 数据集下载中断（~50%），zip 文件可能不完整
3. Pipeline 从未在真实数据上跑通过
4. 默认病例仍然是 `data_source: "clinically_plausible_reference_not_from_real_ct"`

### Win 开机后的操作顺序

1. 确保 V2RayN 开启且设为**全局模式**（cloudflared 需要代理）
2. 双击桌面**蓝色三角形**（`Start_AorticAI_GPU.bat`）
3. 等看到 `[成功] AI 服务已启动`
4. 新开 CMD 窗口，运行 `run_real_pipeline.bat`（或 `process_downloaded_tavi.py` 如果 zip 已完整）
5. 等 pipeline 跑完，检查 annulus 是否在 15-35mm 范围内
6. 如果合理，脚本会自动 save + commit + push

---

## 四、关键技术备忘（CC 需要知道的）

### Windows SSH 配置

CC 之前配了 Mac → Win 的 SSH（Admin 用户），但过程曲折：
- 最终方案：Admin 用户 + `C:\ProgramData\ssh\administrators_authorized_keys`
- 防火墙规则已加（port 22，名称 `sshd`）
- `StrictModes no` 已加入 `sshd_config`（因为这个导致 sshd 崩过一次）
- **Win 关机重启后 sshd 是否能正常启动未知**，可能需要手动 `Start-Service sshd`

### Cloudflare Tunnel 注意事项

- Tunnel ID: `5c169115-689e-4eaf-850c-970bebefb49c`
- **必须用 `--protocol http2`**（QUIC 被 V2RayN TUN 模式拦截）
- **必须设 `HTTPS_PROXY=http://127.0.0.1:7890`**（V2RayN 本地代理端口）
- `Start_AorticAI.bat` 已包含以上配置

### RTX 5060 + PyTorch

- 稳定版 PyTorch (cu124) 的 Conv3d 不支持 sm_120（Blackwell 架构）
- `.venv` 中安装了 nightly cu128，Conv3d 已验证可用
- `Start_AorticAI.bat` 用的是 `.venv\Scripts\python.exe`，所以 FastAPI 会用正确的 PyTorch
- `build_real_multiclass_mask.py` 有 GPU→CPU 自动 fallback

### "蓝色三角形"

用户口中的"蓝色三角形" = Win 桌面上的 `Start_AorticAI_GPU.bat`（.bat 文件默认图标）。它是用户唯一需要在 Win 上做的操作入口。内容就一行：`call C:\AorticAI\gpu_provider\Start_AorticAI.bat`。

---

## 五、操作日志（按时间顺序，持续更新）

| 时间 | 操作者 | 操作 | 影响的文件 | 备注 |
|------|--------|------|-----------|------|
| 2026-04-02 ~22:30 | Manus | 阅读全部材料，理解项目 | 无 | 纯阅读 |
| 2026-04-02 ~23:00 | Manus | 创建 MANUS_HANDOFF.md | MANUS_HANDOFF.md | 本文件 |

---

*本文件由 Manus 维护，每次操作后更新。CC 恢复后请先阅读本文件再继续工作。*
