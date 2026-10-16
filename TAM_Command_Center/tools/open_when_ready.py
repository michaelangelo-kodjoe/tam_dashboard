"""Open the browser after the server is up, if the user's setting asks for it.

Honours the stored setting `open_browser_on_start` (Settings > General; stored in
app_meta as `setting.open_browser_on_start`). The database is opened READ-ONLY and
is never created or modified here. Any problem means "do not open" (silent no-op).

Usage: python tools/open_when_ready.py --mode prod|dev
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("prod", "dev"), required=True)
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()
    try:
        from server.config import load_config
        cfg = load_config()
    except BaseException:
        return 0
    if cfg.mode.lower() != args.mode:
        return 0
    url = f"http://127.0.0.1:{cfg.port}/"
    deadline = time.time() + args.timeout
    up = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "api/health", timeout=2) as r:
                up = r.status == 200
                if up:
                    break
        except Exception:
            time.sleep(0.5)
    if not up:
        return 0
    if os.environ.get("TAM_OPEN_BROWSER") == "1":  # set by Install_and_Launch.bat: always open
        webbrowser.open(url)
        return 0
    try:
        uri = cfg.db_path.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2)
        try:
            row = conn.execute("SELECT value FROM app_meta WHERE key='setting.open_browser_on_start'").fetchone()
        finally:
            conn.close()
    except Exception:
        return 0
    if row and row[0] == "1":
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
