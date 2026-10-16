@echo off
rem ============================================================================
rem  TAM Command Center - ONE-CLICK entry point (install on first run, then launch).
rem  Reuses tools\_resolve_python.bat, Install_Dependency.bat, tools\env_check.py and
rem  Launch_TAM_Command_Center.bat. Never touches the database (it lives in
rem  %LOCALAPPDATA%\TAM_Command_Center, outside this folder).
rem  NOT validated on Windows or on the Bloomberg workstation (see VALIDATION.txt).
rem ============================================================================
setlocal EnableExtensions
title TAM Command Center - install and launch

rem --- refuse to run from inside a zip (Explorer preview extracts only this one file) ---
if not exist "%~dp0server\__main__.py" goto :err_incomplete
if not exist "%~dp0tools\_resolve_python.bat" goto :err_incomplete

pushd "%~dp0"
if errorlevel 1 goto :err_pushd
set "TAM_APPDIR=%CD%"

set "TAM_DEV_MODE="
set "TAM_BAMS_TEST_MODE="
set "TAM_DEV_SEED="
set "TAM_NO_PAUSE="
set "PYTHONUTF8=1"

echo ============================================================
echo  TAM Command Center - install and launch
echo  Folder: %CD%
echo ============================================================

echo.
echo [1/5] Looking for Python 3.10 or newer ...
call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python
echo       Found: %TAM_PY_SRC%

echo.
echo [2/5] Python packages ...
if defined TAM_PYTHON goto :tam_python_set
if not exist "%CD%\.venv\Scripts\python.exe" goto :do_install
"%CD%\.venv\Scripts\python.exe" "%CD%\tools\install_stamp.py" check
if errorlevel 1 goto :do_install
echo       Already installed and requirements.txt is unchanged: skipping.
goto :step3

:tam_python_set
echo       TAM_PYTHON is set, so that interpreter is used and no .venv is created.
echo       Install requirements.txt into it yourself if the check below reports missing modules.
goto :step3

:do_install
echo       First run or requirements changed: creating .venv and installing (needs a package index
echo       or a wheelhouse folder). This can take a few minutes ...
set "TAM_NO_PAUSE=1"
call "%CD%\Install_Dependency.bat"
set "RC=%ERRORLEVEL%"
set "TAM_NO_PAUSE="
if not "%RC%"=="0" goto :err_install
"%CD%\.venv\Scripts\python.exe" "%CD%\tools\install_stamp.py" write
if errorlevel 1 goto :err_install

:step3
echo.
echo [3/5] Checking the environment ...
call "%CD%\tools\_resolve_python.bat"
if errorlevel 1 goto :err_python
"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode prod
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :step4
"%TAM_PY_EXE%" %TAM_PY_ARGS% "%CD%\tools\env_check.py" --mode prod --core-only >nul
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :err_env
echo.
echo [NOTE] BLPAPI (Bloomberg Python API) is not installed in this Python.
echo        Bloomberg BAMS live data will NOT work. Everything else works (accounts, tasks,
echo        operations, backups, export/restore). To enable BAMS, install the Bloomberg-provided
echo        blpapi package into this Python (or the .venv here) and run this file again.

:step4
echo.
echo [4/5] Desktop shortcut ...
if exist "%CD%\.tam_shortcut_prompted" goto :step5
choice /c YN /n /t 30 /d N /m "Create a Desktop shortcut 'TAM Command Center'? [Y/N] (N in 30 s) "
if errorlevel 2 goto :shortcut_done
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'TAM Command Center.lnk')); $s.TargetPath=Join-Path $env:TAM_APPDIR 'Install_and_Launch.bat'; $s.WorkingDirectory=$env:TAM_APPDIR; $s.Description='TAM Command Center'; $s.Save()"
if errorlevel 1 goto :shortcut_failed
echo       Shortcut created on the Desktop.
goto :shortcut_done

:shortcut_failed
echo       [WARN] Could not create the shortcut (PowerShell blocked?). Not needed: just run this file again.

:shortcut_done
echo done> "%CD%\.tam_shortcut_prompted"

:step5
echo.
echo [5/5] Starting TAM Command Center. The browser opens at http://127.0.0.1:8765
echo       Keep this window open while you work; close it (or Ctrl+C) to stop the server.
set "TAM_OPEN_BROWSER=1"
call "%CD%\Launch_TAM_Command_Center.bat"
set "RC=%ERRORLEVEL%"
goto :done

:err_incomplete
echo [ERROR] This file is not running from a complete, unzipped folder.
echo         If you opened it from inside the zip (Explorer preview), close it, right-click the
echo         zip, choose "Extract All...", then run Install_and_Launch.bat from the extracted folder.
echo         Folder tested: "%~dp0"
set "RC=1"
pause
exit /b 1

:err_pushd
echo [ERROR] Cannot change to the application folder "%~dp0".
set "RC=1"
goto :fail_pause

:err_python
echo         Install Python 3.10 or newer (64-bit) from python.org, tick "Add python.exe to PATH"
echo         (or keep the "py launcher" option), then run this file again.
set "RC=1"
goto :fail_pause

:err_install
echo [ERROR] Installing the Python packages failed (see messages above). Check the pip index/proxy
echo         access, or put wheels in a "wheelhouse" folder next to this file. Nothing was changed
echo         outside the .venv folder.
set "RC=1"
goto :fail_pause

:err_env
echo.
echo [ERROR] The environment check failed (see FAIL lines above). Fix those, then run this file again.
set "RC=1"
goto :fail_pause

:fail_pause
pause
:done
popd
endlocal & exit /b %RC%
