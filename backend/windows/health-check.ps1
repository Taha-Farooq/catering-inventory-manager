$ErrorActionPreference = "Stop"

try {
  $r = Invoke-RestMethod -Method Get -Uri "http://localhost:8787/health" -TimeoutSec 5
  if ($r.ok -eq $true) {
    Write-Host "OK - backend is healthy at http://localhost:8787"
    exit 0
  }
  Write-Host "UNHEALTHY - health endpoint responded without ok=true"
  exit 2
} catch {
  Write-Host "DOWN - unable to reach backend: $($_.Exception.Message)"
  exit 1
}
