# run_mao_mianqiang.ps1
# Run on Windows GPU node to process Mao Mianqiang pre-op CTA
# This script downloads the NIfTI from R2 and runs the full geometry pipeline

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Mao Mianqiang Pre-op CTA Processing" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$CASE_ID = "mao_mianqiang_preop"
$R2_URL = "https://pub-aortic-ct-raw.r2.cloudflarestorage.com/mao_mianqiang_preop/ct_preop.nii.gz"
$REPO_ROOT = "C:\aortic-ai"
$CASE_DIR = Join-Path $REPO_ROOT "cases" $CASE_ID

Write-Host "Case ID: $CASE_ID" -ForegroundColor Yellow
Write-Host "Source:  $R2_URL" -ForegroundColor Yellow
Write-Host "Target:  $CASE_DIR" -ForegroundColor Yellow
Write-Host ""

# Step 1: Create directories
Write-Host "[1/4] Creating directories..." -NoNewline
$null = New-Item -Path (Join-Path $CASE_DIR "imaging_hidden") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CASE_DIR "meshes") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CASE_DIR "artifacts") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CASE_DIR "qa") -ItemType Directory -Force
Write-Host " Done" -ForegroundColor Green

# Step 2: Download NIfTI from R2
Write-Host "[2/4] Downloading NIfTI from R2..." -NoNewline
$NIFTI_DEST = Join-Path $CASE_DIR "imaging_hidden\ct_preop.nii.gz"
try {
    Invoke-WebRequest -Uri $R2_URL -OutFile $NIFTI_DEST -UseBasicParsing
    $size = [math]::Round((Get-Item $NIFTI_DEST).Length / 1MB, 1)
    Write-Host " Done ($size MB)" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}

# Step 3: Run geometry pipeline
Write-Host "[3/4] Running geometry extraction pipeline..." -ForegroundColor Yellow
Set-Location "C:\aortic-ai\gpu_provider"
try {
    & python -m gpu_provider.process_mao_from_r2
    if ($LASTEXITCODE -ne 0) {
        throw "Pipeline exited with code $LASTEXITCODE"
    }
    Write-Host "[4/4] Pipeline completed successfully!" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Processing Complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output locations:" -ForegroundColor Yellow
Write-Host "  Meshes:     $CASE_DIR\meshes"
Write-Host "  Artifacts:  $CASE_DIR\artifacts"
Write-Host "  NIfTI:      $NIFTI_DEST"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Verify meshes in the qa/ directory"
Write-Host "  2. Commit to git:"
Write-Host "     cd C:\aortic-ai"
Write-Host "     git add cases/$CASE_ID"
Write-Host "     git commit -m 'Add mao_mianqiang_preop clinical case'"
Write-Host "     git push"
Write-Host ""
