@echo off
setlocal

echo [AorticAI] pulling latest code...
git -C C:\AorticAI pull

echo [AorticAI] stopping old processes...
taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq AorticAI Tunnel" /T /F >nul 2>nul
taskkill /IM cloudflared.exe /F >nul 2>nul
taskkill /IM uvicorn.exe /F >nul 2>nul

echo [AorticAI] starting FastAPI provider...
START "AorticAI Provider" /MIN cmd /k "cd /d C:\AorticAI\gpu_provider && set PROVIDER_SECRET=aorticai-internal-2026 && .venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000"

timeout /t 5 /nobreak >nul

echo [AorticAI] starting Cloudflare tunnel...
START "AorticAI Tunnel" /MIN cmd /k "set HTTPS_PROXY=http://127.0.0.1:7890 && cloudflared tunnel run --protocol http2"

timeout /t 5 /nobreak >nul

curl -s http://localhost:8000/health && echo [OK] FastAPI running || echo [FAIL] FastAPI not running

echo AorticAI 已启动，请保持此窗口最小化
exit /b 0
