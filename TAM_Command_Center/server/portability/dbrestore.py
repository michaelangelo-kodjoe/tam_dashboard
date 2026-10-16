"""Whole-database restore (D-136..D-142). Stage and verify off to the side, then swap atomically behind a
maintenance gate, with two independent ways back (the renamed original and the `pre-restore` backup).

The instance lock file is never touched. Connections are opened per call (`dbkit.open_db`), so once the in-flight
requests have drained and the monitor is stopped no handle on the live file remains."""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..audit import write_audit
from ..dbkit import atomic_replace, migrate, raw_connect, transaction
from ..errors import ConfirmMismatch, Conflict, NotFound, RestoreExpired, RestoreFailed, RestoreRefusal

log = logging.getLogger("tam.restore")
MAX_DB_BYTES = 500 * 1024 * 1024
SESSION_TTL = 10 * 60
CONFIRM_WORD = "RESTORE"
SQLITE_MAGIC = b"SQLite format 3\x00"
WARNING = "Everything currently in the app will be replaced. A safety backup is taken first and stays in the Backups list."
DRAIN_SECONDS = 10.0
REPLACE_TRIES = 5
REPLACE_PAUSE = 0.2
HOOKS: Dict[str, Callable[..., None]] = {}               # test seams (fault injection / races), never set in production
_sleep = time.sleep
_now = time.monotonic
COUNT_TABLES = (("accounts", "clients"), ("contacts", "contacts"), ("tasks", "tasks"), ("notes", "notes"),
                ("appliances", "bams_objects"), ("metrics", "bams_metrics"), ("quarters", "quarterly_upgrade_windows"),
                ("upgrade_records", "server_upgrades"), ("audit_events", "audit_events"),
                ("bams_history", "bams_metric_samples"))
MOCK_KEYS = ("db.mock_seed", "bams.mock_clock")


def _hook(name: str, *a: Any) -> None:
    fn = HOOKS.get(name)
    if fn:
        fn(*a)


# ------------------------------------------------------------------------------------------- gate
class Gate:
    """In-process maintenance gate: counts in-flight API requests, rejects new ones while restoring."""

    def __init__(self) -> None:
        self.lock = threading.Condition()
        self.restoring = False
        self.inflight = 0

    def enter(self, health: bool) -> bool:
        """-> True if admitted (and counted unless health)."""
        with self.lock:
            if self.restoring and not health:
                return False
            if not health:
                self.inflight += 1
            return True

    def leave(self, health: bool) -> None:
        if health:
            return
        with self.lock:
            self.inflight -= 1
            self.lock.notify_all()

    def close_and_drain(self, own: int = 1) -> bool:
        with self.lock:
            self.restoring = True
            end = _now() + DRAIN_SECONDS
            while self.inflight > own:
                left = end - _now()
                if left <= 0:
                    self.restoring = False
                    return False
                self.lock.wait(min(left, 0.2))
            return True

    def open(self) -> None:
        with self.lock:
            self.restoring = False
            self.lock.notify_all()


# ------------------------------------------------------------------------------------------- session
@dataclass
class Staged:
    id: str
    path: Path
    sha256: str
    size: int
    source: Dict[str, str]
    file: Dict[str, Any]
    touched: float = 0.0


class Holder:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.s: Optional[Staged] = None
        self.apply_lock = threading.Lock()


def holder(rt: Any) -> Holder:
    if getattr(rt, "db_restore", None) is None:
        rt.db_restore = Holder()
    return rt.db_restore


def tmp_dir(rt: Any) -> Path:
    return rt.config.data_dir / "restore_tmp"


def _rm(p: Path) -> None:
    for q in (p, p.with_name(p.name + "-wal"), p.with_name(p.name + "-shm"), p.with_name(p.name + "-journal")):
        try:
            q.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.warning("could not delete %s: %s", q, exc)


def _drop(h: Holder) -> None:
    s, h.s = h.s, None
    if s is not None:
        _rm(s.path)


def _current(rt: Any, sid: str) -> Staged:
    h = holder(rt)
    with h.lock:
        s = h.s
        if s is not None and _now() - s.touched > SESSION_TTL:
            _drop(h)
            s = None
        if s is None or s.id != sid:
            raise RestoreExpired("This restore session has expired or is unknown. Choose the database again.")
        s.touched = _now()
        return s


