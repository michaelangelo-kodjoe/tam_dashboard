@echo off
rem ============================================================================
rem  TAM Command Center - PRODUCTION launcher (127.0.0.1:8765)
rem  Uses the production database in %LOCALAPPDATA%\TAM_Command_Center.
rem  Test flags are cleared; the server also ignores them on a prod-channel build.
rem  NOT validated on the target Bloomberg Windows environment (see VALIDATION.txt).
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center
pushd "%~dp0"
if errorlevel 1 goto :err_pushd

set "TAM_DEV_MODE="
set "TAM_BAMS_TEST_MODE="
set "TAM_DEV_SEED="
set "PYTHONUTF8=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python

"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode prod --core-only
if errorlevel 1 goto :err_env

echo.
echo Starting TAM Command Center (PRODUCTION) using %TAM_PY_SRC% ...
echo Close this window or press Ctrl+C to stop the server.
start "" /b "%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\open_when_ready.py" --mode prod >nul 2>&1
"%TAM_PY_EXE%" %TAM_PY_ARGS% -m server
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
if "%RC%"=="2" echo [ERROR] Another TAM Command Center instance already uses this database.
if "%RC%"=="3" echo [ERROR] This is a dev-channel build; it refuses to run as PRODUCTION.
if "%RC%"=="4" echo [ERROR] The database was refused (newer schema, foreign file or failed migration). See the log.
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
echo [ERROR] The environment check failed. Fix the FAIL lines above, then try again.
echo         Missing packages? Run Install_Dependency.bat.
set "RC=1"
goto :fail_pause

:fail_pause
if not defined TAM_NO_PAUSE pause
:done
popd
endlocal & exit /b %RC%
