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