# ------------------------------------------------------------------------------------------- verification
def _counts(conn: sqlite3.Connection) -> Dict[str, int]:
    out = {}
    for key, table in COUNT_TABLES:
        try:
            out[key] = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # nosec B608 - fixed identifiers
        except sqlite3.DatabaseError:
            out[key] = 0
    return out


def _info(conn: sqlite3.Connection) -> Dict[str, Any]:
    ver = migrate.current_version(conn)
    ch = conn.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()
    last = None
    try:
        last = conn.execute("SELECT max(timestamp) FROM audit_events").fetchone()[0]
    except sqlite3.DatabaseError:
        pass
    return {"schema_version": ver, "channel": ch[0] if ch else None, "latest_activity": last, "counts": _counts(conn)}


def check_integrity(conn: sqlite3.Connection) -> Optional[str]:
    r = conn.execute("PRAGMA integrity_check").fetchone()[0]
    if r != "ok":
        return f"integrity_check: {r}"
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        return "foreign_key_check found broken references"
    return None


def db_ok(path: Path) -> bool:
    try:
        c = raw_connect(f"file:{path}?mode=ro", uri=True)
        try:
            return check_integrity(c) is None
        finally:
            c.close()
    except sqlite3.Error:
        return False


def verify_staged(rt: Any, path: Path) -> Dict[str, Any]:
    """All refusals happen here, on the staged copy. The live database is never opened for writing."""
    cfg = rt.config
    with path.open("rb") as fh:
        if fh.read(16) != SQLITE_MAGIC:
            raise RestoreRefusal("not_sqlite", "This is not a SQLite database file.")
    try:
        ro = raw_connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        raise RestoreRefusal("not_sqlite", "This file could not be opened as a database.") from exc
    try:
        try:
            bad = check_integrity(ro)
            if bad:
                raise RestoreRefusal("integrity_failed", "The database failed its integrity check, so it cannot be restored.",
                                     details={"reason": bad})
            has_meta = ro.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").fetchone()
            if not has_meta or ro.execute("PRAGMA application_id").fetchone()[0] != migrate.APPLICATION_ID:
                raise RestoreRefusal("not_sqlite", "This SQLite file is not a TAM Command Center database.")
            stamp = ro.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()
            if stamp is None:
                raise RestoreRefusal("no_channel_stamp", "This database has no DEV/PROD stamp, so it cannot be restored.")
            if stamp[0] != cfg.channel:
                raise RestoreRefusal("channel_mismatch", (
                    "Sample data cannot be restored into the production database." if cfg.channel == "prod" else
                    "A production database cannot be restored into the DEV app."),
                    details={"file_channel": stamp[0], "app_channel": cfg.channel})
            if cfg.channel == "prod" and ro.execute(
                    "SELECT 1 FROM app_meta WHERE key IN (?, ?)", MOCK_KEYS).fetchone():
                raise RestoreRefusal("channel_mismatch", "Sample data cannot be restored into the production database.")
            ver = migrate.current_version(ro)
        except sqlite3.DatabaseError as exc:
            raise RestoreRefusal("integrity_failed", "The database could not be read.", details={"reason": str(exc)[:200]}) from exc
    finally:
        ro.close()
    latest = migrate.discover()[-1][0]
    if ver > latest:
        raise RestoreRefusal("schema_newer", "This database was made by a newer version of the app. Update the app first.",
                             details={"file_schema": ver, "app_schema": latest})
    # Always run the migration runner on the staged copy: upgrades an older file AND verifies the guard triggers
    # (an uploaded file cannot smuggle in triggers or views the schema does not declare).
    conn = raw_connect(path)
    try:
        try:
            migrate.migrate(conn, lambda c, reason: Path(os.devnull), channel=cfg.channel)
        except (migrate.MigrationError, sqlite3.Error) as exc:
            if ver < latest:
                raise RestoreRefusal("migration_failed", "This backup cannot be upgraded; nothing was changed.",
                                     details={"reason": str(exc)[:200]}) from exc
            raise RestoreRefusal("integrity_failed", "The database structure does not match this app; it cannot be restored.",
                                 details={"reason": str(exc)[:200]}) from exc
        bad = check_integrity(conn)
        if bad:
            raise RestoreRefusal("migration_failed" if ver < latest else "integrity_failed",
                                 "The database failed its checks after preparing it; nothing was changed.", details={"reason": bad})
        info = _info(conn)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
    finally:
        conn.close()
    info["will_upgrade_from"] = ver if ver < latest else None
    return info


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _free_ok(rt: Any, size: int) -> None:
    free = shutil.disk_usage(str(rt.config.data_dir)).free
    if free < 3 * size:
        raise RestoreRefusal("no_space", "There is not enough free disk space to stage this database "
                                         "(3 times its size is needed).", details={"needed_bytes": 3 * size, "free_bytes": free})


