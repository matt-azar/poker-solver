@echo off
REM Copyright (c) Matt Azar. UNLICENSED — no license is granted.
REM Automated Study crash/hang capture session (Windows).
REM
REM   scripts\debug\study-debug-session.cmd
REM   scripts\debug\study-debug-session.cmd collect
REM   scripts\debug\study-debug-session.cmd handoff
REM   scripts\debug\study-debug-session.cmd install-startup
REM
REM Ensures LocalDumps, starts local receiver + hang watcher if needed,
REM optionally launches installed Study, one-key collect → CURSOR_DROP.
REM No Cloudflare / gh auth required.

setlocal
set "SCRIPT_DIR=%~dp0"
set "ENTRY=%SCRIPT_DIR%study_debug_session.py"

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

%PY% "%ENTRY%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" if "%~1"=="" pause
exit /b %RC%
