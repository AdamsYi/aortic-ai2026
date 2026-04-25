# process_mao_mianqiang.ps1
# Run this on Windows GPU node to process the mao_mianqiang_preop case

$ErrorActionPreference = "Stop"

# Configuration
$CaseId = "mao_mianqiang_preop"
# Download from R2 (production bucket)
$R2Url = "https://pub-aortic-ct-raw.r2.cloudflarestorage.com/mao_mianqiang_preop/ct_preop.nii.gz"
$CasesDir = "C:\aortic-ai\cases"
$CaseDir = Join-Path $CasesDir $CaseId
$NiftiDest = Join-Path $CaseDir "imaging_hidden\ct_preop.nii.gz"

Write-Host "=== Processing Mao Mianqiang Pre-op CTA ==="
Write-Host "Case ID: $CaseId"
Write-Host "Download URL: $MacUrl"
Write-Host ""

# Create directories
$null = New-Item -Path $CaseDir -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CaseDir "imaging_hidden") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CaseDir "meshes") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CaseDir "artifacts") -ItemType Directory -Force
$null = New-Item -Path (Join-Path $CaseDir "qa") -ItemType Directory -Force

# Download NIfTI from R2
Write-Host "Downloading NIfTI from R2..."
Write-Host "URL: $R2Url"
$ProgressPreference = "SilentlyContinue"
try {
    Invoke-WebRequest -Uri $R2Url -OutFile $NiftiDest -UseBasicParsing
    $size = (Get-Item $NiftiDest).Length / 1MB
    Write-Host "Downloaded: $([math]::Round($size, 1)) MB"
} catch {
    Write-Host "ERROR: Failed to download from R2"
    Write-Host "Error: $_"
    exit 1
}
Write-Host ""

# Run geometry extraction
Write-Host "Running geometry extraction pipeline..."
Set-Location "C:\AorticAI\gpu_provider"

& python -m gpu_provider.process_local_nifti --case-id $CaseId --nifti $NiftiDest
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Geometry extraction failed"
    exit 1
}

Write-Host ""
Write-Host "=== Processing completed! ==="
Write-Host "Meshes: $(Join-Path $CaseDir 'meshes')"
Write-Host ""
Write-Host "Next step: Commit to git"
Write-Host "  cd C:\aortic-ai"
Write-Host "  git add cases/$CaseId"
Write-Host "  git commit -m 'Add mao_mianqiang_preop case'"
Write-Host "  git push"
