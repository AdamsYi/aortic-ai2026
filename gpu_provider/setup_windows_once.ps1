# AorticAI Windows GPU 一键安装脚本
# 以管理员身份运行一次即可，之后用 Start_AorticAI.bat 启动
# 用法：右键 PowerShell -> "以管理员身份运行" -> 粘贴运行

$ErrorActionPreference = "Stop"

function Log($msg) { Write-Host "[AorticAI] $msg" -ForegroundColor Cyan }
function OK($msg)  { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Fail($msg){ Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }

Log "=== AorticAI Windows GPU 环境安装 ==="

# ── 1. 检查管理员权限 ────────────────────────────────────────────────────────
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Fail "请以管理员身份运行 PowerShell（右键 -> 以管理员身份运行）"
}
OK "管理员权限确认"

# ── 2. 启用 winget（Windows 包管理器） ──────────────────────────────────────
Log "检查 winget..."
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Log "安装 winget..."
    $url = "https://aka.ms/getwinget"
    $tmp = "$env:TEMP\winget.msixbundle"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    Add-AppxPackage $tmp
}
OK "winget 已就绪"

# ── 3. 安装 Git ──────────────────────────────────────────────────────────────
Log "检查 Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Log "安装 Git..."
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    $env:PATH += ";C:\Program Files\Git\cmd"
}
OK "Git 已就绪"

# ── 4. 安装 Python 3.11 ──────────────────────────────────────────────────────
Log "检查 Python 3.11+..."
$pyOK = $false
try {
    $v = & python --version 2>&1
    if ($v -match "3\.1[1-9]") { $pyOK = $true }
} catch {}

if (-not $pyOK) {
    Log "安装 Python 3.11..."
    winget install --id Python.Python.3.11 -e --source winget --accept-package-agreements --accept-source-agreements
    $env:PATH += ";$env:LOCALAPPDATA\Programs\Python\Python311;$env:LOCALAPPDATA\Programs\Python\Python311\Scripts"
}
OK "Python 已就绪"

# ── 5. 安装 dcm2niix ─────────────────────────────────────────────────────────
Log "检查 dcm2niix..."
if (-not (Get-Command dcm2niix -ErrorAction SilentlyContinue)) {
    Log "下载 dcm2niix..."
    $dcmUrl = "https://github.com/rordenlab/dcm2niix/releases/latest/download/dcm2niix_win.zip"
    $dcmZip = "$env:TEMP\dcm2niix.zip"
    $dcmDir = "C:\tools\dcm2niix"
    Invoke-WebRequest -Uri $dcmUrl -OutFile $dcmZip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $dcmDir | Out-Null
    Expand-Archive -Path $dcmZip -DestinationPath $dcmDir -Force
    # PATH に追加
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    if ($machinePath -notlike "*$dcmDir*") {
        [System.Environment]::SetEnvironmentVariable("PATH", "$machinePath;$dcmDir", "Machine")
    }
    $env:PATH += ";$dcmDir"
}
OK "dcm2niix 已就绪"

# ── 6. 安装 cloudflared ──────────────────────────────────────────────────────
Log "检查 cloudflared..."
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Log "安装 cloudflared..."
    winget install --id Cloudflare.cloudflared -e --source winget --accept-package-agreements --accept-source-agreements
}
OK "cloudflared 已就绪"

# ── 7. 检查 NVIDIA 驱动 ──────────────────────────────────────────────────────
Log "检查 NVIDIA GPU..."
try {
    $smi = & nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>&1
    OK "GPU 检测到：$smi"
} catch {
    Warn "未检测到 nvidia-smi，请确认 NVIDIA 驱动已安装（GeForce Experience 更新到最新）"
}

# ── 8. 克隆或更新项目 ────────────────────────────────────────────────────────
$repoDir = "C:\AorticAI"
Log "检查项目目录 $repoDir..."

if (Test-Path "$repoDir\.git") {
    Log "项目已存在，拉取最新代码..."
    Set-Location $repoDir
    git fetch origin main
    git reset --hard origin/main
    OK "代码已更新"
} else {
    # 从当前脚本所在位置推断 remote URL
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $parentDir = Split-Path -Parent $scriptDir
    try {
        $remoteUrl = & git -C $parentDir remote get-url origin 2>&1
        Log "克隆仓库 $remoteUrl -> $repoDir"
        git clone $remoteUrl $repoDir
        OK "克隆完成"
    } catch {
        Warn "无法自动克隆，请手动将项目放到 C:\AorticAI"
        Warn "然后再次运行此脚本或直接运行 Start_AorticAI.bat"
    }
}

# ── 9. 安装 Python 依赖 ──────────────────────────────────────────────────────
$gpuDir = "C:\AorticAI\gpu_provider"
if (Test-Path $gpuDir) {
    Set-Location $gpuDir
    Log "创建 Python 虚拟环境并安装依赖（首次约需 5-10 分钟）..."
    if (-not (Test-Path ".venv\Scripts\python.exe")) {
        python -m venv .venv
    }
    & ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
    & ".venv\Scripts\pip.exe" install -r requirements.txt
    # RTX 4060 on Windows is typically CUDA 12.x; use official cu121 wheels.
    & ".venv\Scripts\pip.exe" install --index-url https://download.pytorch.org/whl/cu121 torch torchvision torchaudio
    OK "Python 依赖安装完成"
} else {
    Warn "未找到 gpu_provider 目录，依赖安装跳过"
}

# ── 10. 创建桌面快捷方式 ─────────────────────────────────────────────────────
Log "创建桌面快捷方式..."
$desktop = [System.Environment]::GetFolderPath("Desktop")

# 启动快捷方式
$startBat = "C:\AorticAI\Start_AorticAI.bat"
if (Test-Path $startBat) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut("$desktop\启动 AorticAI GPU.lnk")
    $sc.TargetPath = $startBat
    $sc.WorkingDirectory = "C:\AorticAI"
    $sc.IconLocation = "C:\Windows\System32\shell32.dll,137"
    $sc.Description = "启动 AorticAI GPU 推理服务"
    $sc.Save()
    OK "桌面快捷方式已创建：启动 AorticAI GPU"
}

# 停止快捷方式
$stopBat = "C:\AorticAI\Stop_AorticAI.bat"
if (Test-Path $stopBat) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut("$desktop\停止 AorticAI GPU.lnk")
    $sc.TargetPath = $stopBat
    $sc.WorkingDirectory = "C:\AorticAI"
    $sc.IconLocation = "C:\Windows\System32\shell32.dll,131"
    $sc.Description = "停止 AorticAI GPU 推理服务"
    $sc.Save()
    OK "桌面快捷方式已创建：停止 AorticAI GPU"
}

# ── 完成 ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor Green
Write-Host "  AorticAI Windows 环境安装完成！" -ForegroundColor Green
Write-Host "══════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "以后只需要：" -ForegroundColor White
Write-Host "  双击桌面上的 [启动 AorticAI GPU] 即可" -ForegroundColor Yellow
Write-Host ""
Write-Host "首次启动会自动检查更新并运行服务" -ForegroundColor White
Write-Host "服务健康检查：http://127.0.0.1:8000/health" -ForegroundColor White
Write-Host ""
