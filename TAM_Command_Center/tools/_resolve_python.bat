@echo off
rem ============================================================================
rem  _resolve_python.bat  (internal helper, called by the other launchers)
rem  Finds a Python 3.10+ interpreter. Order (spec section 47):
rem    1. TAM_PYTHON        (explicit; if set it must be valid, no silent fallback)
rem    2. app-local .venv   (<app>\.venv\Scripts\python.exe)
rem    3. python            (on PATH)
rem    4. py -3             (Windows launcher)
rem  On success: exit /b 0 with TAM_PY_EXE (no quotes) and TAM_PY_ARGS (empty or -3).
rem  On failure: exit /b 1.
rem  No setlocal on purpose: the caller needs the variables. No parenthesised
rem  blocks: paths such as "Program Files (x86)" would break them.
rem ============================================================================
set "TAM_PY_EXE="
set "TAM_PY_ARGS="
set "TAM_PY_SRC="
set "TAM_PYCHECK=import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)"

if not defined TAM_PYTHON goto :try_venv
if not exist "%TAM_PYTHON%" goto :bad_tam_python
"%TAM_PYTHON%" -c "%TAM_PYCHECK%" >nul 2>&1
if errorlevel 1 goto :old_tam_python
set "TAM_PY_EXE=%TAM_PYTHON%"
set "TAM_PY_SRC=TAM_PYTHON"
goto :found

:try_venv
if not exist "%~dp0..\.venv\Scripts\python.exe" goto :try_path
"%~dp0..\.venv\Scripts\python.exe" -c "%TAM_PYCHECK%" >nul 2>&1
if errorlevel 1 goto :try_path
set "TAM_PY_EXE=%~dp0..\.venv\Scripts\python.exe"
set "TAM_PY_SRC=app-local .venv"
goto :found

:try_path
where python >nul 2>&1
if errorlevel 1 goto :try_py
python -c "%TAM_PYCHECK%" >nul 2>&1
if errorlevel 1 goto :try_py
set "TAM_PY_EXE=python"
set "TAM_PY_SRC=python on PATH"
goto :found

:try_py
where py >nul 2>&1
if errorlevel 1 goto :none
py -3 -c "%TAM_PYCHECK%" >nul 2>&1
if errorlevel 1 goto :none
set "TAM_PY_EXE=py"
set "TAM_PY_ARGS=-3"
set "TAM_PY_SRC=py -3"
goto :found

:none
echo [ERROR] No usable Python 3.10 or newer was found.
echo         Tried, in order: TAM_PYTHON, the app-local .venv, "python", "py -3".
echo         Install Python 3.10+ (64-bit) or set TAM_PYTHON to its python.exe, then run Install_Dependency.bat.
exit /b 1

:bad_tam_python
echo [ERROR] TAM_PYTHON is set but the file does not exist: "%TAM_PYTHON%"
echo         Fix or clear TAM_PYTHON. There is no silent fallback.
exit /b 1

:old_tam_python
echo [ERROR] TAM_PYTHON points to a Python older than 3.10 (or not runnable): "%TAM_PYTHON%"
exit /b 1

:found
set "TAM_PYCHECK="
exit /b 0
