@echo off
title Mail Check
cd /d "%~dp0"

REM Desktop app window — does NOT open Chrome/Edge
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b 0
)

where electron >nul 2>&1
if %errorlevel%==0 (
  start "" electron .
  exit /b 0
)

echo Electron not found. Run: npm install
pause
