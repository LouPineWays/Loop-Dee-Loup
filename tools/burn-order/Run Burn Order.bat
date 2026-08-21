@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

start "" "http://localhost:4137"
echo Starting Burn Order at http://localhost:4137
echo Keep this window open while using Burn Order.
echo Press Ctrl+C to stop it.
echo.

node server.mjs

echo.
echo Burn Order has stopped.
pause
