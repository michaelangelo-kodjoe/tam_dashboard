"""Audit log retention: every 14 days delete audit_events older than 14 days (user decision 2026-10-16).

The schema (migration 0002) refuses to delete any audit row newer than 14 days, whoever asks. The cadence anchor and the
last real prune time are kept in app_meta so a restart neither skips nor doubles a run. The very first start only sets
the anchor (the first prune is 14 days later)."""
from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Dict, Optional

from .audit import write_audit
from .dbkit import transaction

log = logging.getLogger("tam.audit")
RETENTION_DAYS = 14
INTERVAL_DAYS = 14
ANCHOR_KEY = "audit.prune.anchor"        # start of the current 14-day cycle (set at first start, then at each run)
LAST_KEY = "audit.prune.last_run"        # time of the last real prune
_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def _fmt(t: _dt.datetime) -> str:
    t = t.astimezone(_dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _parse(s: str) -> _dt.datetime:
    return _dt.datetime.strptime(s, _FMT).replace(tzinfo=_dt.timezone.utc)


def _get(conn: Any, key: str) -> Optional[str]:
    r = conn.execute("SELECT value FROM app_meta WHERE key = :k", {"k": key}).fetchone()
    return r[0] if r else None


def _set(conn: Any, key: str, value: str) -> None:
    conn.execute("INSERT INTO app_meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 {"k": key, "v": value})


def status(conn: Any) -> Dict[str, Any]:
    """For GET /api/audit: retention days, last real prune and when the next one is due."""
    last, anchor = _get(conn, LAST_KEY), _get(conn, ANCHOR_KEY)
    nxt = _fmt(_parse(anchor) + _dt.timedelta(days=INTERVAL_DAYS)) if anchor else None
    return {"retention_days": RETENTION_DAYS, "interval_days": INTERVAL_DAYS, "last_pruned_at": last, "next_due_at": nxt}


def run_scheduled(rt: Any, now: Optional[_dt.datetime] = None) -> Optional[Dict[str, Any]]:
    """Called from the hourly scheduler. -> result when a prune ran, else None. Never raises."""
    now = now or _dt.datetime.now(_dt.timezone.utc)
    try:
        with rt.db() as conn:
            anchor = _get(conn, ANCHOR_KEY)
            if anchor is None:
                with transaction(conn):
                    _set(conn, ANCHOR_KEY, _fmt(now))
                log.info("audit prune: schedule started; first prune after %d days", INTERVAL_DAYS)
                return None
            if now - _parse(anchor) < _dt.timedelta(days=INTERVAL_DAYS):
                return None
            return prune(conn, now)
    except Exception as exc:  # noqa: BLE001 - retried at the next hourly check
        log.warning("audit prune failed: %s", type(exc).__name__)
        return None


def prune(conn: Any, now: _dt.datetime) -> Dict[str, Any]:
    # The schema trigger compares with the real clock; never ask for more than it will allow.
    real = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=RETENTION_DAYS)
    cutoff = min(now - _dt.timedelta(days=RETENTION_DAYS), real)
    with transaction(conn):
        n = conn.execute("DELETE FROM audit_events WHERE timestamp < :c", {"c": _fmt(cutoff)}).rowcount
        if n:
            write_audit(conn, category="system", object_type="schema", object_id="audit_events", label="Audit log",
                        action="pruned", new={"removed": n, "older_than_days": RETENTION_DAYS, "cutoff": _fmt(cutoff)},
                        reason=f"pruned {n} entries older than {RETENTION_DAYS} days", source="System")
        _set(conn, ANCHOR_KEY, _fmt(now))
        _set(conn, LAST_KEY, _fmt(now))
    log.info("audit prune: removed %d entries older than %d days", n, RETENTION_DAYS)
    return {"removed": n, "cutoff": _fmt(cutoff)}
