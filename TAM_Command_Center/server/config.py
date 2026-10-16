"""Runtime configuration: mode, ports, paths (PM D-17, US-1.2).

Rules
* Host is always 127.0.0.1; there is no setting to change it.
* Mode is DEV only if TAM_DEV_MODE=1 *and* the build channel is dev. A dev-channel
  build without TAM_DEV_MODE=1 refuses to start in PROD mode. On a prod-channel build,
  TAM_DEV_MODE / TAM_BAMS_TEST_MODE are ignored (and reported in `notes`).
* Build channel comes from VERSION.txt (`channel=dev|prod`). A tree without VERSION.txt
  is treated as a dev build (fail closed).
* DEV and PROD database paths can never resolve to the same file.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Mapping, Optional

from . import constants as C
from .errors import StartupRefused

APP_ROOT = Path(__file__).resolve().parent.parent
PROD_DB_NAME = "tam_command_center.db"
DEV_DB_NAME = "tam_dev.db"
DB_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def validate_db_name(name: str) -> str:
    """TAM_DB_NAME: a bare name (the server adds .db). Letters, digits, underscore, hyphen; 1-40 characters; no path
    parts, dots or spaces; not a reserved Windows device name. Raises StartupRefused."""
    if not DB_NAME_RE.match(name):
        raise StartupRefused(
            f"TAM_DB_NAME {name!r} is not allowed. Use 1-40 letters, digits, underscores or hyphens only "
            "(no spaces, dots, slashes or '..'); the server adds .db itself.")
    if name.lower() in _RESERVED:
        raise StartupRefused(f"TAM_DB_NAME {name!r} is a reserved Windows name; choose another.")
    return name


@dataclass(frozen=True)
class Config:
    app_root: Path
    mode: str                 # 'DEV' | 'PROD'
    channel: str              # 'dev' | 'prod'  (the channel stamped on / checked against the DB)
    build_channel: str        # from VERSION.txt
    version: str
    port: int
    db_path: Path
    data_dir: Path
    backup_dir: Path
    log_dir: Path
    web_dir: Path
    dev_seed: bool
    host: str = C.HOST
    notes: List[str] = field(default_factory=list)   # startup notes to log (ignored flags etc.)
    db_name: str = "tam_command_center"              # bare name of the active database (file is <db_name>.db)
    named_db: bool = False                           # True when TAM_DB_NAME selected a non-default database

    @property
    def restore_tmp(self) -> Path:
        """Per-database staging folder, so two databases never share (or delete) each other's staged files."""
        return self.data_dir / ("restore_tmp" if not self.named_db else f"restore_tmp_{self.db_name}")

    @property
    def lock_path(self) -> Path:
        return self.db_path.with_name(self.db_path.name + ".lock")

    @property
    def allowed_origins(self) -> List[str]:
        origins = [f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"]
        if self.mode == "DEV":
            origins += list(C.DEV_ORIGINS)
        return origins

    @property
    def cors_origins(self) -> List[str]:
        return list(C.DEV_ORIGINS) if self.mode == "DEV" else []


def read_version_file(app_root: Path) -> dict:
    out: dict = {}
    p = app_root / "VERSION.txt"
    if p.is_file():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip().lower()] = v.strip()
    return out


def _prod_dir(environ: Mapping[str, str]) -> Path:
    base = environ.get("LOCALAPPDATA")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "TAM_Command_Center"


def load_config(environ: Optional[Mapping[str, str]] = None, app_root: Optional[Path] = None) -> Config:
    env = os.environ if environ is None else environ
    root = Path(app_root) if app_root else APP_ROOT
    vf = read_version_file(root)
    version = vf.get("version", C.DEFAULT_VERSION)
    build_channel = vf.get("channel", "dev").lower()
    if build_channel not in ("dev", "prod"):
        raise StartupRefused(f"VERSION.txt has an invalid channel {build_channel!r} (expected dev or prod).")

    notes: List[str] = []
    want_dev = env.get("TAM_DEV_MODE") == "1"
    if build_channel == "prod":
        for flag in ("TAM_DEV_MODE", "TAM_BAMS_TEST_MODE"):
            if env.get(flag) not in (None, "", "0"):
                notes.append(f"ignored {flag}={env.get(flag)!r}: test flags are not honoured on a production build")
        mode = "PROD"
    else:
        if not want_dev:
            raise StartupRefused(
                "This is a DEV-channel build and TAM_DEV_MODE=1 is not set. A development build refuses to run "
                "in PROD mode (it must never touch the production database). Set TAM_DEV_MODE=1 to run it.")
        mode = "DEV"

    port_s = env.get("TAM_PORT")
    port = C.DEV_PORT if mode == "DEV" else C.PROD_PORT
    if port_s:
        try:
            port = int(port_s)
        except ValueError:
            raise StartupRefused(f"TAM_PORT must be an integer, got {port_s!r}.") from None
        if not 1024 <= port <= 65535:
            raise StartupRefused("TAM_PORT must be between 1024 and 65535.")

    default_name = (DEV_DB_NAME if mode == "DEV" else PROD_DB_NAME)[:-3]
    raw_name = env.get("TAM_DB_NAME")
    db_name = validate_db_name(raw_name.strip()) if raw_name and raw_name.strip() else default_name
    named = db_name != default_name
    prod_dir = _prod_dir(env)
    prod_db = prod_dir / PROD_DB_NAME
    if mode == "DEV":
        data_dir = root / "dev_data"
        db_path = data_dir / f"{db_name}.db"
    else:
        data_dir = prod_dir
        db_path = prod_dir / f"{db_name}.db"
    # The default database keeps the original folders (existing backups stay visible); a named database gets its own
    # backup and log subfolders so backups, logs and staged restores never mix up databases.
    backup_dir = data_dir / "TAM_Backups" / (db_name if named else "")
    log_dir = data_dir / "logs" / (db_name if named else "")
    backup_dir, log_dir = Path(os.path.normpath(backup_dir)), Path(os.path.normpath(log_dir))
    if data_dir.resolve() not in db_path.resolve().parents:
        raise StartupRefused("The database path must stay inside the data folder.")

    # Isolation assertions (US-1.2 AC1)
    if db_path.resolve() == prod_db.resolve() and mode == "DEV":
        raise StartupRefused("DEV database path resolves to the PROD database; refusing to start.")
    if mode == "DEV" and db_path.name.lower() == PROD_DB_NAME:
        raise StartupRefused("DEV mode may not use a database named like the PROD database.")
    if mode == "PROD" and (root / "dev_data").resolve() in db_path.resolve().parents:
        raise StartupRefused("PROD database may not live inside dev_data/.")
    if db_path.exists() and db_path.is_dir():
        raise StartupRefused(f"Database path is a directory: {db_path}")

    dev_seed = mode == "DEV" and env.get("TAM_DEV_SEED", "1") != "0"
    return Config(app_root=root, mode=mode, channel=mode.lower(), build_channel=build_channel, version=version,
                  port=port, db_path=db_path, data_dir=data_dir, backup_dir=backup_dir, log_dir=log_dir,
                  web_dir=root / "web", dev_seed=dev_seed, notes=notes, db_name=db_name, named_db=named)
