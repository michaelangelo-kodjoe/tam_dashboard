TAM COMMAND CENTER
==================
A personal Technical Account Manager workspace (not a sales CRM). A local web app:
a Python server bound to 127.0.0.1 only, and a browser UI served from it.
Single user. No login. Nothing is reachable from the network.

STATUS: NOT PRODUCTION-READY. This build has not been validated on the target
Bloomberg Windows workstation. Read VALIDATION.txt before relying on it.

*** UPGRADE WARNING (0.2.0-rc2) ***
  The first start of 0.2.0-rc2 migrates an existing database to schema 3 (persistent BAMS
  alert policies; 0003). A pre-migration backup is taken automatically. An older build
  CANNOT open the upgraded database afterwards. Keep the previous zip to roll back, and
  take a manual backup (Settings > Data > Create backup) before the first start.

NEW IN 0.2.0-rc2
  - Rich-text notes (bold, lists, colour; sanitised HTML).
  - Bloomberg Terminal BAMS workbooks (Client, Ticker, Region, Metric, DC Location) are
    detected and converted on import; Polarity (East/West) column; LAST_PRICE polling.
  - Persistent BAMS alert policies; faster BAMS sparklines; desktop notifications (Windows).
  - BLPAPI (blpapi>=3.25.10.1,<4) is listed in requirements.txt.

WHAT IS IN THIS BUILD (0.2.0-rc2, spec runs 1-6)
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

QUICK START
  Unzip the whole archive anywhere (spaces in the path are fine; do NOT run from inside the
  zip). FIRST TIME ONLY: double-click Install_and_Launch.bat. It finds Python 3.10+; creates
  .\.venv and pip-installs requirements.txt ONLY if fastapi, uvicorn, pydantic and openpyxl
  cannot already be imported (it prints why it is or is not installing); runs the PROD
  environment check; offers a Desktop shortcut to Launch_TAM_Command_Center.bat. If BLPAPI is
  missing it says so: BAMS live data will not work, the rest does.
  DAILY: double-click Launch_TAM_Command_Center.bat (or the Desktop shortcut). It never installs.
  It asks which database to use (below), starts the app and opens http://127.0.0.1:8765 .

DATABASE CHOICE (Launch_TAM_Command_Center.bat)
  Databases are the *.db files in %LOCALAPPDATA%\TAM_Command_Center. At launch the list is
  shown (names only) with the last used one marked. Enter, or no key for 10 seconds = keep the
  last used. A number = open that existing one. N = create a NEW empty database: type a name
  (1-40 letters, digits, _ or -); a name that already exists is refused unless you type OPEN
  to open it. The choice is remembered in last_database.txt next to the databases. Nothing is
  ever deleted, renamed or overwritten. An already-set TAM_DB_NAME environment variable is used
  without asking. The chosen database is shown in the console banner. To run two databases at
  the same time, set TAM_PORT (e.g. set TAM_PORT=8766) before the second launch; the second
  launch otherwise stops with "port in use" (exit 5).

UPDATING
  Unzip a newer version next to the old one (or over it) and run its Install_and_Launch.bat once.
  Your databases are NEVER inside this folder: they are in %LOCALAPPDATA%\TAM_Command_Center
  (backups and logs too), so unzipping, replacing or deleting the app folder does not touch
  your data. A newer app upgrades the database on start, after an automatic safety backup.
  A new folder builds its own .venv on first run; unzipping over an old folder reuses it.

FIRST-TIME SETUP (manual alternative to the above)
  1. Unzip the archive to a normal folder, e.g. C:\Tools\TAM_Command_Center
     (avoid synced/network folders).
  2. Double-click Install_Dependency.bat. It creates .\.venv and installs the
     requirements.txt (version ranges for fastapi, uvicorn, pydantic, openpyxl; pip
     picks the rest from your index, so a lagging internal mirror still works) into it.
     Offline/locked-down: create a folder named "wheelhouse" next to this file,
     put the wheels listed in requirements.txt in it, and run the script again.
  3. Double-click Check_PROD_Environment.bat. Every line must be PASS, including
     BLPAPI. It FAILS closed if BLPAPI cannot be imported.
  4. Double-click Launch_TAM_Command_Center.bat. The UI is at
     http://127.0.0.1:8765/ . Settings > General > "Open browser on start"
     makes the launcher open the page for you (default: off).

FILES
  Install_and_Launch.bat         First-time SETUP only: install if needed, check, Desktop shortcut.
  START_HERE.txt                 Short start instructions.
  Launch_TAM_Command_Center.bat  DAILY start: database choice, production, port 8765. Never installs. Clears TAM_DEV_MODE and TAM_BAMS_TEST_MODE.
  Launch_DEV_Preview.bat         DEV preview, port 8766, simulated data. Only works on a
                                 dev-channel package (this release is channel=prod, so it refuses).
  Install_Dependency.bat         Creates .venv and installs requirements.txt (also usable on its own).
  tools\choose_db.py             Database chooser used by the launcher (stdlib only).
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
  TAM_DB_NAME  Database name (bare, 1-40 of A-Za-z0-9_-; the server adds .db; new name = new empty DB).
               Set by the launcher prompt; if already set the prompt is skipped.
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
