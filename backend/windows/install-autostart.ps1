$ErrorActionPreference = "Stop"

$taskName = "CateringAdminResetBackend"
$backendDir = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $backendDir "windows\start-backend.ps1"
$envFile = Join-Path $backendDir ".env"
$exampleEnv = Join-Path $backendDir ".env.example"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or not on PATH. Install Node.js LTS first."
}

if (-not (Test-Path $envFile)) {
  Copy-Item $exampleEnv $envFile
  Write-Host "Created .env from .env.example"
  Write-Host "IMPORTANT: Set ADMIN_RESET_JWT_SECRET in backend\.env before using reset links."
}

if (-not (Test-Path (Join-Path $backendDir "node_modules"))) {
  Write-Host "Installing backend dependencies..."
  Push-Location $backendDir
  try {
    npm install
  } finally {
    Pop-Location
  }
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Installed and started scheduled task: $taskName"
Write-Host "Backend should be available at http://localhost:8787"
