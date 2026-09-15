# Tauri 壳构建工具链一次性安装（幂等，可重跑）：
#   1) VS 2022 Build Tools + C++ 工作负载（Rust MSVC 链接器所需，机器级，需管理员/UAC）
#   2) Rustup（stable-msvc 工具链，用户级）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/setup-tauri.ps1
$ErrorActionPreference = "Stop"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- 1) MSVC Build Tools（含 VC 工具集）---
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$needBuildTools = $true
if (Test-Path $vswhere) {
    $vcPath = & $vswhere -products Microsoft.VisualStudio.Product.BuildTools `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    if ($vcPath) {
        $needBuildTools = $false
        Write-Host "[跳过] MSVC Build Tools 已安装：$vcPath"
    }
}
if ($needBuildTools) {
    Write-Host "[安装] VS 2022 Build Tools + VCTools 工作负载（约 3-4GB，静默，需 UAC 确认）..."
    if (-not (Test-Admin)) {
        Write-Warning "当前非管理员窗口，winget 会弹 UAC；若安装失败请以管理员身份重跑本脚本。"
    }
    winget install --id Microsoft.VisualStudio.2022.BuildTools --silent `
        --accept-source-agreements --accept-package-agreements `
        --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "VS Build Tools 安装失败（exit=$LASTEXITCODE）" }
    Write-Host "[完成] MSVC Build Tools 安装结束（3010 = 需重启，属正常）。"
}

# --- 2) Rust（rustup，用户级，stable-msvc）---
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    Write-Host "[安装] Rustup（用户级）..."
    winget install --id Rustlang.Rustup --silent `
        --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Rustup 安装失败（exit=$LASTEXITCODE）" }
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
} else {
    Write-Host "[跳过] Rustup 已安装。"
}
rustup default stable-msvc
if ($LASTEXITCODE -ne 0) { throw "rustup default stable-msvc 失败" }

rustc --version
cargo --version
Write-Host "`nTauri 工具链就绪。" -ForegroundColor Green
