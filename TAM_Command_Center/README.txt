TAM COMMAND CENTER
==================
A personal Technical Account Manager workspace (not a sales CRM). A local web app:
a Python server bound to 127.0.0.1 only, and a browser UI served from it.
Single user. No login. Nothing is reachable from the network.

STATUS: NOT PRODUCTION-READY. This build has not been validated on the target
Bloomberg Windows workstation. Read VALIDATION.txt before relying on it.

WHAT IS IN THIS BUILD (0.1.0-rc3, spec runs 1-6)
  Today queue, Accounts (with bulk import), Account Workspace, Tasks, Quick Capture,
  BAMS monitor and appliance import, Operations (quarters, account-grouped appliances,
  target versions; entered manually), Settings, backups, and portability: Excel export,
  database export, restore from .xlsx/.csv (add-missing-only) and in-app whole-database
  restore. See docs\guides\USER_GUIDE.txt.
  NOT in this build: schedule sync (TEAM/BSSO), start-with-Windows, ChatGPT Bridge (dropped).
  The Bloomberg-facing parts are UNTESTED (see VALIDATION.txt).

REQUIREMENTS
  Windows 10/11, Python 3.10 or newer (64-bit), a modern Chrome or Edge.
  No Node.js is needed. Internet access to a Python package index (or a
  "wheelhouse" folder of wheels, see below) is needed once, for Install_Dependency.bat.
  BLPAPI is NOT installed by this package: use the Bloomberg-provided package
  for your workstation.

QUICK START (one file)
  Unzip the whole archive anywhere (spaces in the path are fine; do NOT run from inside the
  zip), then double-click Install_and_Launch.bat. It: finds Python 3.10+; on first run creates
  .\.venv and pip-installs requirements.txt (skipped later while requirements.txt is
  unchanged); runs the PROD environment check; offers a Desktop shortcut; starts the app and
  opens http://127.0.0.1:8765 . If BLPAPI is missing it says so: BAMS live data will not work,
  the rest does. Install the Bloomberg-provided blpapi package into the .venv to enable BAMS.

UPDATING
  Unzip a newer version next to the old one (or over it) and run its Install_and_Launch.bat.
  Your database is NEVER inside this folder: it is in %LOCALAPPDATA%\TAM_Command_Center
  (backups and logs too), so unzipping, replacing or deleting the app folder does not touch
  your data. A newer app upgrades the database on start, after an automatic safety backup.
  A new folder builds its own .venv on first run; unzipping over an old folder reuses it.

FIRST-TIME SETUP (manual alternative to the above)
  1. Unzip the archive to a normal folder, e.g. C:\Tools\TAM_Command_Center
     (avoid synced/network folders).
  2. Double-click Install_Dependency.bat. It creates .\.venv and installs the
     pinned requirements.txt into it.
     Offline/locked-down: create a folder named "wheelhouse" next to this file,
     put the wheels listed in requirements.txt in it, and run the script again.
  3. Double-click Check_PROD_Environment.bat. Every line must be PASS, including
     BLPAPI. It FAILS closed if BLPAPI cannot be imported.
  4. Double-click Launch_TAM_Command_Center.bat. The UI is at
     http://127.0.0.1:8765/ . Settings > General > "Open browser on start"
     makes the launcher open the page for you (default: off).

FILES
  Install_and_Launch.bat         One-click: install on first run, check, shortcut, launch, open browser.
  START_HERE.txt                 Five-line start instructions.
  Launch_TAM_Command_Center.bat  Production, port 8765. Clears TAM_DEV_MODE and TAM_BAMS_TEST_MODE.
  Launch_DEV_Preview.bat         DEV preview, port 8766, simulated data. Only works on a
                                 dev-channel package (this release is channel=prod, so it refuses).
  Install_Dependency.bat         Creates .venv and installs requirements.txt.
  Check_PROD_Environment.bat     Read-only preflight for production (fails closed, BLPAPI required).
  Check_DEV_Environment.bat      Read-only preflight for DEV (BLPAPI only a warning).
  VERSION.txt                    version, channel (prod), build time, validation state.
  BUILD_MANIFEST.txt             SHA-256 of every shipped file.
  VALIDATION.txt                 What was and was not verified.
  docs\guides\USER_GUIDE.txt     Short guide: Operations, export, restore.
  tools\                         Launcher helpers (env_check.py, open_when_ready.py, _resolve_python.bat).

HOW PYTHON IS FOUND (first match wins, must be 3.10+)
  1. TAM_PYTHON (full path to python.exe). If set, it must be valid; there is no silent fallback.
  2. .\.venv\Scripts\python.exe
  3. python on PATH
  4. py -3

WHERE DATA LIVES
  PRODUCTION  %LOCALAPPDATA%\TAM_Command_Center\tam_command_center.db
              backups: ...\TAM_Backups   logs: ...\logs
  DEV         <app folder>\dev_data\tam_dev.db  (never the production database)
  The release archive contains no database. The first production start creates an
  EMPTY database; production never loads mock data. A DEV database is never copied
  into production. One instance per database: a second start exits with a clear message.
  A safety backup is taken before a schema upgrade and before every delete.

SETTINGS VIA ENVIRONMENT (optional)
  TAM_PORT   Override the port (1024-65535). Defaults: 8765 production, 8766 DEV.
  TAM_NO_PAUSE=1  Do not wait for a key press at the end of a launcher/check (for scripts).

EXIT CODES (server)
  2 another instance holds this database    3 dev-channel build refused PROD mode
  4 database refused (newer schema / foreign file / failed migration)

TROUBLESHOOTING
  "No usable Python 3.10 or newer": install Python or set TAM_PYTHON.
  "module fastapi ... not importable": run Install_Dependency.bat.
  Port in use: another copy is running, or set TAM_PORT.
  Logs: see the logs folder above. Do not send logs outside your organisation without review.

BACKUP / UNINSTALL
  Use Settings > Data > Create backup (or Export database / Export to Excel). To remove the app, delete the folder; your data stays in
  %LOCALAPPDATA%\TAM_Command_Center until you delete that too.
