@echo off
setlocal EnableExtensions
rem ===========================================================
rem  dsh-proxy - detached launcher
rem  Double-click or:  start-dsh-proxy.bat
rem  Server runs in its own minimized console; closing the
rem  launcher window does NOT stop it. Use stop-dsh-proxy.bat.
rem  ASCII-only on purpose (bat parser uses console codepage).
rem ===========================================================
set "HERE=%~dp0"
if not exist "%HERE%logs" mkdir "%HERE%logs"
cd /d "%HERE%"
start "dsh-proxy" /min node server.mjs
echo [OK] start command sent, service running in background.
exit /b 0
