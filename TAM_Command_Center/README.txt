TAM COMMAND CENTER
==================
A personal Technical Account Manager workspace (not a sales CRM). A local web app:
a Python server bound to 127.0.0.1 only, and a browser UI served from it.
Single user. No login. Nothing is reachable from the network.

STATUS: NOT PRODUCTION-READY. This build has not been validated on the target
Bloomberg Windows workstation. Read VALIDATION.txt before relying on it.

WHAT IS IN THIS BUILD (spec phases 1-2)
  Today queue, Accounts, Account Workspace (overview, tasks, activity,
  infrastructure, contacts), Tasks, Quick Capture, Settings, backups.
  NOT in this build (deferred): Operations (schedule sync, bulk upload),
  BAMS monitor, workbook import/export, ChatGPT Bridge. Their pages are
  placeholders and their API routes answer 501.

REQUIREMENTS
  Windows 10/11, Python 3.10 or newer (64-bit), a modern Chrome or Edge.
  No Node.js is needed. Internet access to a Python package index (or a
  "wheelhouse" folder of wheels, see below) is needed once, for Install_Dependency.bat.
  BLPAPI is NOT installed by this package: use the Bloomberg-provided package
  for your workstation.

FIRST-TIME SETUP
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
  Launch_TAM_Command_Center.bat  Production, port 8765. Clears TAM_DEV_MODE and TAM_BAMS_TEST_MODE.
  Launch_DEV_Preview.bat         DEV preview, port 8766, simulated data. Only works on a
                                 dev-channel package (this release is channel=prod, so it refuses).
  Install_Dependency.bat         Creates .venv and installs requirements.txt.
  Check_PROD_Environment.bat     Read-only preflight for production (fails closed, BLPAPI required).
  Check_DEV_Environment.bat      Read-only preflight for DEV (BLPAPI only a warning).
  VERSION.txt                    version, channel (prod), build time, validation state.
  BUILD_MANIFEST.txt             SHA-256 of every shipped file.
  VALIDATION.txt                 What was and was not verified.
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
  Use Settings > Data > Create backup. To remove the app, delete the folder; your data stays in
  %LOCALAPPDATA%\TAM_Command_Center until you delete that too.
