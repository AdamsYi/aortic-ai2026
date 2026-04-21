@echo off
setlocal
chcp 65001 >nul
title AorticAI Launcher

echo ==========================================
echo   AorticAI 主动脉规划系统
echo ==========================================
echo.
echo [1/4] 正在更新代码...
git -C C:\AorticAI pull

echo [1/4] 已完成：代码已更新
echo [2/4] 正在关闭旧进程...
taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq AorticAI Tunnel" /T /F >nul 2>nul
taskkill /IM cloudflared.exe /F >nul 2>nul
rem uvicorn runs as python.exe -m uvicorn; kill whoever holds port 8000
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8000 "') do (
  taskkill /F /PID %%P >nul 2>nul
)

echo [2/4] 正在启动 AI 服务（FastAPI）...
START "AorticAI Provider" /MIN cmd /k "cd /d C:\AorticAI\gpu_provider && set PROVIDER_SECRET=aorticai-internal-2026 && .venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000"

timeout /t 5 /nobreak >nul

echo [3/4] 正在连接云端通道（Cloudflare）...
START "AorticAI Tunnel" /MIN cmd /k "set HTTPS_PROXY=http://127.0.0.1:10808 && cloudflared tunnel run --protocol http2"

timeout /t 5 /nobreak >nul

echo [4/4] 正在检查服务状态...
curl -s http://localhost:8000/health >nul 2>nul && (
  echo [成功] AI 服务已启动
) || (
  echo [失败] AI 服务未启动，请运行 setup_windows_once.ps1 后重试
)

echo.
echo ✅ 系统已就绪！保持此窗口最小化即可。
echo    如需关闭系统，请运行 Stop_AorticAI.bat
echo ==========================================
echo 10 秒后将自动最小化本窗口...
timeout /t 10 /nobreak >nul
powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; if($s.AppActivate('AorticAI Launcher')){Start-Sleep -Milliseconds 200; $s.SendKeys('%% n')}"
exit /b 0
