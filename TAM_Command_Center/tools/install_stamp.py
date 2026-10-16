"""Install state for Install_and_Launch.bat (stdlib only). Run with the interpreter the app will use.

  python tools/install_stamp.py ensure   exit 0 if the core modules import (fastapi, uvicorn, pydantic,
                                         openpyxl). That is the ONLY test that decides "installed": a missing or
                                         different stamp never causes a reinstall; it is just rewritten.
                                         exit 1 and a one-line reason if something is missing.
  python tools/install_stamp.py write    record the requirements.txt hash (informational)

The stamp lives in the app folder (<app>/.install_stamp), NOT in .venv, so recreating .venv cannot hide
or fake it. Line endings are normalised before hashing.
"""
from __future__ import annotations

import hashlib
import importlib
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
STAMP = APP_ROOT / ".install_stamp"
CORE_MODULES = ("fastapi", "uvicorn", "pydantic", "openpyxl")


def current_hash() -> str:
    data = (APP_ROOT / "requirements.txt").read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def missing_modules() -> list[str]:
    out = []
    for m in CORE_MODULES:
        try:
            importlib.import_module(m)
        except Exception:
            out.append(m)
    return out


def write_stamp() -> None:
    STAMP.write_text(current_hash() + "\n", encoding="ascii")


def ensure() -> int:
    miss = missing_modules()
    if miss:
        print("packages missing or broken in this Python: " + ", ".join(miss))
        return 1
    try:
        same = STAMP.read_text(encoding="ascii").strip() == current_hash()
    except Exception:
        same = False
    if not same:
        try:
            write_stamp()
        except Exception:
            pass  # read-only folder: the stamp is informational only
        print("packages already importable (requirements stamp was missing or different; rewritten, not reinstalling)")
    else:
        print("packages already importable")
    return 0


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "write":
        write_stamp()
        return 0
    if cmd == "ensure":
        return ensure()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
