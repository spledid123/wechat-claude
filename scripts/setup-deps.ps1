# 一键安装开发/运行所需的全部依赖：
#   1. Node 依赖（npm install，含构建 exe 所需的 electron 工具链）
#   2. Python 预处理环境（uv 管理，仅 markitdown，约 290MB）
#
# 用法（项目根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/setup-deps.ps1
#   或：npm run setup
#
# 说明：不装 Python 不影响图片理解（vision）与普通聊天，
#       仅 PDF/Office 文档解析不可用。

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "== 1/2 Node 依赖 (npm install) ==" -ForegroundColor Green
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install 失败 (exit=$LASTEXITCODE)。请确认已安装 Node.js。" }
Write-Host "Node 依赖安装完成。" -ForegroundColor Green

Write-Host "== 2/2 Python 预处理环境 (uv) ==" -ForegroundColor Green
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    Write-Warning "未找到 uv，跳过 Python 环境安装。"
    Write-Host "  需要文档解析时，先安装 uv 再重跑本脚本："
    Write-Host "    winget install astral-sh.uv"
    Write-Host "  或手动执行："
    Write-Host "    uv venv .venv"
    Write-Host "    uv pip install -r scripts/preprocess-requirements.txt --python .venv/Scripts/python.exe"
} else {
    if (Test-Path .venv) {
        Write-Host ".venv 已存在，同步依赖..."
    } else {
        uv venv .venv
        if ($LASTEXITCODE -ne 0) { throw "uv venv 失败 (exit=$LASTEXITCODE)。" }
    }
    uv pip install -r scripts/preprocess-requirements.txt --python .venv/Scripts/python.exe
    if ($LASTEXITCODE -ne 0) { throw "uv pip install 失败 (exit=$LASTEXITCODE)。" }
    Write-Host "Python 环境就绪：.venv（markitdown）" -ForegroundColor Green
}

Write-Host ""
Write-Host "全部完成。启动服务：npm start（或 start-wechat-claude.cmd）" -ForegroundColor Green
