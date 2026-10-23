@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Options Visualizer

call :node_ready
if errorlevel 1 goto missing_or_old_node

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if errorlevel 1 goto rebuild_venv
) else (
  goto create_venv
)
goto check_yfinance

:rebuild_venv
echo Refreshing the local Python environment...
rmdir /s /q ".venv"
if exist ".venv" goto setup_failed

:create_venv
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 (
  py -3 -m venv .venv
) else (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if errorlevel 1 goto missing_python
  python -m venv .venv
)
if errorlevel 1 goto setup_failed

:check_yfinance
".venv\Scripts\python.exe" -c "import yfinance" >nul 2>&1
if errorlevel 1 (
  echo Installing the Yahoo Finance data dependency on first run...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto setup_failed
)

echo Starting Options Visualizer...
node scripts\run-app.mjs
if errorlevel 1 goto launch_failed
exit /b 0

:node_ready
where node >nul 2>&1
if errorlevel 1 exit /b 1
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:missing_or_old_node
echo Options Visualizer needs Node.js 20.11 or newer.
echo Run Install Dependencies.bat or install Node.js from https://nodejs.org/.
pause
exit /b 1

:missing_python
echo Python 3.10 or newer is needed to create the local data environment.
echo Run Install Dependencies.bat, then try again.
pause
exit /b 1

:setup_failed
echo A required dependency is missing. Run Install Dependencies.bat, then try again.
pause
exit /b 1

:launch_failed
echo Options Visualizer could not start. Check the message above.
pause
exit /b 1
