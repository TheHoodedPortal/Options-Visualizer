@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Install dependencies for Options Visualizer
echo.

set "NEED_NODE=0"
set "NEED_PYTHON=0"

call :node_ready
if errorlevel 1 set "NEED_NODE=1"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if errorlevel 1 set "NEED_PYTHON=1"
) else (
  call :python_ready
  if errorlevel 1 set "NEED_PYTHON=1"
)

if "%NEED_NODE%%NEED_PYTHON%"=="00" goto prepare_environment

where winget >nul 2>&1
if errorlevel 1 goto manual_downloads

if "%NEED_NODE%"=="1" (
  winget list --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements 2>nul | findstr /i /c:"OpenJS.NodeJS.LTS" >nul
  if not errorlevel 1 (
    echo Updating Node.js to a supported version...
    winget upgrade --id OpenJS.NodeJS.LTS --exact --source winget
  ) else (
    echo Installing Node.js LTS...
    winget install --id OpenJS.NodeJS.LTS --exact --source winget
  )
  if errorlevel 1 goto node_failed
  set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\nodejs;%PATH%"
  call :node_ready
  if errorlevel 1 goto node_failed
)

if "%NEED_PYTHON%"=="1" (
  echo Installing Python 3.13...
  winget install --id Python.Python.3.13 --exact --source winget
  if errorlevel 1 goto python_failed
  set "PATH=%LocalAppData%\Programs\Python\Python313;%LocalAppData%\Programs\Python\Python313\Scripts;%LocalAppData%\Programs\Python\Launcher;%PATH%"
  call :python_ready
  if errorlevel 1 goto python_failed
)

goto prepare_environment

:node_ready
where node >nul 2>&1
if errorlevel 1 exit /b 1
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:python_ready
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 exit /b 0
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:prepare_environment
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if errorlevel 1 goto recreate_environment
) else (
  goto create_environment
)
goto check_yfinance

:recreate_environment
echo Recreating the local Python environment...
rmdir /s /q ".venv"
if exist ".venv" goto python_environment_failed

:create_environment
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 (
  py -3 -m venv .venv
) else (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if errorlevel 1 goto python_environment_failed
  python -m venv .venv
)
if errorlevel 1 goto python_environment_failed

:check_yfinance
".venv\Scripts\python.exe" -c "import yfinance" >nul 2>&1
if errorlevel 1 (
  echo Installing Yahoo Finance data dependency...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto yfinance_failed
)
goto setup_complete

:manual_downloads
echo Automatic runtime installation is unavailable because winget was not found.
if "%NEED_NODE%"=="1" start "" "https://nodejs.org/en/download"
if "%NEED_PYTHON%"=="1" start "" "https://www.python.org/downloads/windows/"
echo Install the runtime pages that opened, then run Install Dependencies.bat again.
pause
exit /b 1

:node_failed
echo Node.js could not be installed or updated automatically.
start "" "https://nodejs.org/en/download"
echo Install Node.js 20.11 or newer, then run Install Dependencies.bat again.
pause
exit /b 1

:python_failed
echo Python could not be installed automatically.
start "" "https://www.python.org/downloads/windows/"
echo Install Python 3.10 or newer, then run Install Dependencies.bat again.
pause
exit /b 1

:python_environment_failed
echo The local Python environment could not be prepared. Check the Python installation, then run Install Dependencies.bat again.
pause
exit /b 1

:yfinance_failed
echo The Yahoo Finance dependency could not be installed. Check your internet connection, then run Install Dependencies.bat again.
pause
exit /b 1

:setup_complete
echo.
echo Dependencies are ready. Run Open Options Visualizer.bat when you want to start the app.
pause
exit /b 0
