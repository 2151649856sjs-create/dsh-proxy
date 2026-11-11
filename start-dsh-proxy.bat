@echo off
setlocal EnableExtensions
rem ===========================================================
rem  dsh-proxy - detached launcher
rem   * auto-detects node.exe
rem   * refuses to start twice (port 8320 already in use)
rem   * clears loopback proxy env vars (keeps a real corporate proxy)
rem   * logs to logs\proxy.log and reports a real reason on failure
rem  ASCII-only on purpose: the bat parser uses the console codepage.
rem ===========================================================
set "HERE=%~dp0"
cd /d "%HERE%"
if not exist "%HERE%logs" mkdir "%HERE%logs"
set "LOG=%HERE%logs\proxy.log"

rem ---- drop only loopback proxies (127.0.0.1 / localhost / ::1) ----
call :clrloop HTTP_PROXY
call :clrloop HTTPS_PROXY
call :clrloop ALL_PROXY
call :clrloop http_proxy
call :clrloop https_proxy
call :clrloop all_proxy

rem --- already running? ---
netstat -ano 2>nul | findstr "LISTENING" | findstr ":8320" >nul
if %errorlevel%==0 (
  echo [INFO] port 8320 is already in use - service looks running already.
  echo        If it misbehaves, stop it first: stop-dsh-proxy.bat
  exit /b 0
)

rem --- locate node ---
set "NODE="
for %%P in (node.exe) do if not defined NODE if not "%%~$PATH:P"=="" set "NODE=%%~$PATH:P"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\npm\node.exe" set "NODE=%APPDATA%\npm\node.exe"
if not defined NODE if exist "%USERPROFILE%\tools\node-v22.23.2-win-x64\node.exe" set "NODE=%USERPROFILE%\tools\node-v22.23.2-win-x64\node.exe"
if not defined NODE for /f "delims=" %%D in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe"
if not defined NODE goto nonode

echo [INFO] node: %NODE%
echo [INFO] launching...
start "dsh-proxy" /min cmd /c ""%NODE%" server.mjs >> "%LOG%" 2>&1"

rem --- verify it actually came up ---
ping -n 4 127.0.0.1 >nul
netstat -ano 2>nul | findstr "LISTENING" | findstr ":8320" >nul
if %errorlevel%==0 (
  echo [OK] service is up: http://127.0.0.1:8320
  exit /b 0
)

echo.
echo [ERROR] service did not come up.
echo         last log lines:
echo ---------------------------------------------
powershell -NoProfile -Command "if (Test-Path '%LOG%') { Get-Content -Path '%LOG%' -Tail 12 -Encoding UTF8 } else { '(no log file)' }"
echo ---------------------------------------------
echo         common causes: bad .env, port taken, node too old.
echo.
pause
exit /b 1

:nonode
echo.
echo [ERROR] Node.js not found.
echo         Install Node 18+ from https://nodejs.org and run this again.
echo.
pause
exit /b 1

rem ---- helper: drop a proxy variable only when it points at loopback ----
:clrloop
set "_N=%~1"
call set "_V=%%%_N%%%"
if not defined _V exit /b 0
echo %_V%| findstr /i /c:"127.0.0.1" /c:"localhost" /c:"::1" >nul
if not errorlevel 1 (
  echo [INFO] cleared loopback proxy %_N%=%_V%
  set "%_N%="
)
exit /b 0
