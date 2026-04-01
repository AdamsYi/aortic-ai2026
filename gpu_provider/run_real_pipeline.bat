@echo off
chcp 65001 >nul
cd /d C:\AorticAI\gpu_provider
echo [1/2] git pull...
git -C C:\AorticAI pull
echo [2/2] Running real pipeline...
python download_and_process_tavi.py
pause
