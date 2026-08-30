@echo off
cd /d "%~dp0"

REM ---- Locate Node.js: system install first, bundled portable runtime second ----
set "PATH=%~dp0runtime\node;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto node_ok

echo [setup] Node.js not found. Downloading portable runtime (~30 MB, one-time only)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path 'runtime' | Out-Null; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip' -OutFile 'runtime\node.zip'; Expand-Archive -Path 'runtime\node.zip' -DestinationPath 'runtime' -Force; if (Test-Path 'runtime\node') { Remove-Item 'runtime\node' -Recurse -Force }; Rename-Item 'runtime\node-v20.18.1-win-x64' 'node'"
if errorlevel 1 goto no_node

del "runtime\node.zip" >nul 2>nul
set "PATH=%~dp0runtime\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto no_node

:node_ok
REM ---- Kill old instances gracefully (only ones on our port) ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "0.0.0.0:17631"') do taskkill /PID %%a /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:17631"') do taskkill /PID %%a /F >nul 2>nul

REM ---- Install deps if missing ----
if exist "node_modules" goto deps_ok

echo [setup] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [error] npm install failed. Check your network and run start.bat again.
  pause
  exit /b 1
)

:deps_ok
echo Starting Near Miss...
echo If the browser does not open, visit: http://127.0.0.1:17631/
echo.

node src\server.js
pause
exit /b 0

:no_node
echo [error] Automatic download failed. Please install Node.js manually, then run start.bat again.
echo         Download: https://nodejs.org/zh-cn
start https://nodejs.org/zh-cn
pause
exit /b 1
