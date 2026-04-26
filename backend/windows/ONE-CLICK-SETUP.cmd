@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-setup.ps1"
if %errorlevel% neq 0 (
  echo Setup failed. Please screenshot this window and send it to support.
  pause
  exit /b %errorlevel%
)
echo.
echo Setup finished successfully.
pause
