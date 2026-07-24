$ErrorActionPreference = "Stop"

$backendDir = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $backendDir "logs"
$logFile = Join-Path $logsDir "backend.log"
$portableNodeExe = Join-Path $backendDir "runtime\node\node.exe"
$serverJs = Join-Path $backendDir "server.js"

if (-not (Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

if (-not (Test-Path (Join-Path $backendDir ".env"))) {
  Copy-Item (Join-Path $backendDir ".env.example") (Join-Path $backendDir ".env")
  Add-Content -Path $logFile -Value "[$(Get-Date -Format o)] .env was missing; copied from .env.example"
}

try { $null = [System.IO.File]::ReadAllBytes($serverJs) } catch {
  Add-Content -Path $logFile -Value "[$(Get-Date -Format o)] Could not read server.js at $serverJs ($($_.Exception.Message)). If this folder is in OneDrive, mark it 'Always keep on this device'."
  throw
}

[System.IO.Directory]::SetCurrentDirectory($backendDir)
Set-Location $backendDir
Add-Content -Path $logFile -Value "[$(Get-Date -Format o)] Starting backend..."

if (Test-Path $portableNodeExe) {
  & $portableNodeExe $serverJs *>> $logFile
} else {
  node $serverJs *>> $logFile
}
