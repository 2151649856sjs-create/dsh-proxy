@echo off
setlocal EnableExtensions
rem ===========================================================
rem  dsh-proxy - stop the listener on port 8320
rem  Only kills the process that owns port 8320. Never touches
rem  other node processes.
rem ===========================================================
set "PORT=8320"
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo [INFO] killing PID %%a
  taskkill /PID %%a /F >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="0" echo [INFO] nothing listening on %PORT% (already stopped)
exit /b 0
