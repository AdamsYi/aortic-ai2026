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

python -c "import nibabel, scipy, skimage, fastapi, uvicorn; print('deps OK')" >nul 2>nul
if errorlevel 1 (
  echo [AorticAI] Python dependencies are missing or broken.
  echo [AorticAI] Please run gpu_provider\\setup_windows_once.ps1 first.
  exit /b 1
)

set MODEL_DEVICE=gpu
set PIPELINE_QUALITY=high
set PROVIDER_RESPONSE_MODE=callback
set PROVIDER_SECRET=aorticai-internal-2026
if "%AORTICAI_TUNNEL_NAME%"=="" set AORTICAI_TUNNEL_NAME=aortic-gpu

call "%~dp0Stop_AorticAI.bat" >nul 2>nul

if exist provider_service.pid del /q provider_service.pid >nul 2>nul
if exist provider_uvicorn.pid del /q provider_uvicorn.pid >nul 2>nul
if exist cloudflared.pid del /q cloudflared.pid >nul 2>nul

echo [AorticAI] starting provider supervisor...
rem 如首次运行请先执行 preload_models.bat 下载模型权重
START "AorticAI Provider" /MIN cmd /k ".venv\Scripts\python.exe provider_service.py --host 127.0.0.1 --port 8000 --quality fast"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [AorticAI] cloudflared not found in PATH. Provider started without tunnel.
) else (
  echo [AorticAI] starting Cloudflare tunnel %AORTICAI_TUNNEL_NAME%...
  START "AorticAI Tunnel" /MIN cmd /k "set HTTPS_PROXY=http://127.0.0.1:7890 && cloudflared tunnel run --protocol http2"
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
taskkill /FI "WINDOWTITLE eq AorticAI Provider" /T /F >nul 2>nul

START "AorticAI Provider" /MIN cmd /k ".venv\Scripts\python.exe provider_service.py --host 127.0.0.1 --port 8000 --quality fast"

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
