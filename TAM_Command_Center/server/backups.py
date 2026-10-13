"""Safety / manual backups with the SQLite online backup API (spec section 36).

Never a naive file copy or file replacement of a live WAL database. Files are named
`tam_<UTC stamp>_<reason>_v<schema>.db` so retention can prune only automatic ones
(D-22: pre-delete and pre-migration keep the 30 most recent; manual never pruned).
"""
from __future__ import annotations

import datetime as _dt
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List

from . import constants as C
from .dbkit import migrate
from .errors import BackupFailed

log = logging.getLogger("tam.backup")
_NAME_RE = re.compile(r"^tam_(\d{8}T\d{12}Z)_([a-z][a-z-]*)_v(\d+)\.db$")


class BackupService:
    def __init__(self, backup_dir: Path) -> None:
        self.backup_dir = Path(backup_dir)

    def create(self, conn: sqlite3.Connection, reason: str) -> Dict[str, Any]:
        """Take an online backup of `conn`'s database. Raises BackupFailed on any problem."""
        if not re.fullmatch(r"[a-z][a-z-]*", reason):
            raise ValueError(f"bad backup reason {reason!r}")
        if conn.in_transaction:
            raise BackupFailed("internal: backup attempted inside an open transaction")
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        try:
            version = migrate.current_version(conn)
            dest = self.backup_dir / f"tam_{stamp}_{reason}_v{version}.db"
            migrate.online_backup(conn, dest)  # sqlite3 backup API + integrity_check on the copy
        except Exception as exc:
            log.error("backup (%s) failed: %s", reason, exc)
            try:
                if "dest" in locals() and dest.exists():
                    dest.unlink()
            except OSError:
                pass
            raise BackupFailed("Safety backup could not be written; the operation was cancelled.",
                               details={"reason": reason}) from exc
        info = self._describe(dest)
        log.info("backup created: %s (%s, %d bytes)", dest.name, reason, info["size_bytes"])
        if reason in C.AUTO_BACKUP_REASONS:
            self.prune()
        return info

    def hook(self, conn: sqlite3.Connection, reason: str) -> Path:
        """Signature required by migrate.migrate(backup_hook=...)."""
        return self.backup_dir / self.create(conn, reason)["name"]

    def _describe(self, path: Path) -> Dict[str, Any]:
        m = _NAME_RE.match(path.name)
        st = path.stat()
        created = _dt.datetime.fromtimestamp(st.st_mtime, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") \
            + f"{int(st.st_mtime * 1000) % 1000:03d}Z"
        return {"name": path.name, "reason": m.group(2) if m else "unknown",
                "schema_version": int(m.group(3)) if m else None,
                "size_bytes": st.st_size, "created_at": created}

    def list(self, limit: int = C.BACKUPS_DEFAULT_LIMIT) -> List[Dict[str, Any]]:
        if not self.backup_dir.is_dir():
            return []
        files = sorted((p for p in self.backup_dir.iterdir() if _NAME_RE.match(p.name)),
                       key=lambda p: p.name, reverse=True)
        return [self._describe(p) for p in files[:limit]]

    def prune(self) -> List[str]:
        """Keep the newest AUTO_BACKUP_KEEP automatic backups; never touch manual ones."""
        if not self.backup_dir.is_dir():
            return []
        auto = sorted((p for p in self.backup_dir.iterdir()
                       if (m := _NAME_RE.match(p.name)) and m.group(2) in C.AUTO_BACKUP_REASONS),
                      key=lambda p: p.name, reverse=True)
        removed = []
        for p in auto[C.AUTO_BACKUP_KEEP:]:
            try:
                p.unlink()
                removed.append(p.name)
            except OSError as exc:
                log.warning("could not prune backup %s: %s", p.name, exc)
        if removed:
            log.info("pruned %d old automatic backups", len(removed))
        return removed
