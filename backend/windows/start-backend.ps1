$ErrorActionPreference = "Stop"

$backendDir = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $backendDir "logs"
$logFile = Join-Path $logsDir "backend.log"
$portableNodeExe = Join-Path $backendDir "runtime\node\node.exe"

if (-not (Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

if (-not (Test-Path (Join-Path $backendDir ".env"))) {
  Copy-Item (Join-Path $backendDir ".env.example") (Join-Path $backendDir ".env")
  Add-Content -Path $logFile -Value "[$(Get-Date -Format o)] .env was missing; copied from .env.example"
}

Set-Location $backendDir
Add-Content -Path $logFile -Value "[$(Get-Date -Format o)] Starting backend..."

if (Test-Path $portableNodeExe) {
  & $portableNodeExe "server.js" *>> $logFile
} else {
  node "server.js" *>> $logFile
}
