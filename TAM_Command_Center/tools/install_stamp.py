"""Requirements stamp for Install_and_Launch.bat (stdlib only).

  python tools/install_stamp.py check   exit 0 if the .venv was installed from the current
                                        requirements.txt (hash matches) and the core modules import
  python tools/install_stamp.py write   record the current requirements.txt hash in the .venv

Run with the .venv interpreter so the import test covers the venv. Read-only apart from
`write`, which only writes <app>/.venv/tam_requirements.sha256.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
STAMP = APP_ROOT / ".venv" / "tam_requirements.sha256"


def current_hash() -> str:
    data = (APP_ROOT / "requirements.txt").read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "write":
        STAMP.write_text(current_hash() + "\n", encoding="ascii")
        return 0
    if cmd == "check":
        try:
            if STAMP.read_text(encoding="ascii").strip() != current_hash():
                return 1
            import fastapi, uvicorn, pydantic  # noqa: F401
        except Exception:
            return 1
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
