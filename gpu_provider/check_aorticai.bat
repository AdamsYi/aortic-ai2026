@echo off
chcp 65001 >nul
echo ===== AorticAI 系统诊断 =====
echo.

echo [1] Python 版本:
python --version 2>&1

echo [2] 依赖检查:
python -c "import nibabel,scipy,skimage,fastapi,uvicorn; print('[OK] deps')" 2>nul || echo [FAIL] deps

echo [3] 端口检查 (8000):
netstat -an | find "8000" >nul && echo [OK] port 8000 listening || echo [FAIL] port 8000 not listening

echo [4] FastAPI 健康检查:
curl -s http://localhost:8000/health >nul && echo [OK] FastAPI health || echo [FAIL] FastAPI not responding

echo [5] cloudflared 进程:
tasklist 2>nul | find /i "cloudflared" >nul && echo [OK] tunnel running || echo [FAIL] cloudflared not found

echo [6] GPU Provider 服务 (port 8000):
curl -s --max-time 3 http://127.0.0.1:8000/health >nul 2>&1
if %errorLevel%==0 (echo   状态: 运行中 OK) else (echo   状态: 未运行 - 请双击 Start_AorticAI)

echo [7] Cloudflare 隧道:
curl -s --max-time 5 https://api.heartvalvepro.edu.kg/health >nul 2>&1
if %errorLevel%==0 (echo   状态: 公网可访问 OK) else (echo   状态: 隧道未连接)

echo [8] NVIDIA GPU:
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>nul
if %errorLevel% neq 0 echo   未检测到 GPU

echo [9] dcm2niix:
dcm2niix --version 2>&1

echo [10] cloudflared:
cloudflared --version 2>&1

echo.
echo 检查完成 / 请查看上方 [OK]/[FAIL] 状态
echo ===== 诊断完成 =====
pause
