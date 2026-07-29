@echo off
setlocal
set "APP_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_ROOT%scripts\setup-development.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. See the message above.
  pause
  exit /b 1
)
echo.
echo Setup completed.
pause
endlocal
