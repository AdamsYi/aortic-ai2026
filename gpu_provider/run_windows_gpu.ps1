Param(
  [string]$Host = "0.0.0.0",
  [int]$Port = 8000,
  [string]$TorchIndex = "https://download.pytorch.org/whl/cu124",
  [ValidateSet("fast", "high")] [string]$Quality = "fast",
  [switch]$InstallOptionalAI = $false
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (!(Test-Path ".venv")) {
  py -3 -m venv .venv
}

. .\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip

# GPU stack (adjust TorchIndex if your CUDA driver requires another build).
pip install torch torchvision torchaudio --index-url $TorchIndex
pip install -r requirements.txt

if ($InstallOptionalAI) {
  pip install -r requirements_ai_optional.txt
}

$env:MODEL_DEVICE = "gpu"
$env:PIPELINE_QUALITY = $Quality
$env:PROVIDER_RESPONSE_MODE = "callback"

Write-Host "Starting GPU provider on $Host:$Port ..."
Write-Host "MODEL_DEVICE=$env:MODEL_DEVICE"
Write-Host "PIPELINE_QUALITY=$env:PIPELINE_QUALITY"

uvicorn app:app --host $Host --port $Port
