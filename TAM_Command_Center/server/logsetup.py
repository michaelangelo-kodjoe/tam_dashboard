"""Logging (spec section 40): predictable file location, rotating, no secrets.

Browser-disconnect errors (BrokenPipe, ConnectionReset, ConnectionAborted, WinError
10053/10054) are connection lifecycle events: they are logged as ONE debug line with
no traceback, never as errors.
"""
from __future__ import annotations

import errno
import logging
import logging.handlers
import sys
from pathlib import Path
from typing import List, Optional

LOG_FILE_NAME = "tam_command_center.log"
_TAG = "_tam_handler"
_FMT = "%(asctime)s %(levelname)s %(name)s: %(message)s"

_DISCONNECT_ERRNOS = {errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED}
_WIN_DISCONNECT = {10053, 10054}


def is_disconnect(exc: Optional[BaseException]) -> bool:
    if exc is None:
        return False
    if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
        return True
    if isinstance(exc, OSError):
        if getattr(exc, "winerror", None) in _WIN_DISCONNECT:
            return True
        if exc.errno in _DISCONNECT_ERRNOS:
            return True
    return False


class DisconnectFilter(logging.Filter):
    """Rewrite a record that carries a disconnect exception into ONE debug line (no traceback).

    The record is mutated in place so every handler sees the same single line; when debug
    logging is off it is dropped entirely.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        ei = record.exc_info
        if ei and is_disconnect(ei[1]):
            if not logging.getLogger().isEnabledFor(logging.DEBUG):
                return False
            exc = ei[1]
            record.name = "tam.connection"
            record.levelno, record.levelname = logging.DEBUG, "DEBUG"
            record.msg, record.args = f"client connection closed ({type(exc).__name__}: {exc})", ()
            record.exc_info = record.exc_text = record.stack_info = None
        return True


def log_connection_event(exc: BaseException) -> None:
    logging.getLogger("tam.connection").debug("client connection closed (%s: %s)", type(exc).__name__, exc)


def setup_logging(log_dir: Path, level: str = "INFO") -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _TAG, False):
            root.removeHandler(h)
            h.close()
    path = log_dir / LOG_FILE_NAME
    fh = logging.handlers.RotatingFileHandler(path, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    sh = logging.StreamHandler(sys.stderr)
    for h in (fh, sh):
        h.setFormatter(logging.Formatter(_FMT))
        h.addFilter(DisconnectFilter())
        setattr(h, _TAG, True)
        root.addHandler(h)
    set_level(level)
    return path


def set_level(level: str) -> None:
    lv = logging.DEBUG if str(level).upper() == "DEBUG" else logging.INFO
    logging.getLogger().setLevel(lv)
    logging.getLogger("tam").setLevel(lv)


def teardown_logging() -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _TAG, False):
            root.removeHandler(h)
            h.close()


def tail(path: Path, limit: int) -> List[str]:
    """Last `limit` lines of the log file (reads at most the last 1 MiB)."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 1_048_576))
            data = fh.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[-limit:]


# ---------------------------------------------------------------------------------------------- download and cleanup
import datetime as _dt  # noqa: E402
import io  # noqa: E402
import re  # noqa: E402
import zipfile  # noqa: E402

LOG_ROTATE_BEFORE_CLEANUP = 5 * 1024 * 1024
LOG_MAX_AGE_DAYS = 7
LOG_FOLDER_CAP = 50 * 1024 * 1024
CLEANUP_INTERVAL_DAYS = 7
STAMP_NAME = "log_cleanup.stamp"
_ROT = re.compile(r"^" + re.escape(LOG_FILE_NAME) + r"(\.\d+)?$")
log = logging.getLogger("tam.logs")


def list_log_files(log_dir: Path) -> List[Path]:
    """Regular files (no sub-folders, no symlinks) named like the application log, current file first, then newest
    rotated first. Nothing else in the folder is ever listed."""
    out = []
    try:
        for p in log_dir.iterdir():
            if _ROT.match(p.name) and p.is_file() and not p.is_symlink():
                out.append(p)
    except OSError:
        return []
    return sorted(out, key=lambda p: (p.name != LOG_FILE_NAME, int(p.suffix[1:]) if p.name != LOG_FILE_NAME else 0))


