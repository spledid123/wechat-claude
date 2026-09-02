# 一键卸载：清理依赖与构建产物，可选清理本地数据。
#
# 默认（无参数）只删除可再生产物：node_modules/ .venv/ dist/ .tmp/
#   —— 不碰源码、不碰 .env、不碰微信 token 与对话数据，重跑 setup.cmd 可完全恢复。
#
# 可选参数：
#   -RemoveData  额外删除 .wechat-claude\（微信登录 token、对话数据库、工作区、日志，不可恢复）
#   -RemoveEnv   额外删除 .env（密钥文件）
#   -All         以上全部 + release\（打包产物 zip/exe）
#   -Yes         跳过数据类删除的二次确认（供脚本调用；默认交互确认）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1            # 只清依赖
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -All       # 彻底清理（会确认）
#   或：uninstall.cmd / npm run uninstall

param(
    [switch]$RemoveData,
    [switch]$RemoveEnv,
    [switch]$All,
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if ($All) { $RemoveData = $true; $RemoveEnv = $true }

function Remove-DirSafely {
    param([string]$Name, [string]$Reason)
    $target = Join-Path $repoRoot $Name
    if (-not (Test-Path $target)) {
        Write-Host "  跳过 $Name（不存在）"
        return
    }
    Remove-Item $target -Recurse -Force
    Write-Host "  已删除 $Name （$Reason）" -ForegroundColor Yellow
}

function Confirm-Removal {
    param([string]$Name, [string]$Detail)
    if ($Yes) { return $true }
    $answer = Read-Host "确认删除 $Name ？$Detail [y/N]"
    return $answer -eq 'y' -or $answer -eq 'Y'
}

Write-Host "== 清理可再生产物（源码不受影响）==" -ForegroundColor Green
Remove-DirSafely "node_modules" "Node 依赖，重跑 setup.cmd 恢复"
Remove-DirSafely ".venv" "Python 预处理环境，重跑 setup.cmd 恢复"
Remove-DirSafely "dist" "编译产物，npm run build:app 重新生成"
Remove-DirSafely ".tmp" "诊断/临时文件"

if ($RemoveEnv) {
    Write-Host "== 删除 .env（密钥）==" -ForegroundColor Green
    if (Confirm-Removal ".env" "包含 API 密钥，删除后需重新填写。" ) {
        Remove-DirSafely ".env" "密钥配置"
    }
}

if ($RemoveData) {
    Write-Host "== 删除本地数据 .wechat-claude\ ==" -ForegroundColor Green
    $detail = "包含微信登录 token、对话数据库、会话工作区与日志，删除后需重新扫码登录，历史对话不可恢复。"
    if (Confirm-Removal ".wechat-claude" $detail) {
        Remove-DirSafely ".wechat-claude" "微信 token + 本地数据"
    }
}

if ($All) {
    Write-Host "== 删除打包产物 release\ ==" -ForegroundColor Green
    Remove-DirSafely "release" "构建出的 exe/zip，npm run dist:win:zip 可重新生成"
}

Write-Host ""
Write-Host "卸载完成。源码本身未删除——重跑 setup.cmd 可完全恢复运行环境。" -ForegroundColor Green
Write-Host "若想连源码一起删除，直接删除整个项目文件夹即可。"
