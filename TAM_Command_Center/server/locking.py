"""Single-instance lock per database (PM D-18, spec section 4).

An OS-level exclusive lock on `<db>.lock` is taken BEFORE the DB is opened:
fcntl.flock on POSIX, msvcrt.locking on Windows. The holder's PID and port are
written at offset 64 so a second process can name them in its error message.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple

from .errors import StartupRefused

_INFO_OFFSET = 64


class InstanceLock:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._fd: Optional[int] = None

    @staticmethod
    def _holder(path: Path) -> Tuple[str, str]:
        try:
            with open(path, "rb") as fh:
                fh.seek(_INFO_OFFSET)
                text = fh.read(200).decode("ascii", "ignore")
            vals = dict(p.split("=", 1) for p in text.split() if "=" in p)
            return vals.get("pid", "?"), vals.get("port", "?")
        except OSError:
            return "?", "?"

    def acquire(self, port: int) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":  # pragma: no cover - exercised on Windows only (untested here)
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            pid, hport = self._holder(self.path)
            raise StartupRefused(
                f"Another TAM Command Center instance (PID {pid}, port {hport}) is using this database.",
                exit_code=2) from None
        info = f"pid={os.getpid()} port={port}".encode("ascii").ljust(120)
        os.lseek(fd, _INFO_OFFSET, os.SEEK_SET)
        os.write(fd, info)
        self._fd = fd

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            if os.name == "nt":  # pragma: no cover
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
