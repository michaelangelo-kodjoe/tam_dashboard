"""In-memory import sessions (D-39): parsed rows only, never the uploaded file. Lost on restart (`import_expired`)."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional

from .. import constants as C
from .reader import ParsedFile


class Session:
    def __init__(self, import_id: str, parsed: ParsedFile, file_name: str, now: float) -> None:
        self.id = import_id
        self.parsed = parsed
        self.file_name = file_name
        self.touched = now
        self.created = now
        self.applied: Optional[Dict[str, Any]] = None
        self.applied_at: Optional[float] = None
        self.sigs: Dict[int, str] = {}          # row signatures of the last plan served (for preview_stale details)

    @property
    def rows(self) -> List[Any]:
        return self.parsed.rows


class SessionStore:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.now = clock
        self._lock = threading.Lock()
        self._s: Dict[str, Session] = {}
        self.apply_lock = threading.Lock()

    def _sweep(self) -> None:
        t = self.now()
        for k, s in list(self._s.items()):
            ttl = C.IMPORT_RESULT_TTL_SECONDS if s.applied else C.IMPORT_SESSION_TTL_SECONDS
            if t - (s.applied_at if s.applied else s.touched) > ttl:
                del self._s[k]

    def add(self, s: Session) -> None:
        with self._lock:
            self._sweep()
            open_ = sorted((x for x in self._s.values() if not x.applied), key=lambda x: x.touched)
            while len(open_) >= C.IMPORT_MAX_SESSIONS:
                del self._s[open_.pop(0).id]
            done = sorted((x for x in self._s.values() if x.applied), key=lambda x: x.applied_at or 0)
            while len(done) > C.IMPORT_MAX_RESULTS:
                del self._s[done.pop(0).id]
            self._s[s.id] = s

    def get(self, import_id: str) -> Optional[Session]:
        with self._lock:
            self._sweep()
            s = self._s.get(import_id)
            if s is not None and not s.applied:
                s.touched = self.now()
            return s

    def count(self) -> int:
        with self._lock:
            self._sweep()
            return len(self._s)
