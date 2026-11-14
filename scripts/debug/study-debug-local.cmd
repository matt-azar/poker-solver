@echo off
REM Copyright (c) Matt Azar. UNLICENSED — no license is granted.
REM Local debug launcher (no Cloudflare): starts the Python report receiver
REM on 127.0.0.1, writes webhook config, opens the study-debug mini-app.
REM
REM Double-click or:
REM   scripts\debug\study-debug-local.cmd
REM
REM Installed Study stays separate — use Help → Copy diagnostics zip, then
REM Send report in the mini-app (posts to localhost; saves under
REM %%LOCALAPPDATA%%\Holdem Study\debug-reports).

setlocal
set "SCRIPT_DIR=%~dp0"
set "ENTRY=%SCRIPT_DIR%start_local_debug.py"

if not exist "%ENTRY%" (
  echo error: missing %ENTRY%
  exit /b 2
)

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  where python3 >nul 2>&1 && set "PY=python3"
)
if not defined PY (
  echo error: Python 3.10+ not found on PATH.
  echo Install from https://www.python.org/downloads/ ^(check "Add python.exe to PATH"^)
  pause
  exit /b 1
)

echo Starting local Study debug receiver (no Cloudflare^)...
%PY% "%ENTRY%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
