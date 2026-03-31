@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

for %%F in (provider_service.pid provider_uvicorn.pid provider_launcher.pid cloudflared.pid) do (
  if exist %%F (
    set /p PID=<%%F
    taskkill /PID !PID! /T /F >nul 2>nul
  )
)

taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul

for /f "tokens=2 delims==; " %%P in ('wmic process where "name='python.exe' and commandline like '%%provider_service.py%%'" get processid /value 2^>nul ^| find "="') do taskkill /PID %%P /T /F >nul 2>nul
for /f "tokens=2 delims==; " %%P in ('wmic process where "name='python.exe' and commandline like '%%uvicorn app:app%%'" get processid /value 2^>nul ^| find "="') do taskkill /PID %%P /T /F >nul 2>nul
for /f "tokens=2 delims==; " %%P in ('wmic process where "name='cloudflared.exe' and commandline like '%%tunnel run%%'" get processid /value 2^>nul ^| find "="') do taskkill /PID %%P /T /F >nul 2>nul

del /q provider_service.pid >nul 2>nul
del /q provider_uvicorn.pid >nul 2>nul
del /q provider_launcher.pid >nul 2>nul
del /q cloudflared.pid >nul 2>nul

echo [AorticAI] provider and tunnel stopped.
exit /b 0
