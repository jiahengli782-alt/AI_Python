@echo off
title AI_Python Setup

echo ============================================================
echo   AI_Python - Install Dependencies
echo ============================================================
echo.

REM Step 1: Check Python
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found.
    echo         Please install Python 3.9+ from https://www.python.org/downloads/
    echo         Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)
echo [OK] Python is installed
python --version

REM Step 2: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js is installed
node --version
echo.

REM Step 3: Configure mirrors (one-time)
echo [Step 1/3] Configuring China mirrors...
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple >nul 2>nul
call npm config set registry https://registry.npmmirror.com >nul 2>nul
echo Done.
echo.

REM Step 4: Install backend deps
echo [Step 2/3] Installing backend dependencies (Python)...
echo This may take 1-3 minutes.
echo.
pushd "%~dp0backend"
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [WARN] Tsinghua mirror failed, trying Aliyun mirror...
    pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
    if errorlevel 1 (
        echo.
        echo [ERROR] Backend deps install failed.
        echo         Check your internet connection or disable VPN/proxy.
        popd
        pause
        exit /b 1
    )
)
popd
echo Backend deps OK.
echo.

REM Step 5: Install frontend deps
echo [Step 3/3] Installing frontend dependencies (Node.js)...
echo This may take 3-10 minutes. Please be patient.
echo.
pushd "%~dp0frontend"
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo.
    echo [ERROR] Frontend deps install failed.
    echo         Try: cd frontend ^&^& rmdir /s /q node_modules ^&^& npm install
    popd
    pause
    exit /b 1
)
popd
echo Frontend deps OK.
echo.

echo ============================================================
echo   ALL DONE!
echo.
echo   Next step:
echo     1. Double-click start.bat to launch the app
echo     2. Browser will auto-open. Fill in your Doubao API Key
echo        in the settings panel.
echo ============================================================
echo.
pause
