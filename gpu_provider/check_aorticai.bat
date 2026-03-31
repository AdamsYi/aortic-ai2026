@echo off
chcp 65001 >nul
echo ===== AorticAI 系统诊断 =====
echo.

echo [1] Python 版本:
python --version 2>&1

echo [2] GPU Provider 服务 (port 8000):
curl -s --max-time 3 http://127.0.0.1:8000/health >nul 2>&1
if %errorLevel%==0 (echo   状态: 运行中 OK) else (echo   状态: 未运行 - 请双击 Start_AorticAI)

echo [3] Cloudflare 隧道:
curl -s --max-time 5 https://api.heartvalvepro.edu.kg/health >nul 2>&1
if %errorLevel%==0 (echo   状态: 公网可访问 OK) else (echo   状态: 隧道未连接)

echo [4] NVIDIA GPU:
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>nul
if %errorLevel% neq 0 echo   未检测到 GPU

echo [5] dcm2niix:
dcm2niix --version 2>&1

echo [6] cloudflared:
cloudflared --version 2>&1

echo.
echo ===== 诊断完成 =====
pause