def _stage(rt: Any, path: Path, source: Dict[str, str]) -> Dict[str, Any]:
    """Verify an already-written staged file and register it as the one live session."""
    h = holder(rt)
    try:
        info = verify_staged(rt, path)
        st = Staged(uuid.uuid4().hex, path, _sha(path), path.stat().st_size, source, info, _now())
    except BaseException:
        _rm(path)
        raise
    with h.lock:
        _drop(h)
        h.s = st
    log.info("database restore staged: source=%s size=%d schema=%s", source.get("name"), st.size, info["schema_version"])
    with rt.db() as conn:
        return preview(rt, st, conn)


# ------------------------------------------------------------------------------------------- inspect
def begin_upload(rt: Any, declared: Optional[int]) -> Path:
    if declared is not None and declared > MAX_DB_BYTES:
        raise RestoreRefusal("too_large", f"The file is larger than {MAX_DB_BYTES // (1024 * 1024)} MB.", status=413,
                             details={"max_bytes": MAX_DB_BYTES})
    if declared:
        _free_ok(rt, declared)
    d = tmp_dir(rt)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{uuid.uuid4().hex}.db"


def inspect_written(rt: Any, path: Path, name: str, size: int) -> Dict[str, Any]:
    if size > MAX_DB_BYTES:
        _rm(path)
        raise RestoreRefusal("too_large", f"The file is larger than {MAX_DB_BYTES // (1024 * 1024)} MB.", status=413)
    if size == 0:
        _rm(path)
        raise RestoreRefusal("not_sqlite", "The file is empty.")
    try:
        _free_ok(rt, size)
    except RestoreRefusal:
        _rm(path)
        raise
    return _stage(rt, path, {"kind": "upload", "name": name})


def from_backup(rt: Any, name: str) -> Dict[str, Any]:
    listed = {b["name"]: b for b in rt.backups.list(100000)}
    if name not in listed:
        raise NotFound("That backup is not in the Backups list.")
    src = rt.backups.backup_dir / name
    _free_ok(rt, max(listed[name]["size_bytes"], 1))
    d = tmp_dir(rt)
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"{uuid.uuid4().hex}.db"
    try:
        s = raw_connect(f"file:{src}?mode=ro&immutable=1", uri=True)      # QA-7-1: no -wal/-shm beside the backup
        t = raw_connect(dest)
        try:
            s.backup(t)                                   # online backup API, never a file copy
        finally:
            t.close()
            s.close()
    except sqlite3.Error as exc:
        _rm(dest)
        raise RestoreRefusal("integrity_failed", "That backup could not be read.", details={"reason": str(exc)[:200]}) from exc
    return _stage(rt, dest, {"kind": "backup", "name": name})


def preview(rt: Any, st: Staged, conn: sqlite3.Connection) -> Dict[str, Any]:
    cur = _info(conn)
    fewer = [k for k, _ in COUNT_TABLES if st.file["counts"].get(k, 0) < cur["counts"].get(k, 0)]
    exp = time.time() + SESSION_TTL
    import datetime as _dt
    expires = _dt.datetime.fromtimestamp(exp, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(exp * 1000) % 1000:03d}Z"
    return {"restore_id": st.id, "expires_at": expires, "source": st.source,
            "file": {k: st.file[k] for k in ("schema_version", "will_upgrade_from", "latest_activity", "channel", "counts")},
            "current": {"schema_version": cur["schema_version"], "will_upgrade_from": None,
                        "latest_activity": cur["latest_activity"], "channel": cur["channel"], "counts": cur["counts"]},
            "fewer": fewer, "warning": WARNING, "confirm_word": CONFIRM_WORD}


def get(rt: Any, sid: str) -> Dict[str, Any]:
    st = _current(rt, sid)
    with rt.db() as conn:
        return preview(rt, st, conn)


def cancel(rt: Any, sid: str) -> Dict[str, Any]:
    h = holder(rt)
    with h.lock:
        hit = h.s is not None and h.s.id == sid
        if hit:
            _drop(h)
    return {"cancelled": hit}


