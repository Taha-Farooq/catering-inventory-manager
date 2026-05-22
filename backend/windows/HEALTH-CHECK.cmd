@echo off
setlocal
set "SCRIPT=%~dp0health-check.ps1"
if not exist "%SCRIPT%" (
  echo Health-check file not found: "%SCRIPT%"
  echo Make sure this .cmd file stays in backend\windows next to health-check.ps1
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
pause
