@echo off
title AI_Python Launcher

echo ============================================================
echo   AI_Python - Start Application
echo ============================================================
echo.

REM Check if deps are installed
if not exist "%~dp0frontend\node_modules" (
    echo [ERROR] Frontend dependencies not installed.
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

echo Two windows will open:
echo   - Backend  (port 8000)
echo   - Frontend (port 5173)
echo.
echo Do NOT close those windows. Closing them stops the app.
echo Browser will auto-open http://localhost:5173 after 8 seconds.
echo.
pause

REM Launch backend in a new window
start "Backend - port 8000" cmd /k "cd /d %~dp0backend && python main.py"

REM Wait for backend to start
timeout /t 3 /nobreak >nul

REM Launch frontend in a new window
start "Frontend - port 5173" cmd /k "cd /d %~dp0frontend && npm run dev"

REM Wait for frontend to start
timeout /t 5 /nobreak >nul

REM Open browser
start http://localhost:5173

echo.
echo Backend, frontend and browser launched.
echo You can close THIS window. The two new windows must stay open.
echo.
pause
