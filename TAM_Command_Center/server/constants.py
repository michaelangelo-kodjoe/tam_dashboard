"""Named constants in one place (PM D-05, D-17, D-22, spec limits).

NOTE: the Today horizons (+14 upgrades, +1..+3 tasks, +4..+14 upcoming, +15..+30
upgrade upcoming) are literal offsets inside db/queries/today_queue.sql, which is
the single source of truth and is executed unmodified. The values below document
them and are asserted against the SQL behaviour in tests/test_today.py.
"""
DEFAULT_VERSION = "0.1.0-dev"
HOST = "127.0.0.1"          # never configurable (spec section 46)
PROD_PORT = 8765
DEV_PORT = 8766
DEV_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")  # Vite dev server

# Today (D-05)
UPGRADE_QUEUE_DAYS = 14
UPCOMING_TASK_QUEUE_DAYS = 3
UPCOMING_PANEL_DAYS = 14
UPCOMING_UPGRADE_DAYS = 30
RECENT_CHANGES_LIMIT = 20
ACCOUNT_LOAD_ROWS = 8

# Activity / lists
ACTIVITY_DEFAULT_LIMIT = 50
ACTIVITY_MAX_LIMIT = 100
TASKS_DEFAULT_LIMIT = 1000
TASKS_MAX_LIMIT = 5000
LOGS_DEFAULT_LIMIT = 200
LOGS_MAX_LIMIT = 1000
BACKUPS_DEFAULT_LIMIT = 20

# Backups (D-22)
AUTO_BACKUP_REASONS = ("pre-delete", "pre-migration")
AUTO_BACKUP_KEEP = 30
MANUAL_BACKUP_REASON = "manual"

# Settings (spec section 39, PM US-11.1)
SETTING_DEFAULTS = {
    "default_landing": "today",
    "time_display": "local",
    "auto_refresh_minutes": "off",
    "log_level": "INFO",
    "open_browser_on_start": "0",
}
SETTING_ENUMS = {
    "default_landing": ("today", "accounts", "tasks"),
    "time_display": ("local", "gmt"),
    "auto_refresh_minutes": ("off", "1", "5", "15"),
    "log_level": ("INFO", "DEBUG"),
}
