@echo off
setlocal
set "APP_ROOT=%~dp0"
set "ELECTRON_EXE=%APP_ROOT%node_modules\electron\dist\electron.exe"
set "DESKTOP_APP=%APP_ROOT%apps\desktop"

if not exist "%ELECTRON_EXE%" (
  echo Desktop runtime is missing.
  echo Run npm.cmd install in:
  echo %APP_ROOT%
  pause
  exit /b 1
)

if not exist "%DESKTOP_APP%\dist\main.cjs" (
  echo Desktop build is missing.
  echo Run npm.cmd run build in:
  echo %APP_ROOT%
  pause
  exit /b 1
)

start "XHS Comment Analyzer" "%ELECTRON_EXE%" "%DESKTOP_APP%"
endlocal
