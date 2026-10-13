"""Environment preflight for TAM Command Center (spec sections 4, 47, 48).

Usage:  python tools/env_check.py --mode prod|dev [--core-only]

Prints one line per check (PASS / WARN / FAIL / INFO) and exits 0 only when
nothing FAILed (fail closed). It is read-only: it creates no database, no
directory and no file. Stdlib only, so it also runs before dependencies exist.

PROD  : BLPAPI missing is a FAIL (spec section 4: production fails closed).
        --core-only downgrades that single check to INFO; the launcher uses it
        because this build contains no BAMS monitor yet.
DEV   : BLPAPI missing is a WARN (simulated BAMS data is allowed in DEV only).
"""
from __future__ import annotations

import argparse
import importlib
import os
import socket
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
MIN_PY = (3, 10)
REQUIRED_MODULES = ["fastapi", "uvicorn", "pydantic", "starlette", "anyio", "h11"]
REQUIRED_FILES = [
    "server/__main__.py", "server/app.py", "server/config.py",
    "db/migrate.py", "db/schema.sql", "web/index.html", "VERSION.txt", "requirements.txt",
]
PORTS = {"prod": 8765, "dev": 8766}

_results = {"PASS": 0, "WARN": 0, "FAIL": 0, "INFO": 0}


def report(level: str, name: str, detail: str = "") -> None:
    _results[level] += 1
    print(f"[{level:<4}] {name}" + (f": {detail}" if detail else ""))


def read_version() -> dict:
    out: dict = {}
    p = APP_ROOT / "VERSION.txt"
    if p.is_file():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip().lower()] = v.strip()
    return out


def check_python() -> None:
    v = sys.version_info
    ok = (v.major, v.minor) >= MIN_PY
    report("PASS" if ok else "FAIL", "Python >= 3.10",
           f"{v.major}.{v.minor}.{v.micro} at {sys.executable}")
    report("INFO", "Python architecture", f"{'64' if sys.maxsize > 2**32 else '32'}-bit, platform {sys.platform}")
    try:
        import sqlite3
        report("PASS", "sqlite3 module", f"SQLite {sqlite3.sqlite_version}")
    except Exception as exc:  # pragma: no cover
        report("FAIL", "sqlite3 module", repr(exc))


def check_modules() -> None:
    for name in REQUIRED_MODULES:
        try:
            mod = importlib.import_module(name)
            report("PASS", f"module {name}", getattr(mod, "__version__", "version n/a"))
        except Exception as exc:
            report("FAIL", f"module {name}", f"not importable ({exc.__class__.__name__}); run Install_Dependency.bat")


def check_files() -> None:
    for rel in REQUIRED_FILES:
        report("PASS" if (APP_ROOT / rel).is_file() else "FAIL", f"file {rel}")
    for rel in ("db/migrations", "db/queries"):
        d = APP_ROOT / rel
        n = len(list(d.glob("*.sql"))) if d.is_dir() else 0
        report("PASS" if n else "FAIL", f"directory {rel}", f"{n} .sql file(s)")


def check_channel(mode: str) -> str:
    ver = read_version()
    channel = ver.get("channel", "")
    report("INFO", "build", f"version={ver.get('version', '?')} channel={channel or '?'}")
    if channel not in ("dev", "prod"):
        report("FAIL", "VERSION.txt channel", f"{channel!r} is not dev or prod")
    elif mode == "prod" and channel != "prod":
        report("FAIL", "channel matches mode",
               "this is a dev-channel build; it refuses to run in PROD mode (must never touch the production DB)")
    elif mode == "dev" and channel != "dev":
        report("FAIL", "channel matches mode",
               "this is a production-channel release; DEV mode is not honoured on it (the server would run as PROD). "
               "Use a dev-channel build (tools/build_release.py --channel dev) for DEV preview")
    else:
        report("PASS", "channel matches mode", f"{channel}")
    return channel


