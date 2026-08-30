# 打包源码 zip（用于转移到另一台电脑继续开发）。
#
# 用 git archive 只打包 git 跟踪的文件：源码、脚本、文档、配置，
# 自动排除 node_modules、.venv、.wechat-claude（数据/微信 token）、
# .env（密钥）、release、dist、.git 等。
#
# 注意：只包含已提交的内容——打包前先 git commit 最新改动。
#
# 用法：npm run dist:src:zip

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path release)) {
  New-Item -ItemType Directory -Path release | Out-Null
}

$zip = Join-Path $repoRoot "release\WeChat-Claude-source.zip"
if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip -Force
}

git archive --format=zip --output=$zip HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive 失败 (exit=$LASTEXITCODE)。请确认改动已提交。" }

$size = "{0:N1} MB" -f ((Get-Item $zip).Length / 1MB)
Write-Host "Created: $zip ($size)"
Write-Host "新机器：解压后运行 npm run setup 安装依赖，再把 .env / .wechat-claude 按需放入。"
