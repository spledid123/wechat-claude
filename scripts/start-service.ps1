param(
  [switch]$ShowOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$entryScript = Join-Path $repoRoot "src\cli.ts"
$nodeModulesBin = Join-Path $repoRoot "node_modules\.bin\tsx.cmd"

if (-not (Test-Path $entryScript)) {
  throw "src\cli.ts not found: $entryScript"
}

if (-not (Test-Path $nodeModulesBin)) {
  throw "tsx not found. Run npm install first."
}

Set-Location $repoRoot

Write-Host "Repo   : $repoRoot"
Write-Host "Entry  : $entryScript"
Write-Host "Data   : $(Join-Path $repoRoot '.wechat-claude')"
Write-Host "Mode   : official service"
Write-Host ""
Write-Host "Keep this terminal open while testing. Later the tray app will run this service without a terminal."

if ($ShowOnly) {
  exit 0
}

& $nodeModulesBin $entryScript
$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "wechat-claude service exited with code $exitCode"
exit $exitCode
