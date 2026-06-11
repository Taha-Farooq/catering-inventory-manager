$ErrorActionPreference = "Stop"

# Pull the latest backend/server.js (and package.json) from GitHub master,
# restart the scheduled tasks, and run the health check. Use this after a
# fix is merged to master and you want the on-prem backend to pick it up
# without re-running ONE-CLICK-SETUP.cmd.

$repoOwner = "Taha-Farooq"
$repoName  = "catering-inventory-manager"
$branch    = "master"
$rawBase   = "https://raw.githubusercontent.com/$repoOwner/$repoName/$branch"

function Resolve-BackendDir {
  $cursor = $PSScriptRoot
  for ($i = 0; $i -lt 5; $i++) {
    $hasServer = Test-Path (Join-Path $cursor "server.js")
    $hasWindows = Test-Path (Join-Path $cursor "windows\start-backend.ps1")
    if ($hasServer -and $hasWindows) { return $cursor }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  throw "Could not locate backend folder. Keep update-backend.ps1 under backend\windows\."
}

$backendDir   = Resolve-BackendDir
$serverJs     = Join-Path $backendDir "server.js"
$packageJson  = Join-Path $backendDir "package.json"
$portableNpm  = Join-Path $backendDir "runtime\node\npm.cmd"
$healthScript = Join-Path $backendDir "windows\health-check.ps1"

$timestamp = (Get-Date -Format "yyyyMMdd-HHmmss")

function Download-To {
  param([string]$Url, [string]$Dest)
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

Write-Host "Fetching latest backend/server.js from $branch..."
$tempServer = "$serverJs.new"
Download-To "$rawBase/backend/server.js" $tempServer
$serverLen = (Get-Item $tempServer).Length
if ($serverLen -lt 1000) {
  Remove-Item $tempServer -Force
  throw "Downloaded server.js looks invalid ($serverLen bytes). Aborting."
}
$serverContent = Get-Content $tempServer -Raw
if ($serverContent -notmatch "import express from 'express'") {
  Remove-Item $tempServer -Force
  throw "Downloaded server.js does not look like the expected file. Aborting."
}

Write-Host "Fetching latest backend/package.json..."
$tempPackage = "$packageJson.new"
Download-To "$rawBase/backend/package.json" $tempPackage
$newPkgRaw = (Get-Content $tempPackage -Raw).Trim()
$oldPkgRaw = (Get-Content $packageJson  -Raw).Trim()
$depsChanged = ($newPkgRaw -ne $oldPkgRaw)

Write-Host "Backing up current server.js -> server.js.bak.$timestamp"
Copy-Item $serverJs "$serverJs.bak.$timestamp" -Force
Move-Item -Force $tempServer $serverJs

if ($depsChanged) {
  Write-Host "package.json changed; backing up old and installing new dependencies."
  Copy-Item $packageJson "$packageJson.bak.$timestamp" -Force
  Move-Item -Force $tempPackage $packageJson

  [System.IO.Directory]::SetCurrentDirectory($backendDir)
  if (Test-Path $portableNpm) {
    & $portableNpm install --prefix "$backendDir"
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
  } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    npm install --prefix "$backendDir"
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
  } else {
    throw "npm is unavailable. Run ONE-CLICK-SETUP.cmd to install the portable runtime."
  }
} else {
  Remove-Item $tempPackage -Force
}

Write-Host "Stopping any running backend process on port 8787..."
$port = 8787
try {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "  Stopped PID $($c.OwningProcess)"
    } catch {}
  }
} catch {}

# SECURITY (docs/SECURITY_REVIEW.md A4): the previous installer registered a
# SYSTEM-level AtStartup task at a user-writable script path (local
# privilege escalation primitive). Remove it on update so existing installs
# get the fix automatically.
$legacySystemTask = "CateringAdminResetBackend-AtStartup"
if (Get-ScheduledTask -TaskName $legacySystemTask -ErrorAction SilentlyContinue) {
  try {
    Stop-ScheduledTask -TaskName $legacySystemTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacySystemTask -Confirm:$false
    Write-Host "Removed legacy SYSTEM-level startup task (security fix)."
  } catch {
    Write-Host "Could not remove legacy SYSTEM task: $($_.Exception.Message)"
  }
}

Write-Host "Restarting scheduled tasks..."
$taskNames = @("CateringAdminResetBackend-AtLogon")
foreach ($t in $taskNames) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 600
    try {
      Start-ScheduledTask -TaskName $t
      Write-Host "  Started $t"
    } catch {
      Write-Host "  Could not start $t — $($_.Exception.Message)"
    }
  } else {
    Write-Host "  Task not registered: $t (skipping). Run ONE-CLICK-SETUP.cmd to register."
  }
}

Write-Host ""
Write-Host "Waiting a few seconds for the backend to come up..."
Start-Sleep -Seconds 4

if (Test-Path $healthScript) {
  & $healthScript
  $healthExit = $LASTEXITCODE
} else {
  Write-Host "health-check.ps1 not found; skipping health check."
  $healthExit = 0
}

Write-Host ""
if ($healthExit -eq 0) {
  Write-Host "Update complete. Backend is healthy."
} else {
  Write-Host "Update applied but health check did not pass yet."
  Write-Host "Wait 10 seconds and rerun backend\windows\HEALTH-CHECK.cmd."
  Write-Host "If still failing, restore the backup:"
  Write-Host "  copy server.js.bak.$timestamp server.js"
  Write-Host "  then rerun this update."
}
