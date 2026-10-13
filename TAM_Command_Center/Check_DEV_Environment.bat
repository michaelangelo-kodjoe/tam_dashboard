@echo off
rem ============================================================================
rem  DEV environment preflight. Read-only: creates no database or folder.
rem  Sets the DEV test flags for the check only. BLPAPI missing is a WARN in DEV
rem  (simulated BAMS data is allowed in DEV). A production-channel release FAILS
rem  this check by design (DEV mode is not honoured on it).
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center - DEV environment check
pushd "%~dp0"
if errorlevel 1 goto :err_pushd

set "TAM_DEV_MODE=1"
set "TAM_BAMS_TEST_MODE=1"
set "PYTHONUTF8=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python

echo Python: %TAM_PY_SRC%
"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode dev
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
echo.
echo [FAIL] DEV environment check failed (exit code %RC%).
goto :fail_pause

:err_pushd
echo [ERROR] Cannot change to the application folder "%~dp0".
set "RC=1"
goto :fail_pause

:err_python
set "RC=1"
goto :fail_pause

:fail_pause
if not defined TAM_NO_PAUSE pause
popd
endlocal & exit /b %RC%

:done
echo.
echo [OK] DEV environment check passed.
if not defined TAM_NO_PAUSE pause
popd
endlocal & exit /b 0
