@echo off
chcp 65001 > nul
title AorticAI Demo Pipeline

echo ============================================
echo   AorticAI Demo Pipeline - Generate Real Measurements
echo ============================================
echo.

cd /d C:\AorticAI\gpu_provider

:: Check Python environment
python --version > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please activate the conda environment first.
    echo Hint: run conda activate aorticai and try again.
    pause
    exit /b 1
)

:: Step 1: Get demo CT data
echo [Step 1/3] Get demo CT data...
echo.
if exist "demo_data\demo_ct.nii.gz" (
    echo [ok] Found existing demo CT: demo_data\demo_ct.nii.gz
) else (
    python fetch_demo_ct.py --output demo_data
    if errorlevel 1 (
        echo.
        echo [FAILED] Could not download CT data automatically.
        echo.
        echo Please get a cardiothoracic CTA .nii.gz file manually and place it at:
        echo   C:\AorticAI\gpu_provider\demo_data\demo_ct.nii.gz
        echo.
        echo Suggested public data sources:
        echo   https://zenodo.org/records/6802614
        echo   https://www.synapse.org/#!Synapse:syn3193805/wiki/217789
        echo.
        pause
        exit /b 2
    )
)

echo.
echo [Step 2/3] Run full geometry pipeline (estimated 5-15 minutes)...
echo Note: if TotalSegmentator is not installed, make sure provider_config.json has
echo       skip_segmentation_in_dev set to false, otherwise the existing mask will be used.
echo.

set OUTPUT_DIR=demo_pipeline_output
mkdir %OUTPUT_DIR% 2>nul

python pipeline_runner.py --input "demo_data\demo_ct.nii.gz" --output-mask "%OUTPUT_DIR%\segmentation_mask.nii.gz" --output-json "%OUTPUT_DIR%\result.json" --device gpu --quality high --job-id "demo-run-001" --study-id "demo-study"

if errorlevel 1 (
    echo.
    echo [FAILED] Pipeline run failed. Check the error messages above.
    echo Common issues:
    echo   - TotalSegmentator not installed: pip install TotalSegmentator
    echo   - Not enough GPU memory: edit provider_config.json and set "fast_mode": true
    pause
    exit /b 3
)

echo.
echo [Step 3/3] Save results as the default demo case...
echo.

python save_as_default_case.py --input "%OUTPUT_DIR%\result.json" --case-dir "..\cases\default_clinical_case"

if errorlevel 1 (
    echo [WARNING] Save step failed, but pipeline results were generated in: %OUTPUT_DIR%\
    echo You can check result.json manually.
) else (
    echo.
    echo ============================================
    echo   Success! Real measurements were updated in the default case.
    echo   Refresh heartvalvepro.edu.kg to view the results.
    echo ============================================
)

echo.
echo Pipeline output directory: %CD%\%OUTPUT_DIR%\
pause