def _flush_handlers() -> None:
    for h in logging.getLogger().handlers:
        if getattr(h, _TAG, False):
            try:
                h.flush()
            except Exception:  # noqa: BLE001
                pass


def build_zip(log_dir: Path, cap: int = LOG_FOLDER_CAP) -> "tuple[bytes, int]":
    """-> (zip bytes, number of rotated files left out because of the size cap). The current file is always included."""
    _flush_handlers()
    files = list_log_files(log_dir)
    buf = io.BytesIO()
    used, omitted = 0, 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, p in enumerate(files):
            try:
                size = p.stat().st_size
                if i > 0 and used + size > cap:
                    omitted += 1
                    continue
                z.write(p, arcname=p.name)
                used += size
            except OSError:
                continue
    return buf.getvalue(), omitted


def read_current(log_dir: Path) -> bytes:
    _flush_handlers()
    p = log_dir / LOG_FILE_NAME
    try:
        return p.read_bytes() if p.is_file() and not p.is_symlink() else b""
    except OSError:
        return b""


def _rotate_current(path: Path) -> bool:
    for h in logging.getLogger().handlers:
        if isinstance(h, logging.handlers.RotatingFileHandler) and getattr(h, _TAG, False) and Path(h.baseFilename) == path:
            h.acquire()
            try:
                h.doRollover()
            finally:
                h.release()
            return True
    return False


def cleanup_logs(log_dir: Path, now: _dt.datetime) -> dict:
    """Rotated files older than 7 days go; then the oldest rotated files until the folder is under the cap. The current
    file is never deleted (it is rotated first when it is huge). Application log files only."""
    cur = log_dir / LOG_FILE_NAME
    try:
        if cur.is_file() and cur.stat().st_size > LOG_ROTATE_BEFORE_CLEANUP:
            _rotate_current(cur)
    except OSError:
        pass
    files = [p for p in list_log_files(log_dir) if p.name != LOG_FILE_NAME]
    cutoff = now.timestamp() - LOG_MAX_AGE_DAYS * 86400
    removed, freed = 0, 0

    def drop(p: Path) -> None:
        nonlocal removed, freed
        try:
            sz = p.stat().st_size
            p.unlink()
            removed += 1
            freed += sz
        except OSError:
            pass

    for p in list(files):
        try:
            if p.stat().st_mtime < cutoff:
                drop(p)
                files.remove(p)
        except OSError:
            files.remove(p)

    def total() -> int:
        return sum(q.stat().st_size for q in ([cur] if cur.is_file() else []) + files if q.exists())
    for p in sorted(files, key=lambda q: q.stat().st_mtime):          # oldest first
        if total() <= LOG_FOLDER_CAP:
            break
        drop(p)
        files.remove(p)
    kept = len(list_log_files(log_dir))
    log.info("log cleanup: removed %d files (%d KiB), kept %d", removed, freed // 1024, kept)
    return {"removed": removed, "freed_bytes": freed, "kept": kept}


def weekly_cleanup(log_dir: Path, now: _dt.datetime) -> "dict | None":
    """Run cleanup_logs at most once per 7 days (stamp file in the log folder). Never raises."""
    try:
        stamp = log_dir / STAMP_NAME
        if stamp.is_file():
            try:
                last = _dt.datetime.fromisoformat(stamp.read_text(encoding="utf-8").strip())
                if now - last < _dt.timedelta(days=CLEANUP_INTERVAL_DAYS):
                    return None
            except ValueError:
                pass
        res = cleanup_logs(log_dir, now)
        stamp.write_text(now.isoformat(), encoding="utf-8")
        return res
    except Exception as exc:  # noqa: BLE001
        log.warning("log cleanup failed: %s", type(exc).__name__)
        return None
