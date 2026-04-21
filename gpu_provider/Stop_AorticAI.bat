@echo off
setlocal

taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq AorticAI Tunnel" /T /F >nul 2>nul
taskkill /IM cloudflared.exe /F >nul 2>nul
rem uvicorn runs as python.exe -m uvicorn; kill whoever holds port 8000
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8000 "') do (
  taskkill /F /PID %%P >nul 2>nul
)

echo [AorticAI] 已停止
exit /b 0
