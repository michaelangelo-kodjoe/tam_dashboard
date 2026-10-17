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
from typing import Any, Callable, Dict, List, Optional

from . import constants as C
from .dbkit import migrate
from .errors import BackupFailed

log = logging.getLogger("tam.backup")
_NAME_RE = re.compile(r"^tam_(\d{8}T\d{12}Z)_([a-z][a-z-]*)_v(\d+)\.db$")


def kind_of(reason: str) -> str:
    """weekly (automatic schedule) | manual | safety (taken before a risky change: pre-*)."""
    if reason == C.WEEKLY_REASON:
        return "weekly"
    if reason == C.MANUAL_BACKUP_REASON:
        return "manual"
    return "safety"


def _stamp_time(name: str) -> Optional[_dt.datetime]:
    m = _NAME_RE.match(name)
    if not m:
        return None
    try:
        return _dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S%fZ").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return None


class BackupService:
    def __init__(self, backup_dir: Path, clock: Optional[Callable[[], _dt.datetime]] = None) -> None:
        self.backup_dir = Path(backup_dir)
        self.clock = clock or (lambda: _dt.datetime.now(_dt.timezone.utc))      # tests inject a clock

    def create(self, conn: sqlite3.Connection, reason: str) -> Dict[str, Any]:
        """Take an online backup of `conn`'s database. Raises BackupFailed on any problem."""
        if not re.fullmatch(r"[a-z][a-z-]*", reason):
            raise ValueError(f"bad backup reason {reason!r}")
        if conn.in_transaction:
            raise BackupFailed("internal: backup attempted inside an open transaction")
        stamp = self.clock().strftime("%Y%m%dT%H%M%S%fZ")
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
                "kind": kind_of(m.group(2)) if m else "safety",
                "schema_version": int(m.group(3)) if m else None,
                "size_bytes": st.st_size, "created_at": created}

    def list(self, limit: int = C.BACKUPS_DEFAULT_LIMIT) -> List[Dict[str, Any]]:
        if not self.backup_dir.is_dir():
            return []
        files = sorted((p for p in self.backup_dir.iterdir() if _NAME_RE.match(p.name)),
                       key=lambda p: p.name, reverse=True)
        return [self._describe(p) for p in files[:limit]]

    def prune(self) -> List[str]:
        """Retention (see constants): weekly keep 8; each safety reason keep 5 and nothing older than 30 days;
        manual and pre-restore never; the newest backup of any kind never."""
        if not self.backup_dir.is_dir():
            return []
        files = sorted((p for p in self.backup_dir.iterdir() if _NAME_RE.match(p.name)), key=lambda p: p.name, reverse=True)
        if not files:
            return []
        now, newest = self.clock(), files[0]
        by_reason: Dict[str, List[Path]] = {}
        for p in files:
            by_reason.setdefault(_NAME_RE.match(p.name).group(2), []).append(p)       # type: ignore[union-attr]
        doomed: List[Path] = []
        for reason, items in by_reason.items():              # items are newest first
            if reason in C.NEVER_PRUNE_REASONS:
                continue
            if reason == C.WEEKLY_REASON:
                doomed += items[C.WEEKLY_KEEP:]
                continue
            doomed += items[C.SAFETY_KEEP_PER_REASON:]
            cutoff = now - _dt.timedelta(days=C.SAFETY_MAX_AGE_DAYS)
            doomed += [p for p in items[:C.SAFETY_KEEP_PER_REASON] if (_stamp_time(p.name) or now) < cutoff]
        removed = []
        for p in dict.fromkeys(doomed):
            if p == newest:
                continue
            try:
                p.unlink()
                removed.append(p.name)
            except OSError as exc:
                log.warning("could not prune backup %s: %s", p.name, exc)
        if removed:
            log.info("pruned %d old backups", len(removed))
        return removed

    # ------------------------------------------------------------ weekly schedule
    def weekly_due(self) -> bool:
        last = [t for p in self.backup_dir.iterdir() if (m := _NAME_RE.match(p.name)) and m.group(2) == C.WEEKLY_REASON
                and (t := _stamp_time(p.name))] if self.backup_dir.is_dir() else []
        return not last or self.clock() - max(last) >= _dt.timedelta(days=C.WEEKLY_INTERVAL_DAYS)

    def run_scheduled(self, db_factory: Callable[[], Any]) -> Optional[Dict[str, Any]]:
        """Take the weekly backup if due and the database holds data; always apply retention. Never raises."""
        try:
            made = None
            if self.weekly_due():
                with db_factory() as conn:
                    has_data = any(conn.execute(f"SELECT 1 FROM {t} LIMIT 1").fetchone()  # nosec B608 - fixed table names
                                   for t in ("clients", "tasks", "notes", "bams_objects"))
                    if has_data:
                        made = self.create(conn, C.WEEKLY_REASON)
            self.prune()
            return made
        except Exception as exc:  # noqa: BLE001 - a failed weekly backup must not stop the app; retried next check
            log.warning("scheduled backup failed: %s", type(exc).__name__)
            return None
