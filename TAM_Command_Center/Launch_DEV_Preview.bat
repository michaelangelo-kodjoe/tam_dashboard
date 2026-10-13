@echo off
rem ============================================================================
rem  TAM Command Center - DEV PREVIEW launcher (127.0.0.1:8766)
rem  DEV database: <app>\dev_data\tam_dev.db (never the production database).
rem  Sets TAM_DEV_MODE=1 and TAM_BAMS_TEST_MODE=1 (simulated BAMS data, DEV only).
rem  Works only on a dev-channel build (VERSION.txt channel=dev). A production-
rem  channel release refuses DEV mode (env_check fails) so the production
rem  database can never be mistaken for a test database.
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center - DEV PREVIEW
pushd "%~dp0"
if errorlevel 1 goto :err_pushd

set "TAM_DEV_MODE=1"
set "TAM_BAMS_TEST_MODE=1"
set "PYTHONUTF8=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python

"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode dev
if errorlevel 1 goto :err_env

echo.
echo Starting TAM Command Center (DEV PREVIEW, simulated data) using %TAM_PY_SRC% ...
echo Close this window or press Ctrl+C to stop the server.
start "" /b "%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\open_when_ready.py" --mode dev >nul 2>&1
"%TAM_PY_EXE%" %TAM_PY_ARGS% -m server
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
if "%RC%"=="2" echo [ERROR] Another DEV instance already uses this database.
if "%RC%"=="3" echo [ERROR] The build refused to start in this mode.
if "%RC%"=="4" echo [ERROR] The DEV database was refused. See the log under dev_data\logs.
echo [ERROR] The server stopped with exit code %RC%.
goto :fail_pause

:err_pushd
echo [ERROR] Cannot change to the application folder "%~dp0".
set "RC=1"
goto :fail_pause

:err_python
set "RC=1"
goto :fail_pause

:err_env
echo.
echo [ERROR] The DEV environment check failed. Fix the FAIL lines above, then try again.
set "RC=1"
goto :fail_pause

:fail_pause
if not defined TAM_NO_PAUSE pause
:done
popd
endlocal & exit /b %RC%
