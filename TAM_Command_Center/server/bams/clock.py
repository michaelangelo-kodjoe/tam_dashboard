"""Injectable UTC clock for the BAMS monitor, lifecycle and freshness (D-61). DEV routes may move it; PROD never does."""
from __future__ import annotations

import datetime as _dt
import threading
from typing import Callable, Optional

UTC = _dt.timezone.utc


def fmt(t: _dt.datetime) -> str:
    t = t.astimezone(UTC)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def parse(s: str) -> _dt.datetime:
    return _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


class Clock:
    """now() = base() + offset. `base` defaults to the wall clock; tests inject a fake base."""

    def __init__(self, base: Optional[Callable[[], _dt.datetime]] = None) -> None:
        self._base = base or (lambda: _dt.datetime.now(UTC))
        self._offset = _dt.timedelta(0)
        self._lock = threading.Lock()

    def now(self) -> _dt.datetime:
        with self._lock:
            return self._base() + self._offset

    __call__ = now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._offset += _dt.timedelta(seconds=seconds)

    def set(self, t: _dt.datetime) -> None:
        with self._lock:
            self._offset = t.astimezone(UTC) - self._base()

    def reset(self) -> None:
        with self._lock:
            self._offset = _dt.timedelta(0)

    @property
    def moved(self) -> bool:
        return self._offset != _dt.timedelta(0)
