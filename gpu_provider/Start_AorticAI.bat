@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist "app.py" (
  echo [AorticAI] gpu_provider directory is invalid.
  exit /b 1
)

echo [AorticAI] updating code from origin/main...
git fetch origin main
if errorlevel 1 (
  echo [AorticAI] git fetch failed.
  exit /b 1
)
git reset --hard origin/main
if errorlevel 1 (
  echo [AorticAI] git reset failed.
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [AorticAI] creating Python virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 exit /b 1
  call ".venv\Scripts\activate.bat"
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  if errorlevel 1 exit /b 1
) else (
  call ".venv\Scripts\activate.bat"
)

set MODEL_DEVICE=gpu
set PIPELINE_QUALITY=high
set PROVIDER_RESPONSE_MODE=callback
if "%AORTICAI_TUNNEL_NAME%"=="" set AORTICAI_TUNNEL_NAME=aortic-gpu

call "%~dp0Stop_AorticAI.bat" >nul 2>nul

if exist provider_service.pid del /q provider_service.pid >nul 2>nul
if exist provider_uvicorn.pid del /q provider_uvicorn.pid >nul 2>nul
if exist cloudflared.pid del /q cloudflared.pid >nul 2>nul

echo [AorticAI] starting provider supervisor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '.\.venv\Scripts\python.exe' -ArgumentList 'provider_service.py --host 127.0.0.1 --port 8000 --quality high --response-mode callback --update-interval-seconds 120' -WorkingDirectory '%CD%' -WindowStyle Minimized -PassThru; Set-Content -Path 'provider_launcher.pid' -Value $p.Id"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [AorticAI] cloudflared not found in PATH. Provider started without tunnel.
) else (
  echo [AorticAI] starting Cloudflare tunnel %AORTICAI_TUNNEL_NAME%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cloudflared' -ArgumentList 'tunnel run %AORTICAI_TUNNEL_NAME%' -WorkingDirectory '%CD%' -WindowStyle Minimized -PassThru; Set-Content -Path 'cloudflared.pid' -Value $p.Id"
)

set HEALTH_OK=0
for /L %%I in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3; if ($r.ok -eq $true) { exit 0 } else { exit 2 } } catch { exit 1 }"
  if not errorlevel 1 (
    set HEALTH_OK=1
    goto :health_done
  )
  timeout /t 2 /nobreak >nul
)

:health_done
if "%HEALTH_OK%"=="1" (
  echo [AorticAI] provider healthy at http://127.0.0.1:8000/health
  exit /b 0
)

echo [AorticAI] health check failed, restarting provider once...
if exist provider_service.pid (
  set /p SERVICEPID=<provider_service.pid
  taskkill /PID !SERVICEPID! /T /F >nul 2>nul
)
if exist provider_uvicorn.pid (
  set /p UVPID=<provider_uvicorn.pid
  taskkill /PID !UVPID! /T /F >nul 2>nul
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '.\.venv\Scripts\python.exe' -ArgumentList 'provider_service.py --host 127.0.0.1 --port 8000 --quality high --response-mode callback --update-interval-seconds 120' -WorkingDirectory '%CD%' -WindowStyle Minimized -PassThru; Set-Content -Path 'provider_launcher.pid' -Value $p.Id"

for /L %%I in (1,1,15) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3; if ($r.ok -eq $true) { exit 0 } else { exit 2 } } catch { exit 1 }"
  if not errorlevel 1 (
    echo [AorticAI] provider recovered after restart.
    exit /b 0
  )
  timeout /t 2 /nobreak >nul
)

echo [AorticAI] provider failed health checks after restart.
exit /b 1
