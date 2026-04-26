$ErrorActionPreference = "Stop"

$taskName = "CateringAdminResetBackend"
$backendDir = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $backendDir "runtime"
$portableNodeDir = Join-Path $runtimeRoot "node"
$portableNodeExe = Join-Path $portableNodeDir "node.exe"
$portableNpmCmd = Join-Path $portableNodeDir "npm.cmd"
$envFile = Join-Path $backendDir ".env"
$exampleEnv = Join-Path $backendDir ".env.example"
$startScript = Join-Path $backendDir "windows\start-backend.ps1"

$nodeVersion = "v22.14.0"
$nodeZipUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
$nodeZipFile = Join-Path $runtimeRoot "node.zip"

function Ensure-PortableNode {
  if (Test-Path $portableNodeExe) { return }
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Write-Host "Downloading portable Node runtime..."
  Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipFile

  $extractDir = Join-Path $runtimeRoot "extract"
  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  Expand-Archive -Path $nodeZipFile -DestinationPath $extractDir -Force
  $expanded = Get-ChildItem $extractDir -Directory | Select-Object -First 1
  if (-not $expanded) { throw "Failed to extract Node runtime." }
  if (Test-Path $portableNodeDir) { Remove-Item $portableNodeDir -Recurse -Force }
  Move-Item $expanded.FullName $portableNodeDir
  Remove-Item $extractDir -Recurse -Force
  Remove-Item $nodeZipFile -Force
}

function Ensure-EnvFile {
  if (-not (Test-Path $envFile)) {
    Copy-Item $exampleEnv $envFile
    Add-Content -Path $envFile -Value "ADMIN_RESET_JWT_SECRET=replace-this-with-a-long-random-secret"
    Write-Host "Created backend\.env"
  }
}

function Ensure-Dependencies {
  if (Test-Path (Join-Path $backendDir "node_modules")) { return }
  Write-Host "Installing backend dependencies..."
  Push-Location $backendDir
  try {
    if (Test-Path $portableNpmCmd) {
      & $portableNpmCmd install
    } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
      npm install
    } else {
      throw "npm is unavailable."
    }
  } finally {
    Pop-Location
  }
}

function Ensure-Task {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
}

Ensure-PortableNode
Ensure-EnvFile
Ensure-Dependencies
Ensure-Task

Write-Host ""
Write-Host "One-click setup complete."
Write-Host "1) Edit backend\.env and set ADMIN_RESET_JWT_SECRET."
Write-Host "2) Health check: backend\windows\health-check.ps1"
Write-Host "3) Generate reset link: cd backend; .\runtime\node\npm.cmd run create-link"
