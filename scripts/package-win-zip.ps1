Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "release\win-unpacked"
$zip = Join-Path $repoRoot "release\WeChat-Claude-win-unpacked.zip"

if (-not (Test-Path $source)) {
  throw "win-unpacked directory not found: $source"
}

if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip -Force
}

Compress-Archive -Path (Join-Path $source "*") -DestinationPath $zip -Force
Write-Host "Created: $zip"
