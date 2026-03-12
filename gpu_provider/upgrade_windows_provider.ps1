Param(
  [string]$Host = "127.0.0.1",
  [int]$Port = 8000,
  [ValidateSet("fast", "high")] [string]$Quality = "fast",
  [switch]$NoGitPull = $false
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "[1/6] Python version check..."
$pyv = (python --version) 2>$null
if (-not $pyv) {
  throw "python not found in PATH. Install Python 3.11 first."
}
Write-Host "Python: $pyv"

if (-not $NoGitPull) {
  Write-Host "[2/6] Updating repository..."
  try {
    git rev-parse --is-inside-work-tree | Out-Null
    git pull --ff-only
  } catch {
    Write-Warning "git pull skipped: $($_.Exception.Message)"
  }
} else {
  Write-Host "[2/6] Skip git pull (NoGitPull)."
}

Write-Host "[3/6] Preparing venv..."
if (!(Test-Path ".venv")) {
  py -3 -m venv .venv
}
. .\.venv\Scripts\Activate.ps1

Write-Host "[4/6] Installing dependencies..."
python -m pip install --upgrade pip
pip install -r requirements.txt

Write-Host "[5/6] Setting runtime env..."
$env:MODEL_DEVICE = "gpu"
$env:PIPELINE_QUALITY = $Quality
$env:PROVIDER_RESPONSE_MODE = "callback"

Write-Host "[6/6] Starting provider..."
Write-Host "URL: http://${Host}:${Port}"
Write-Host "MODEL_DEVICE=$env:MODEL_DEVICE"
Write-Host "PIPELINE_QUALITY=$env:PIPELINE_QUALITY"
Write-Host "PROVIDER_RESPONSE_MODE=$env:PROVIDER_RESPONSE_MODE"
python .\run_provider_service.py --host $Host --port $Port --quality $Quality --response-mode $env:PROVIDER_RESPONSE_MODE
