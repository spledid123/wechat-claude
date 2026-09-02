# 一键机器引导：从零（或半零）到可运行。
#
# 在 scripts/setup-deps.ps1（npm install + uv venv）之上，先补齐系统级前置：
#   0. 操作系统检查（仅正式支持 Windows 10 1709+ / Windows 11 x64）
#   1. Node.js ≥ 20（缺失时经 winget 安装 LTS；推荐 22 LTS）
#   2. uv（缺失时经 winget 安装；Python 本体由 uv 托管，无需手动安装）
#   3. .env 不存在时从 .env.example 复制一份并提示填写
#   4. 调用 scripts/setup-deps.ps1 完成依赖安装
#
# 用法（项目根目录）：
#   双击 setup.cmd
#   或：powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1
#
# 脚本幂等：装完 Node/uv 后如本会话仍找不到命令，重跑一次即可续上。

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ---------- 0. 操作系统检查 ----------

# 注意不用 $IsWindows：Windows PowerShell 5.1 无此自动变量，StrictMode 下会报错。
if ($env:OS -ne "Windows_NT" -or [System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "仅正式支持 Windows 10（1709+）/ Windows 11 x64。macOS/Linux 需手动配置（见 README 环境要求）。"
}
if ([System.Environment]::OSVersion.Version.Build -lt 16299) {
    throw "Windows 版本过低（build $([System.Environment]::OSVersion.Version.Build)）。需要 Windows 10 1709（build 16299）及以上。"
}

# ---------- 工具函数 ----------

function Refresh-PathFromRegistry {
    # winget 装完后，当前会话的 PATH 不会自动更新；从注册表重新读取机器+用户 PATH。
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Find-Uv {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = "$env:USERPROFILE\.local\bin\uv.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Test-Winget {
    return $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
}

# ---------- 1. Node.js ----------

Write-Host "== [1/4] Node.js ==" -ForegroundColor Green
$nodePath = Find-Node
if ($nodePath) {
    $nodeVersion = (& $nodePath -v) -replace '^v', ''
    Write-Host "已安装 Node.js v$nodeVersion ($nodePath)"
    $major = ($nodeVersion -split '\.')[0]
    if ([int]$major -lt 20) {
        Write-Warning "Node.js 版本过低（v$nodeVersion），项目要求 >= 20（推荐 22 LTS）。"
        Write-Host "  建议升级：winget install OpenJS.NodeJS.LTS"
    }
} elseif (Test-Winget) {
    Write-Host "未找到 Node.js，正在通过 winget 安装 LTS 版（约几分钟）..."
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warning "winget 安装 Node.js 失败 (exit=$LASTEXITCODE)。" }
    Refresh-PathFromRegistry
    $nodePath = Find-Node
}

if (-not $nodePath) {
    throw @"
未找到 Node.js，且自动安装未成功。请手动安装后重跑本脚本：
  下载：https://nodejs.org/zh-cn （选择 22 LTS，x64 安装包）
  或：winget install OpenJS.NodeJS.LTS
安装完成后重新运行 setup.cmd 即可继续（已装的部分会自动跳过）。
"@
}

# ---------- 2. uv ----------

Write-Host "== [2/4] uv（Python 包管理，Python 本体由 uv 托管）==" -ForegroundColor Green
$uvPath = Find-Uv
if ($uvPath) {
    Write-Host "已安装 uv ($uvPath)"
} elseif (Test-Winget) {
    Write-Host "未找到 uv，正在通过 winget 安装（很小，几秒）..."
    winget install --id astral-sh.uv --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warning "winget 安装 uv 失败 (exit=$LASTEXITCODE)。" }
    Refresh-PathFromRegistry
    $uvPath = Find-Uv
}

if (-not $uvPath) {
    Write-Warning @"
未找到 uv，将跳过 Python 预处理环境（不影响普通聊天与图片理解，仅 PDF/Office/扫描版解析不可用）。
之后可补装再重跑本脚本：
  winget install astral-sh.uv
  或：irm https://astral.sh/uv/install.ps1 | iex
"@
}

# ---------- 3. .env ----------

Write-Host "== [3/4] .env 配置文件 ==" -ForegroundColor Green
if (Test-Path "$repoRoot\.env") {
    Write-Host ".env 已存在，跳过。"
} elseif (Test-Path "$repoRoot\.env.example") {
    Copy-Item "$repoRoot\.env.example" "$repoRoot\.env"
    Write-Host "已从 .env.example 创建 .env —— 请编辑填入 ANTHROPIC_BASE_URL 与 API Key/Token。" -ForegroundColor Yellow
    Write-Host "  位置：$repoRoot\.env"
} else {
    Write-Host "未找到 .env.example，跳过（可稍后手动创建 .env）。"
}

# ---------- 4. 项目依赖 ----------

Write-Host "== [4/4] 项目依赖（npm + Python venv）==" -ForegroundColor Green
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\setup-deps.ps1"
if ($LASTEXITCODE -ne 0) { throw "setup-deps.ps1 失败 (exit=$LASTEXITCODE)。" }

Write-Host ""
Write-Host "全部完成。后续步骤：" -ForegroundColor Green
Write-Host "  1. 编辑 .env 填入 API 密钥（若尚未填写）"
Write-Host "  2. 启动服务：npm start（或双击 start-wechat-claude.cmd）"
Write-Host "  3. 打开管理面板扫码登录微信（无 token 时服务会等待）"
