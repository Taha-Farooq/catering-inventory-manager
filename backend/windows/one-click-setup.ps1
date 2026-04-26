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
$healthScript = Join-Path $backendDir "windows\health-check.ps1"

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
    Write-Host "Created backend\.env"
  }
}

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).Replace("+","-").Replace("/","_").TrimEnd("=")
}

function Ensure-Secret {
  $lines = Get-Content $envFile
  $secretLineIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^ADMIN_RESET_JWT_SECRET=') { $secretLineIdx = $i; break }
  }
  $needsNew = $true
  if ($secretLineIdx -ge 0) {
    $cur = ($lines[$secretLineIdx] -replace '^ADMIN_RESET_JWT_SECRET=', '').Trim()
    if ($cur -and $cur -notmatch '^replace') { $needsNew = $false }
  }
  if ($needsNew) {
    $secret = New-RandomSecret
    if ($secretLineIdx -ge 0) {
      $lines[$secretLineIdx] = "ADMIN_RESET_JWT_SECRET=$secret"
    } else {
      $lines += "ADMIN_RESET_JWT_SECRET=$secret"
    }
    Set-Content -Path $envFile -Value $lines
    Write-Host "Generated ADMIN_RESET_JWT_SECRET automatically."
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

function Wait-ForHealth {
  for ($i = 1; $i -le 10; $i++) {
    try {
      & $healthScript *> $null
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

Ensure-PortableNode
Ensure-EnvFile
Ensure-Secret
Ensure-Dependencies
Ensure-Task
$healthy = Wait-ForHealth

Write-Host ""
Write-Host "One-click setup complete."
if ($healthy) {
  Write-Host "1) Health check passed automatically."
} else {
  Write-Host "1) Health check did not pass yet. Run: backend\windows\health-check.ps1"
}
Write-Host "2) Generate reset link: cd backend; .\runtime\node\npm.cmd run create-link"
