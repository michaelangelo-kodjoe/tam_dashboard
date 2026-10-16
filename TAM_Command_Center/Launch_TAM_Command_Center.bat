@echo off
rem ============================================================================
rem  TAM Command Center - DAILY launcher (PRODUCTION, 127.0.0.1:8765)
rem  Never installs anything. First time on a machine: run Install_and_Launch.bat once.
rem  Databases live in %LOCALAPPDATA%\TAM_Command_Center (outside this folder); this file
rem  never deletes or renames one. Test flags are cleared; a prod-channel server ignores them.
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
if not defined TAM_OPEN_BROWSER set "TAM_OPEN_BROWSER=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python

"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode prod --core-only
if errorlevel 1 goto :err_env

rem --- which database? An already-set TAM_DB_NAME is honoured without asking (non-interactive use) ---
set "TAM_DB_SRC=TAM_DB_NAME was already set"
if defined TAM_DB_NAME goto :db_chosen
set "TAM_DB_DIR=%LOCALAPPDATA%\TAM_Command_Center"
set "TAM_DB_OUT=%TEMP%\tam_dbchoice_%RANDOM%.txt"
if exist "%TAM_DB_OUT%" del "%TAM_DB_OUT%" >nul 2>&1
"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\choose_db.py" run --dir "%TAM_DB_DIR%" --out "%TAM_DB_OUT%"
if errorlevel 1 goto :err_dbchoice
if not exist "%TAM_DB_OUT%" goto :err_dbchoice
set /p TAM_DB_NAME=<"%TAM_DB_OUT%"
del "%TAM_DB_OUT%" >nul 2>&1
if not defined TAM_DB_NAME goto :err_dbchoice
set "TAM_DB_SRC=chosen at the prompt"

:db_chosen
echo.
echo ============================================================
echo  TAM Command Center (PRODUCTION)
echo  Database: %TAM_DB_NAME%   (%TAM_DB_SRC%)
echo  Python:   %TAM_PY_SRC%
echo ============================================================
echo Close this window or press Ctrl+C to stop the server.
start "" /b "%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\open_when_ready.py" --mode prod >nul 2>&1
"%TAM_PY_EXE%" %TAM_PY_ARGS% -m server
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
if "%RC%"=="2" echo [ERROR] Another TAM Command Center instance already uses this database.
if "%RC%"=="3" echo [ERROR] This is a dev-channel build; it refuses to run as PRODUCTION.
if "%RC%"=="4" echo [ERROR] The database was refused (newer schema, foreign file or failed migration). See the log.
if "%RC%"=="5" goto :err_port
echo [ERROR] The server stopped with exit code %RC%.
goto :fail_pause

:err_port
echo [ERROR] Port 8765 is already in use (exit code 5). Most likely TAM Command Center is already open
echo         in another window, possibly on a different database. Either close that window first, or run
echo         a second copy at the same time by choosing a free port before starting, for example:
echo             set TAM_PORT=8766
echo             Launch_TAM_Command_Center.bat
echo         then open http://127.0.0.1:8766 . Each database must be open in only one window.
set "RC=5"
goto :fail_pause

:err_dbchoice
echo [ERROR] No database was selected, so nothing was started. Run this file again.
set "RC=1"
goto :fail_pause

:err_pushd
echo [ERROR] Cannot change to the application folder "%~dp0".
set "RC=1"
goto :fail_pause

:err_python
echo         Not set up yet on this computer? Run Install_and_Launch.bat once.
set "RC=1"
goto :fail_pause

:err_env
echo.
echo [ERROR] The environment check failed. Fix the FAIL lines above, then try again.
echo         Packages missing? This daily launcher never installs: run Install_and_Launch.bat once (first-time setup).
set "RC=1"
goto :fail_pause

:fail_pause
if not defined TAM_NO_PAUSE pause
:done
popd
endlocal & exit /b %RC%
