@echo off
setlocal

taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq AorticAI Tunnel" /T /F >nul 2>nul

echo [AorticAI] 已停止
exit /b 0
