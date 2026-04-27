@echo off
setlocal
set "SCRIPT=%~dp0one-click-setup.ps1"
if not exist "%SCRIPT%" (
  echo Setup file not found: "%SCRIPT%"
  echo Make sure this .cmd file stays in backend\windows next to one-click-setup.ps1
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if %errorlevel% neq 0 (
  echo Setup failed. Please screenshot this window and send it to support.
  pause
  exit /b %errorlevel%
)
echo.
echo Setup finished successfully.
pause
