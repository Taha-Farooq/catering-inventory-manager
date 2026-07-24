@echo off
setlocal
set "SCRIPT=%~dp0remove-autostart.ps1"
if not exist "%SCRIPT%" (
  echo Setup file not found: "%SCRIPT%"
  echo Make sure this .cmd file stays in backend\windows next to remove-autostart.ps1
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if %errorlevel% neq 0 (
  echo Remove auto-start failed. Please screenshot this window and send it to support.
  pause
  exit /b %errorlevel%
)
echo.
echo Auto-start removed successfully.
pause
