param(
  [switch]$ShowOnly,
  [switch]$KillExisting,
  [int]$AdminPort = 8787,
  [string]$DataDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$entryScript = Join-Path $repoRoot "src\cli.ts"
$nodeModulesBin = Join-Path $repoRoot "node_modules\.bin\tsx.cmd"
$packageJson = Join-Path $repoRoot "package.json"

function Resolve-LocalPath([string]$BaseDir, [string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir ".wechat-claude"))
  }
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $PathValue))
}

function Test-AdminPortAvailable([int]$Port) {
  $listener = $null
  try {
    $address = [System.Net.IPAddress]::Parse("127.0.0.1")
    $listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Get-ListeningProcessIds([int]$Port) {
  $ids = New-Object System.Collections.Generic.List[int]
  $lines = & netstat.exe -ano -p tcp 2>$null
  foreach ($line in $lines) {
    if ($line -notmatch "LISTENING") { continue }
    $columns = @($line -split "\s+" | Where-Object { $_ })
    if ($columns.Count -lt 5) { continue }
    $localAddress = $columns[1]
    if ($localAddress -notmatch "[:.]$Port$") { continue }
    $processId = 0
    if ([int]::TryParse($columns[4], [ref]$processId) -and -not $ids.Contains($processId)) {
      $ids.Add($processId)
    }
  }
  return @($ids)
}

if (-not (Test-Path $entryScript)) {
  throw "src\cli.ts not found: $entryScript"
}

if (-not (Test-Path $packageJson)) {
  throw "package.json not found: $packageJson"
}

if (-not (Test-Path $nodeModulesBin)) {
  throw "tsx not found. Run npm install first in: $repoRoot"
}

Set-Location $repoRoot

$resolvedDataDir = Resolve-LocalPath $repoRoot $DataDir
New-Item -ItemType Directory -Force -Path $resolvedDataDir | Out-Null

$env:WECHAT_CLAUDE_DATA_DIR = $resolvedDataDir
$env:WECHAT_ADMIN_PORT = [string]$AdminPort

if (-not (Test-AdminPortAvailable $AdminPort)) {
  if ($KillExisting) {
    $listeningProcessIds = Get-ListeningProcessIds $AdminPort
    if ($listeningProcessIds.Count -eq 0) {
      throw "Port $AdminPort is already in use, but the owning process could not be identified."
    }
    foreach ($processId in $listeningProcessIds) {
      try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-Host "Stopped existing process on port $AdminPort : PID $processId"
      } catch {
        throw "Failed to stop existing process PID $processId on port $AdminPort. $($_.Exception.Message)"
      }
    }
    Start-Sleep -Milliseconds 500
  } else {
    throw "Port $AdminPort is already in use. Close the old service or rerun with -KillExisting."
  }
}

Write-Host "Repo   : $repoRoot"
Write-Host "Entry  : $entryScript"
Write-Host "Data   : $resolvedDataDir"
Write-Host "Admin  : http://127.0.0.1:$AdminPort/"
Write-Host "Mode   : local full service"
Write-Host ""
Write-Host "Keep this terminal open while testing. Press Ctrl+C once to stop gracefully."

if ($ShowOnly) {
  exit 0
}

& $nodeModulesBin $entryScript
$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "wechat-claude service exited with code $exitCode"
exit $exitCode
