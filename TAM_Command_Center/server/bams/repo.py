"""All BAMS SQL (reads and low-level writes). Parameterised only; identifiers are fixed strings, never input."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, Iterable, List, Optional

SETTING_PREFIX = "setting.bams."
DEFAULT_SETTINGS = {"poll_interval_seconds": 60, "in_app_notifications": True, "desktop_notifications": True,
                    "notify_recovered": False, "privacy_mode": True}
READ_KEY = "bams.notifications_read_through"
DESIRED_KEY = "bams.monitor.desired_running"
STARTERS_KEY = "bams.starters_seeded"
PRUNE_KEY = "bams.last_prune_date"


def _d(r: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(r) if r is not None else None


def _all(cur: sqlite3.Cursor) -> List[Dict[str, Any]]:
    return [dict(r) for r in cur.fetchall()]


# ------------------------------------------------------------------ app_meta
def meta_get(conn: sqlite3.Connection, key: str) -> Optional[str]:
    r = conn.execute("SELECT value FROM app_meta WHERE key = :k", {"k": key}).fetchone()
    return r[0] if r else None


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT INTO app_meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 {"k": key, "v": value})


def read_settings(conn: sqlite3.Connection) -> Dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    for k, v in conn.execute("SELECT key, value FROM app_meta WHERE key LIKE 'setting.bams.%'"):
        name = k[len(SETTING_PREFIX):]
        if name not in out:
            continue
        if isinstance(DEFAULT_SETTINGS[name], bool):
            out[name] = v == "1"
        else:
            try:
                out[name] = int(v)
            except ValueError:
                pass
    return out


def write_setting(conn: sqlite3.Connection, name: str, value: Any) -> None:
    meta_set(conn, SETTING_PREFIX + name, ("1" if value else "0") if isinstance(value, bool) else str(value))


# ------------------------------------------------------------------ metrics / rows
_ROW_SQL = (
    "SELECT m.id AS metric_id, m.metric_name, m.ticker, m.enabled AS m_enabled, m.stale_after_seconds,"
    " m.row_version AS m_version, m.current_value, m.last_source_update, m.last_received,"
    " m.high_30, m.high_30_date, m.high_60, m.high_60_date, m.high_90, m.high_90_date,"
    " o.id AS object_id, o.name AS object_name, o.client_id, c.name AS client_name, o.region, o.location,"
    " o.environment, o.enabled AS o_enabled, o.row_version AS o_version"
    " FROM bams_metrics m JOIN bams_objects o ON o.id = m.object_id JOIN clients c ON c.id = o.client_id")


def metric_rows(conn: sqlite3.Connection, include_disabled: bool = False, metric_id: Optional[str] = None
                ) -> List[Dict[str, Any]]:
    where, p = [], {}
    if not include_disabled:
        where.append("m.enabled = 1 AND o.enabled = 1")
    if metric_id is not None:
        where.append("m.id = :mid")
        p["mid"] = metric_id
    sql = _ROW_SQL + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY o.name COLLATE NOCASE, m.metric_name, m.id"
    return _all(conn.execute(sql, p))


def active_events(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    return _all(conn.execute("SELECT * FROM bams_alert_events WHERE status IN ('open','recovered')"
                             " ORDER BY opened_at, id"))


def active_event_for(conn: sqlite3.Connection, metric_id: str, rule_id: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute("SELECT * FROM bams_alert_events WHERE metric_id = :m AND rule_id = :r AND status <> 'closed'",
                           {"m": metric_id, "r": rule_id}).fetchone())


def last_closed_at(conn: sqlite3.Connection, metric_id: str, rule_id: str) -> Optional[str]:
    r = conn.execute("SELECT max(closed_at) FROM bams_alert_events WHERE metric_id = :m AND rule_id = :r"
                     " AND status = 'closed'", {"m": metric_id, "r": rule_id}).fetchone()
    return r[0] if r else None


def rules_for_metric(conn: sqlite3.Connection, metric_id: str, enabled_only: bool = False) -> List[Dict[str, Any]]:
    sql = "SELECT * FROM bams_alert_rules WHERE metric_id = :m" + (" AND enabled = 1" if enabled_only else "")
    return _all(conn.execute(sql + " ORDER BY created_at, id", {"m": metric_id}))


def spark_points(conn: sqlite3.Connection, metric_id: str, t_hi: str, t_lo: str) -> Optional[float]:
    r = conn.execute("SELECT value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at <= :hi"
                     " AND sampled_at >= :lo ORDER BY sampled_at DESC LIMIT 1", {"m": metric_id, "hi": t_hi, "lo": t_lo}).fetchone()
    return r[0] if r else None


def ticker_owner(conn: sqlite3.Connection, ticker: str, exclude_metric: Optional[str] = None) -> Optional[Dict[str, Any]]:
    return _d(conn.execute(
        "SELECT m.id AS metric_id, m.metric_name, o.name AS object_name, c.name AS client_name"
        " FROM bams_metrics m JOIN bams_objects o ON o.id = m.object_id JOIN clients c ON c.id = o.client_id"
        " WHERE lower(m.ticker) = lower(:t) AND m.id <> :x ORDER BY m.id LIMIT 1",
        {"t": ticker, "x": exclude_metric or ""}).fetchone())


def high_from_samples(conn: sqlite3.Connection, metric_id: str, since: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute("SELECT value, substr(sampled_at, 1, 10) AS day FROM bams_metric_samples"
                           " WHERE metric_id = :m AND sampled_at >= :s ORDER BY value DESC, sampled_at DESC LIMIT 1",
                           {"m": metric_id, "s": since}).fetchone())


def sample_span(conn: sqlite3.Connection, metric_id: str) -> Any:
    r = conn.execute("SELECT min(sampled_at), max(sampled_at) FROM bams_metric_samples WHERE metric_id = :m",
                     {"m": metric_id}).fetchone()
    return (r[0], r[1]) if r else (None, None)


def insert_samples(conn: sqlite3.Connection, rows: Iterable[Dict[str, Any]]) -> None:
    conn.executemany("INSERT INTO bams_metric_samples (metric_id, sampled_at, source_update, value)"
                     " VALUES (:metric_id, :sampled_at, :source_update, :value)", list(rows))


def set_highs(conn: sqlite3.Connection, metric_id: str, highs: Dict[str, Any]) -> None:
    conn.execute("UPDATE bams_metrics SET high_30 = :h30, high_30_date = :d30, high_60 = :h60, high_60_date = :d60,"
                 " high_90 = :h90, high_90_date = :d90 WHERE id = :m",
                 {"m": metric_id, "h30": highs["high_30"], "d30": highs["high_30_date"], "h60": highs["high_60"],
                  "d60": highs["high_60_date"], "h90": highs["high_90"], "d90": highs["high_90_date"]})


def prune_samples(conn: sqlite3.Connection, before: str) -> int:
    return conn.execute("DELETE FROM bams_metric_samples WHERE sampled_at < :b", {"b": before}).rowcount


def rule_row(conn: sqlite3.Connection, rule_id: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute("SELECT * FROM bams_alert_rules WHERE id = :i", {"i": rule_id}).fetchone())


def event_row(conn: sqlite3.Connection, event_id: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute("SELECT * FROM bams_alert_events WHERE id = :i", {"i": event_id}).fetchone())


def event_context(conn: sqlite3.Connection, event_id: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute(
        "SELECT e.severity, e.status, m.metric_name, m.ticker, o.name AS object_name, o.client_id, c.name AS client_name"
        " FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id JOIN bams_objects o ON o.id = m.object_id"
        " JOIN clients c ON c.id = o.client_id WHERE e.id = :i", {"i": event_id}).fetchone())


def log_notification(conn: sqlite3.Connection, event_id: str, kind: str, channel: str, at: str, ok: bool,
                     detail: Optional[str]) -> bool:
    """Once per event/kind/channel (DB unique). True when this call recorded it."""
    return conn.execute(
        "INSERT INTO bams_notification_log (event_id, kind, channel, attempted_at, success, detail)"
        " VALUES (:e, :k, :c, :a, :s, :d) ON CONFLICT(event_id, kind, channel) DO NOTHING",
        {"e": event_id, "k": kind, "c": channel, "a": at, "s": 1 if ok else 0, "d": (detail or None) and detail[:2000]}
    ).rowcount == 1


def notification_logged(conn: sqlite3.Connection, event_id: str, kind: str, channel: str) -> bool:
    return conn.execute("SELECT 1 FROM bams_notification_log WHERE event_id = :e AND kind = :k AND channel = :c",
                        {"e": event_id, "k": kind, "c": channel}).fetchone() is not None


def reset_history(conn: sqlite3.Connection) -> Dict[str, int]:
    out = {"events": conn.execute("DELETE FROM bams_alert_events").rowcount,
           "samples": conn.execute("DELETE FROM bams_metric_samples").rowcount}
    conn.execute("UPDATE bams_alert_rules SET breach_count = 0, suppress_until_clear = 0")
    conn.execute("UPDATE bams_metrics SET current_value = NULL, last_source_update = NULL, last_received = NULL,"
                 " high_30 = NULL, high_30_date = NULL, high_60 = NULL, high_60_date = NULL, high_90 = NULL,"
                 " high_90_date = NULL, stale_suppressed = 0")
    return out
