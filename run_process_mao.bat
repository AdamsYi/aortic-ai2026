@echo off
echo === Mao Mianqiang Pre-op CTA Processing ===
echo.
echo This script will:
echo   1. Download NIfTI from Mac (http://38.59.229.45:8888/ct_preop.nii.gz)
echo   2. Run geometry extraction pipeline
echo   3. Generate STL meshes
echo.
pause
powershell -ExecutionPolicy Bypass -File "C:\aortic-ai\process_mao_mianqiang.ps1"
pause
