@echo off
chcp 936 >nul
set "RD_DIR=%~dp0"
cd /d "%RD_DIR%"
title dsh-proxy 开关

echo ============================================
echo   双通道网关 (默认端口 8320)
echo   目录: %RD_DIR%
echo ============================================
echo.

netstat -ano 2>nul | findstr "LISTENING" | findstr ":8320" >nul
if %errorlevel%==0 goto running
goto notrunning

:running
echo [状态] 正在运行
echo.
echo   1. 打开看板 (http://127.0.0.1:8320/panel)
echo   2. 重启
echo   3. 停止
echo   4. 关闭窗口
echo.
set /p CH=你的选择: 
if "%CH%"=="1" goto panel
if "%CH%"=="2" goto restart
if "%CH%"=="3" goto stop
goto end

:notrunning
echo [状态] 没有在跑
echo.
echo   直接回车 = 启动   输入 n 回车 = 退出
echo.
set /p CH=你的选择: 
if /i "%CH%"=="n" goto end
goto start

:panel
start "" http://127.0.0.1:8320/panel
goto end

:restart
echo.
call "%RD_DIR%stop-dsh-proxy.bat"
timeout /t 2 >nul
goto start

:stop
echo.
call "%RD_DIR%stop-dsh-proxy.bat"
echo.
echo 已停止。按任意键关闭。
pause >nul
goto end

:start
echo.
call "%RD_DIR%start-dsh-proxy.bat"
echo.
echo 启动命令已发出（网关在后台跑，关窗口不影响）。
echo 等几秒后访问：
echo   接口  http://127.0.0.1:8320/v1
echo   看板  http://127.0.0.1:8320/panel
echo.
echo 要不要现在打开看板？(y/n)
set /p OP=你的选择: 
if /i "%OP%"=="y" start "" http://127.0.0.1:8320/panel
echo.
echo 按任意键关闭。
pause >nul

:end
exit /b
