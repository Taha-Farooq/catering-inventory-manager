@echo off
setlocal
set "SCRIPT=%~dp0update-backend.ps1"
if not exist "%SCRIPT%" (
  echo Update file not found: "%SCRIPT%"
  echo Make sure this .cmd file stays in backend\windows next to update-backend.ps1
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if %errorlevel% neq 0 (
  echo Update failed. Please screenshot this window and send it to support.
  pause
  exit /b %errorlevel%
)
echo.
pause
