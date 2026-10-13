@echo off
rem ============================================================================
rem  Production environment preflight. Read-only: creates no database or folder.
rem  Fails closed: BLPAPI missing = FAIL (spec section 4). Exit code 0 only if
rem  every check passes. Passing this check does NOT make the build validated.
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center - PROD environment check
pushd "%~dp0"
if errorlevel 1 goto :err_pushd

set "TAM_DEV_MODE="
set "TAM_BAMS_TEST_MODE="
set "PYTHONUTF8=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python

echo Python: %TAM_PY_SRC%
"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode prod
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
echo.
echo [FAIL] PROD environment check failed (exit code %RC%).
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
echo [OK] PROD environment check passed.
if not defined TAM_NO_PAUSE pause
popd
endlocal & exit /b 0
