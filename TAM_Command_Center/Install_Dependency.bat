@echo off
rem ============================================================================
rem  Creates the app-local .venv and installs the pinned requirements.txt into it.
rem  Does NOT install BLPAPI (workstation-specific; install the Bloomberg-provided
rem  package into .venv yourself) and does NOT need Node.
rem  Offline/locked-down machines: put wheels in a "wheelhouse" folder next to this
rem  file and they are used with --no-index. Respects PIP_INDEX_URL / pip.ini.
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center - install dependencies
pushd "%~dp0"
if errorlevel 1 goto :err_pushd

set "PYTHONUTF8=1"

call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python
echo Base Python: %TAM_PY_SRC%
if defined TAM_PYTHON echo [NOTE] TAM_PYTHON is set: the launchers will use it, NOT the .venv created here. Install the requirements into that interpreter yourself, or clear TAM_PYTHON.

if exist "%CD%\.venv\Scripts\python.exe" goto :have_venv
echo Creating virtual environment in .venv ...
"%TAM_PY_EXE%" %TAM_PY_ARGS% -m venv "%CD%\.venv"
if errorlevel 1 goto :err_venv

:have_venv
"%CD%\.venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)"
if errorlevel 1 goto :err_venv_old

if exist "%CD%\wheelhouse\" goto :offline
echo Installing requirements.txt (needs access to a package index) ...
"%CD%\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r "%CD%\requirements.txt"
if errorlevel 1 goto :err_pip
goto :verify

:offline
echo Installing requirements.txt from the local wheelhouse folder (no index) ...
"%CD%\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-index --find-links "%CD%\wheelhouse" -r "%CD%\requirements.txt"
if errorlevel 1 goto :err_pip

:verify
"%CD%\.venv\Scripts\python.exe" -c "import fastapi, uvicorn, pydantic, sqlite3; print('Imports OK: fastapi', fastapi.__version__, '/ uvicorn', uvicorn.__version__, '/ pydantic', pydantic.__version__)"
if errorlevel 1 goto :err_pip
echo.
echo [OK] Dependencies installed. Run Check_PROD_Environment.bat next.
echo      BLPAPI is not installed by this script; Check_PROD_Environment.bat reports whether it is available.
set "RC=0"
goto :done

:err_pushd
echo [ERROR] Cannot change to the application folder "%~dp0".
set "RC=1"
goto :fail_pause

:err_python
set "RC=1"
goto :fail_pause

:err_venv
echo [ERROR] Could not create the .venv. Is the "venv" module available in that Python?
set "RC=1"
goto :fail_pause

:err_venv_old
echo [ERROR] The existing .venv uses a Python older than 3.10. Delete the .venv folder and run this again.
set "RC=1"
goto :fail_pause

:err_pip
echo [ERROR] Installing or verifying the dependencies failed. Nothing was changed outside .venv.
set "RC=1"
goto :fail_pause

:fail_pause
if not defined TAM_NO_PAUSE pause
popd
endlocal & exit /b %RC%

:done
if not defined TAM_NO_PAUSE pause
popd
endlocal & exit /b 0
