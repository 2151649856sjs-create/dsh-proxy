@echo off
chcp 936 >nul
title DSH反代
cd /d "%~dp0"
echo ============================================
echo   DSH 反向代理
echo   监听: http://127.0.0.1:8320
echo   配置: 同目录 .env 文件（改完要重启）
echo ============================================
node server.mjs
echo.
echo 服务已退出。若是意外退出，把上方报错截图发我。
pause
