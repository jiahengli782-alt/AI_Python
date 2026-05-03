@echo off
chcp 65001 > nul
setlocal

echo ================================================================
echo   AI Agent 动态推理 - 一键安装依赖
echo ================================================================
echo.

REM 检查 Python
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 找不到 Python，请先安装 Python 3.9 或更高版本
    echo        下载地址: https://www.python.org/downloads/
    echo        安装时勾选 "Add Python to PATH"
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] Python %PYVER%

REM 检查 Node
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 找不到 Node.js，请先安装 Node 18 或更高版本
    echo        下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f %%v in ('node --version') do set NODEVER=%%v
echo [OK] Node.js %NODEVER%
echo.

REM 配置国内源
echo [1/4] 配置 pip 清华源 ...
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple > nul 2>&1
echo       完成

echo [2/4] 配置 npm 淘宝源 ...
call npm config set registry https://registry.npmmirror.com > nul 2>&1
echo       完成
echo.

REM 装后端依赖
echo [3/4] 安装后端依赖 (Python) ...
cd /d "%~dp0backend"
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [警告] 清华源失败，尝试阿里源 ...
    pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
    if errorlevel 1 (
        echo [错误] 后端依赖安装失败
        echo        请手动检查网络是否正常、是否需要关闭代理软件
        pause
        exit /b 1
    )
)
echo       后端依赖安装完成
echo.

REM 装前端依赖
echo [4/4] 安装前端依赖 (Node.js) ...
echo       这一步可能需要 3-5 分钟，请耐心等待
cd /d "%~dp0frontend"
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
    echo [错误] 前端依赖安装失败
    pause
    exit /b 1
)
echo       前端依赖安装完成
echo.

echo ================================================================
echo   全部安装完成！
echo.
echo   下一步：
echo     1. 双击 start.bat 启动应用
echo     2. 浏览器自动打开后，在设置里填入你的火山方舟 API Key
echo ================================================================
echo.
pause