# ------------------------------------------------------------------------------------------- swap
def _replace(src: Path, dst: Path) -> None:
    """os.replace with retries (Windows hands a file back late after a handle closes)."""
    last: Optional[OSError] = None
    for i in range(REPLACE_TRIES):
        try:
            atomic_replace(src, dst)
            return
        except OSError as exc:
            last = exc
            log.warning("replace %s -> %s failed (try %d/%d): %s", src.name, dst.name, i + 1, REPLACE_TRIES, exc)
            if i + 1 < REPLACE_TRIES:
                _sleep(REPLACE_PAUSE)
    assert last is not None
    raise last


def _copy_db(src: Path, dst: Path) -> None:
    s = raw_connect(f"file:{src}?mode=ro&immutable=1", uri=True)      # the source is never written (QA-7-1)
    t = raw_connect(dst)
    try:
        s.backup(t)
        t.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        t.execute("PRAGMA journal_mode=DELETE")
    finally:
        t.close()
        s.close()
    fd = os.open(str(dst), os.O_RDWR)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _siblings(live: Path) -> Dict[str, Path]:
    return {"new": live.with_name(live.name + ".restore-new"), "old": live.with_name(live.name + ".pre-restore-old")}


def _rollback(rt: Any, backup_name: Optional[str], swapped: bool = False) -> str:
    """Put the original back. -> 'unchanged' or 'safety_backup'."""
    live = rt.config.db_path
    sib = _siblings(live)
    _rm(sib["new"])
    restored_old = False
    if sib["old"].exists():
        _rm(live)                                          # whatever (partial) new file is there goes
        try:
            _replace(sib["old"], live)
            restored_old = True
        except OSError:
            log.exception("could not put the renamed original back")
    if live.exists() and db_ok(live) and not (swapped and not sib["old"].exists() and not restored_old):
        return "unchanged"
    if backup_name is None:
        raise RuntimeError("no original and no safety backup")
    log.error("original database unusable; restoring from safety backup %s", backup_name)
    tmp = live.with_name(live.name + ".restore-new")
    _rm(live)
    _copy_db(rt.backups.backup_dir / backup_name, tmp)
    _replace(tmp, live)
    return "safety_backup"


def apply(rt: Any, restore_id: str, confirm: Optional[str]) -> Dict[str, Any]:
    if confirm != CONFIRM_WORD:
        raise ConfirmMismatch(f"Type {CONFIRM_WORD} exactly (capital letters) to continue.")
    st = _current(rt, restore_id)
    h = holder(rt)
    if not h.apply_lock.acquire(blocking=False):
        raise Conflict("A restore is already running.", details={"reason": "apply_in_progress"})
    try:
        if not st.path.exists() or _sha(st.path) != st.sha256:                    # step 1
            with h.lock:
                _drop(h)
            raise RestoreRefusal("integrity_failed", "The staged file changed or disappeared. Choose the database again.")
        return _swap(rt, st, h)
    finally:
        h.apply_lock.release()