def check_flags(mode: str) -> None:
    dev, bams = os.environ.get("TAM_DEV_MODE"), os.environ.get("TAM_BAMS_TEST_MODE")
    if mode == "dev":
        report("PASS" if dev == "1" else "FAIL", "TAM_DEV_MODE=1", f"currently {dev!r}")
        report("PASS" if bams == "1" else "WARN", "TAM_BAMS_TEST_MODE=1", f"currently {bams!r}")
    else:
        for name, val in (("TAM_DEV_MODE", dev), ("TAM_BAMS_TEST_MODE", bams)):
            if val not in (None, "", "0"):
                report("FAIL", f"{name} cleared for PROD", f"is {val!r}; PROD launchers clear it")
            else:
                report("PASS", f"{name} cleared for PROD")


def writable_dir_or_creatable(p: Path) -> bool:
    probe = p
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return probe.is_dir() and os.access(probe, os.W_OK)


def check_paths(mode: str) -> None:
    if mode == "prod":
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            level = "FAIL" if sys.platform == "win32" else "WARN"
            report(level, "%LOCALAPPDATA% defined", "not set; the production data folder cannot be resolved")
            return
        d = Path(base) / "TAM_Command_Center"
        report("PASS" if writable_dir_or_creatable(d) else "FAIL", "production data folder writable", str(d))
        db = d / "tam_command_center.db"
        report("INFO", "production database", f"{db} ({'exists' if db.exists() else 'will be created empty on first start'})")
    else:
        d = APP_ROOT / "dev_data"
        report("PASS" if writable_dir_or_creatable(d) else "FAIL", "dev_data folder writable", str(d))
        report("INFO", "DEV database", str(d / "tam_dev.db"))
    stray = []
    for dirpath, dirnames, filenames in os.walk(APP_ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".venv", "dev_data", "node_modules", "__pycache__")]
        stray += [os.path.join(dirpath, f) for f in filenames if f.lower().endswith((".db", ".sqlite", ".sqlite3"))]
    if mode == "prod":
        report("FAIL" if stray else "PASS", "no database files in the application folder",
               ", ".join(str(s) for s in stray[:3]))


def check_port(mode: str) -> None:
    port = int(os.environ.get("TAM_PORT") or PORTS[mode])
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        report("PASS", f"port {port} free on 127.0.0.1")
    except OSError as exc:
        report("WARN", f"port {port} in use", f"{exc}; the app may already be running")
    finally:
        s.close()


def check_blpapi(mode: str, core_only: bool) -> None:
    try:
        import blpapi  # type: ignore
        ver = getattr(blpapi, "__version__", None) or getattr(blpapi, "version", lambda: "version n/a")()
        report("PASS", "BLPAPI (blpapi module) importable", str(ver))
        report("INFO", "BLPAPI session", "not opened; connectivity to the Bloomberg terminal is NOT tested by this check")
    except Exception as exc:
        detail = f"{exc.__class__.__name__}: {exc}"
        if mode == "dev":
            report("WARN", "BLPAPI unavailable", detail + " (DEV may use simulated BAMS data only)")
        elif core_only:
            report("INFO", "BLPAPI unavailable", detail + " (not required by this build: the BAMS monitor is not built yet)")
        else:
            report("FAIL", "BLPAPI unavailable", detail + " (PROD fails closed; simulated BAMS data is never used in PROD)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("prod", "dev"), required=True)
    ap.add_argument("--core-only", action="store_true", help="do not fail PROD when BLPAPI is missing")
    args = ap.parse_args()
    print(f"TAM Command Center environment check ({args.mode.upper()})  app folder: {APP_ROOT}")
    check_python()
    check_files()
    check_channel(args.mode)
    check_flags(args.mode)
    check_modules()
    check_paths(args.mode)
    check_port(args.mode)
    check_blpapi(args.mode, args.core_only)
    if sys.platform != "win32":
        report("WARN", "not running on Windows", "Windows-only behaviour (msvcrt locking, %LOCALAPPDATA%) is not exercised here")
    r = _results
    print(f"Result: {'FAIL' if r['FAIL'] else 'OK'}  ({r['PASS']} pass, {r['WARN']} warn, {r['FAIL']} fail, {r['INFO']} info)")
    return 1 if r["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
