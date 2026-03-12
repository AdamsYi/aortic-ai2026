@echo off
setlocal
cd /d "%~dp0"

if exist provider_service.pid (
  set /p SERVICEPID=<provider_service.pid
  taskkill /PID %SERVICEPID% /T /F >nul 2>nul
)

if exist provider_uvicorn.pid (
  set /p UVICORNPID=<provider_uvicorn.pid
  taskkill /PID %UVICORNPID% /T /F >nul 2>nul
)

del /q provider_service.pid >nul 2>nul
del /q provider_uvicorn.pid >nul 2>nul