def _swap(rt: Any, st: Staged, h: Holder) -> Dict[str, Any]:
    live = rt.config.db_path
    sib = _siblings(live)
    gate: Gate = rt.gate
    mon = rt.bams
    was_active = bool(mon.active) if mon is not None else False
    backup_name: Optional[str] = None
    swapped = False
    log.warning("DATABASE RESTORE starting: source=%s (%s)", st.source.get("name"), st.source.get("kind"))
    if not gate.close_and_drain():                                                   # step 2
        raise RestoreFailed("The app is busy; the restore was not started. Your data was not changed.",
                            details={"state": "unchanged"})
    poll = getattr(mon, "_poll_lock", None)
    got_poll = poll.acquire(timeout=DRAIN_SECONDS) if poll is not None else True
    if not got_poll:
        gate.open()
        raise RestoreFailed("A BAMS poll is still running; the restore was not started. Your data was not changed.",
                            details={"state": "unchanged"})
    try:
        _hook("after_gate", rt)
        if mon is not None:                                                          # step 3
            mon.deactivate()
        with rt.db() as conn:                                                        # step 4
            backup_name = rt.backups.create(conn, "pre-restore")["name"]
        _hook("after_backup", rt, backup_name)
        _hook("before_checkpoint", rt)                                               # step 5
        c = raw_connect(live)
        try:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            c.close()
        _hook("after_checkpoint", rt)
        _rm(sib["new"])
        _copy_db(st.path, sib["new"])                                                # step 6
        if not db_ok(sib["new"]):
            raise RuntimeError("the copied database failed its integrity check")
        _hook("after_copy", rt)
        _replace(live, sib["old"])                                                   # step 7
        _hook("after_rename_old", rt)
        for ext in ("-wal", "-shm"):
            try:
                live.with_name(live.name + ext).unlink()
            except FileNotFoundError:
                pass
        _hook("before_replace", rt)
        _replace(sib["new"], live)
        swapped = True
        _hook("after_replace", rt)
        counts = _verify_live(rt, st)                                                # step 8
        _hook("after_verify", rt)
        with rt.db() as conn:                                                        # step 9
            with transaction(conn):
                write_audit(conn, category="data", object_type="backup", object_id=backup_name, label="Database restored",
                            action="restored", new={"source": st.source, "counts": counts,
                                                    "schema_version": st.file["schema_version"]},
                            reason="safety backup " + backup_name, source="System")
        log.warning("DATABASE RESTORE complete: source=%s safety_backup=%s counts=%s", st.source.get("name"), backup_name, counts)
    except BaseException as exc:
        log.exception("database restore failed")
        try:
            state = _rollback(rt, backup_name, swapped)
        except Exception:  # noqa: BLE001
            log.exception("rollback FAILED")
            _finish(rt, h, gate, mon, poll, got_poll, was_active, keep_stage=True)
            raise RestoreFailed("The restore failed and the original database could not be put back automatically. "
                                "Do not start changing data; a safety backup is in the Backups list "
                                f"({backup_name or 'none was taken'}).",
                                details={"state": "needs_attention", "backup": backup_name}) from exc
        _finish(rt, h, gate, mon, poll, got_poll, was_active, keep_stage=True)
        msg = ("The restore failed. Your data was not changed." if state == "unchanged" else
               f"The restore failed. Restored from safety backup {backup_name}.")
        raise RestoreFailed(msg, details={"state": state, "backup": backup_name, "swapped": swapped}) from exc
    # success: clear sessions and caches, resume, tidy
    rt.import_sessions = None
    rt.restore_sessions = None
    _rm(sib["old"])
    _finish(rt, h, gate, mon, poll, got_poll, was_active, keep_stage=False)
    return {"item": {"restored": True, "backup": next((b for b in rt.backups.list(100000) if b["name"] == backup_name), {"name": backup_name}),
                     "counts": counts, "schema_version": st.file["schema_version"], "source": st.source},
            "side_effects": [{"type": "backup_created", "file": backup_name, "reason": "pre-restore"}]}


def _verify_live(rt: Any, st: Staged) -> Dict[str, int]:
    with rt.db() as conn:                                        # open_db also checks the channel stamp
        bad = check_integrity(conn)
        if bad:
            raise RuntimeError(bad)
        counts = _counts(conn)
    if counts != st.file["counts"]:
        raise RuntimeError(f"row counts after the swap differ from the preview: {counts} vs {st.file['counts']}")
    return counts


def _finish(rt: Any, h: Holder, gate: Gate, mon: Any, poll: Any, got_poll: bool, was_active: bool, keep_stage: bool) -> None:
    if poll is not None and got_poll:
        poll.release()
    if mon is not None and was_active:
        try:
            mon.activate()
        except Exception:  # noqa: BLE001
            log.exception("could not restart the BAMS monitor")
    with h.lock:
        if keep_stage:
            pass
        else:
            _drop(h)
    gate.open()


# ------------------------------------------------------------------------------------------- startup recovery
def startup_recovery(cfg: Any) -> None:
    """Called before the database is opened. Handles a crash during a swap, and clears staged files."""
    live = cfg.db_path
    sib = _siblings(live)
    if sib["new"].exists():
        log.warning("startup recovery: removing unfinished %s", sib["new"].name)
        _rm(sib["new"])
    if sib["old"].exists():
        if not live.exists() or not db_ok(live):
            log.warning("startup recovery: live database missing or damaged; putting %s back", sib["old"].name)
            _rm(live)
            atomic_replace(sib["old"], live)
        else:
            log.info("startup recovery: removing leftover %s", sib["old"].name)
            _rm(sib["old"])
    d = cfg.data_dir / "restore_tmp"
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
