@echo off
chcp 65001 > nul

echo ================================================================
echo   AI Agent 动态推理 - 启动应用
echo ================================================================
echo.

REM 检查依赖是否装过
if not exist "%~dp0backend\__pycache__" (
    if not exist "%~dp0frontend\node_modules" (
        echo [警告] 依赖好像没装过，先跑 setup.bat
        echo.
        choice /m "现在自动跑 setup.bat 吗"
        if errorlevel 2 exit /b
        call "%~dp0setup.bat"
    )
)

echo 即将打开两个窗口分别跑后端和前端
echo - 后端窗口标题: Backend (port 8000)
echo - 前端窗口标题: Frontend (port 5173)
echo.
echo 不要关闭这两个窗口！关闭即停止服务。
echo.
echo 浏览器会自动打开 http://localhost:5173
echo.
pause

REM 后端
start "Backend (port 8000)" cmd /k "cd /d %~dp0backend && python main.py"

REM 给后端 3 秒启动时间，再开前端
timeout /t 3 /nobreak > nul

REM 前端
start "Frontend (port 5173)" cmd /k "cd /d %~dp0frontend && npm run dev"

REM 给前端 5 秒启动时间，再打开浏览器
timeout /t 5 /nobreak > nul

REM 打开浏览器
start http://localhost:5173

echo.
echo 已启动后端、前端、浏览器
echo 关闭这个窗口不影响应用运行
echo.
pause
