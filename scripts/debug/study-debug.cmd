@echo off
REM Copyright (c) Matt Azar. UNLICENSED — no license is granted.
REM Front door for Study crash/hang debug tools (Windows).
REM No args  → opens the mini-app
REM With args → CLI subcommands (collect, analyze, dumps, sidecar, …)
REM
REM   scripts\debug\study-debug.cmd
REM   scripts\debug\study-debug.cmd collect
REM   scripts\debug\study-debug.cmd analyze --zip path\to\diagnostics.zip

setlocal
set "SCRIPT_DIR=%~dp0"
set "ENTRY=%SCRIPT_DIR%study_debug.py"

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
  echo or analyze a Help → Copy diagnostics zip on another machine.
  exit /b 1
)

REM Optional: better CPU%% on snapshot / watch
REM pip install psutil

if "%~1"=="" (
  %PY% "%ENTRY%" gui
  exit /b %ERRORLEVEL%
)

%PY% "%ENTRY%" %*
exit /b %ERRORLEVEL%
