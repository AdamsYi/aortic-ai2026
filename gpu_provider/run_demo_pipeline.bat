@echo off
chcp 65001 > nul
title AorticAI 演示管线

echo ============================================
echo   AorticAI 演示管线 - 一键生成真实测量值
echo ============================================
echo.

cd /d C:\AorticAI\gpu_provider

:: 检查Python环境
python --version > nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到Python。请先激活conda环境。
    echo 提示：运行 conda activate aorticai 后再试。
    pause
    exit /b 1
)

:: 步骤1：获取演示CT数据
echo [步骤 1/3] 获取演示CT数据...
echo.
if exist "demo_data\demo_ct.nii.gz" (
    echo [ok] 已找到现有演示CT: demo_data\demo_ct.nii.gz
) else (
    python fetch_demo_ct.py --output demo_data
    if errorlevel 1 (
        echo.
        echo [失败] 无法自动下载CT数据。
        echo.
        echo 请手动获取一个心胸CTA的 .nii.gz 文件，放置到：
        echo   C:\AorticAI\gpu_provider\demo_data\demo_ct.nii.gz
        echo.
        echo 推荐公开数据源：
        echo   https://zenodo.org/records/6802614
        echo   https://www.synapse.org/#!Synapse:syn3193805/wiki/217789
        echo.
        pause
        exit /b 2
    )
)

echo.
echo [步骤 2/3] 运行完整几何管线（预计 5-15 分钟）...
echo 注意：如果 TotalSegmentator 未安装，请确认 provider_config.json 中
echo       skip_segmentation_in_dev 为 false，否则会使用已有mask。
echo.

set OUTPUT_DIR=demo_pipeline_output
mkdir %OUTPUT_DIR% 2>nul

python pipeline_runner.py ^
    --input "demo_data\demo_ct.nii.gz" ^
    --output-mask "%OUTPUT_DIR%\segmentation_mask.nii.gz" ^
    --output-json "%OUTPUT_DIR%\result.json" ^
    --device gpu ^
    --quality high ^
    --job-id "demo-run-001" ^
    --study-id "demo-study"

if errorlevel 1 (
    echo.
    echo [失败] 管线运行失败。查看上方错误信息。
    echo 常见问题：
    echo   - TotalSegmentator 未安装: pip install TotalSegmentator
    echo   - 显存不足: 编辑 provider_config.json 设置 "fast_mode": true
    pause
    exit /b 3
)

echo.
echo [步骤 3/3] 保存结果为默认演示病例...
echo.

python save_as_default_case.py --input "%OUTPUT_DIR%\result.json" --case-dir "..\cases\default_clinical_case"

if errorlevel 1 (
    echo [警告] 保存步骤失败，但管线结果已生成在：%OUTPUT_DIR%\
    echo 可手动检查 result.json
) else (
    echo.
    echo ============================================
    echo   成功！真实测量值已更新到默认病例。
    echo   刷新 heartvalvepro.edu.kg 即可查看结果。
    echo ============================================
)

echo.
echo 管线输出目录：%CD%\%OUTPUT_DIR%\
pause
