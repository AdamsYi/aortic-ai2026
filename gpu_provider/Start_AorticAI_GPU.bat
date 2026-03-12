@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
pip install -r requirements.txt

set MODEL_DEVICE=gpu
set PIPELINE_QUALITY=high
set PROVIDER_RESPONSE_MODE=callback

python run_provider_service.py --host 127.0.0.1 --port 8000 --quality high --response-mode callback --update-interval-seconds 600
