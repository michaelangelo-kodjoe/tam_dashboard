"""Read-side repository: parameterised SQL only, no business writes. Route handlers never contain SQL."""
from __future__ import annotations

import base64
import json
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from . import constants as C
from .dbkit import like_pattern, load_query, migrate, one, rows_to_dicts
from .errors import NotFound, ValidationFailed
from .sentences import system_sentence

# ------------------------------------------------------------------ shapes


def _b(row: Dict[str, Any], *keys: str) -> Dict[str, Any]:
    for k in keys:
        if k in row and row[k] is not None:
            row[k] = bool(row[k])
    return row


def client_row(r: Dict[str, Any]) -> Dict[str, Any]:
    return {k: r[k] for k in ("id", "name", "status", "bpid", "products", "notes", "last_contact", "next_contact",
                              "row_version", "created_at", "updated_at")}


def task_row(r: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "task", "client_id", "client_name", "category", "priority", "due", "next_update", "status",
            "waiting", "notes", "archived", "row_version", "created_at", "updated_at")
    return _b({k: r.get(k) for k in keys}, "archived")


def contact_row(r: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "client_id", "name", "role", "email", "team", "is_primary", "row_version", "created_at", "updated_at")
    return _b({k: r.get(k) for k in keys}, "is_primary")


def note_row(r: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "client_id", "note_type", "timestamp", "subject", "body", "action_items", "source",
            "row_version", "created_at", "updated_at")
    return {k: r.get(k) for k in keys}


# ------------------------------------------------------------------ accounts


def account_summaries(conn: sqlite3.Connection, today: str, status: str = "All") -> List[Dict[str, Any]]:
    return rows_to_dicts(conn.execute(load_query("account_summary.sql"), {"today": today, "status": status}))


def list_accounts(conn: sqlite3.Connection, today: str, status: str = "All") -> List[Dict[str, Any]]:
    full = {r["id"]: r for r in rows_to_dicts(conn.execute("SELECT * FROM clients"))}
    out = []
    for s in account_summaries(conn, today, status):
        item = client_row(full[s["id"]])
        item["counts"] = {k: s[k] for k in ("open_tasks", "overdue", "waiting", "active_alerts", "next_upgrade",
                                            "upcoming_upgrades", "servers")}
        out.append(item)
    return out


def get_account(conn: sqlite3.Connection, client_id: str, today: str) -> Dict[str, Any]:
    for a in list_accounts(conn, today):
        if a["id"] == client_id:
            return a
    raise NotFound("Account not found.")


def get_client_raw(conn: sqlite3.Connection, client_id: str) -> Optional[Dict[str, Any]]:
    return one(conn, "SELECT * FROM clients WHERE id = :id", {"id": client_id})


def require_client(conn: sqlite3.Connection, client_id: str) -> Dict[str, Any]:
    r = get_client_raw(conn, client_id)
    if r is None:
        raise NotFound("Account not found.")
    return r


# ------------------------------------------------------------------ tasks / contacts / notes


def query_tasks(conn: sqlite3.Connection, *, client_id: Optional[str] = None, archived: str = "false",
                status: Optional[str] = None, priority: Optional[str] = None, category: Optional[str] = None,
                q: Optional[str] = None, limit: int = C.TASKS_DEFAULT_LIMIT) -> List[Dict[str, Any]]:
    where, params = ["1 = 1"], {"limit": limit}  # type: List[str], Dict[str, Any]
    if client_id == "none":
        where.append("t.client_id IS NULL")
    elif client_id:
        where.append("t.client_id = :client_id")
        params["client_id"] = client_id
    if archived == "true":
        where.append("t.archived = 1")
    elif archived == "false":
        where.append("t.archived = 0")
    if status == "open":
        where.append("t.status <> 'Complete'")
    elif status:
        where.append("t.status = :status")
        params["status"] = status
    if priority:
        where.append("t.priority = :priority")
        params["priority"] = priority
    if category:
        where.append("t.category = :category")
        params["category"] = category
    if q:
        where.append("(t.task LIKE :q ESCAPE '\\' OR t.notes LIKE :q ESCAPE '\\' OR t.waiting LIKE :q ESCAPE '\\')")
        params["q"] = like_pattern(q)
    sql = ("SELECT t.*, c.name AS client_name FROM tasks t LEFT JOIN clients c ON c.id = t.client_id WHERE "
           + " AND ".join(where)
           + " ORDER BY (t.due IS NULL), t.due, t.updated_at DESC, t.id LIMIT :limit")
    return [task_row(r) for r in rows_to_dicts(conn.execute(sql, params))]


def get_task_raw(conn: sqlite3.Connection, task_id: str) -> Optional[Dict[str, Any]]:
    return one(conn, "SELECT t.*, c.name AS client_name FROM tasks t LEFT JOIN clients c ON c.id = t.client_id"
                     " WHERE t.id = :id", {"id": task_id})


def list_contacts(conn: sqlite3.Connection, client_id: Optional[str] = None) -> List[Dict[str, Any]]:
    sql = "SELECT * FROM contacts" + (" WHERE client_id = :c" if client_id else "") \
          + " ORDER BY client_id, is_primary DESC, name COLLATE NOCASE, id"
    return [contact_row(r) for r in rows_to_dicts(conn.execute(sql, {"c": client_id} if client_id else {}))]


def get_contact_raw(conn: sqlite3.Connection, contact_id: str) -> Optional[Dict[str, Any]]:
    return one(conn, "SELECT * FROM contacts WHERE id = :id", {"id": contact_id})


def get_note_raw(conn: sqlite3.Connection, note_id: str) -> Optional[Dict[str, Any]]:
    return one(conn, "SELECT * FROM notes WHERE id = :id", {"id": note_id})


# ------------------------------------------------------------------ activity


def _enc_cursor(ts: str, key: str) -> str:
    return base64.urlsafe_b64encode(json.dumps([ts, key]).encode()).decode().rstrip("=")


def _dec_cursor(c: str) -> Tuple[str, str]:
    try:
        raw = base64.urlsafe_b64decode(c + "=" * (-len(c) % 4))
        ts, key = json.loads(raw)
        if not isinstance(ts, str) or not isinstance(key, str):
            raise ValueError
        return ts, key
    except Exception:
        raise ValidationFailed("Invalid cursor.", fields={"before": "invalid cursor"}) from None


def _server_name(object_type: str, object_id: Any, label: Any, bams_names: Dict[str, str]) -> Optional[str]:
    """Deep-link target (FE-AC-3): BAMS object name for alerts, the server name for upgrades, else None."""
    if object_type in ("bams_alert", "bams_alert_event"):
        return bams_names.get(object_id)
    if object_type == "server_upgrade":
        return label or None
    return None


def activity_page(conn: sqlite3.Connection, client_id: str, *, filter_: str = "all", q: Optional[str] = None,
                  before: Optional[str] = None, limit: int = C.ACTIVITY_DEFAULT_LIMIT) -> Dict[str, Any]:
    require_client(conn, client_id)
    before_ts = before_key = None
    if before:
        before_ts, before_key = _dec_cursor(before)
    rows = rows_to_dicts(conn.execute(load_query("activity_timeline.sql"), {
        "client_id": client_id, "filter": filter_, "q_like": like_pattern(q) if q else None,
        "before_ts": before_ts, "before_key": before_key, "limit": limit + 1}))
    has_more = len(rows) > limit
    rows = rows[:limit]
    versions: Dict[str, int] = {}
    note_ids = [r["object_id"] for r in rows if r["entry_kind"] == "note"]
    if note_ids:
        marks = ",".join("?" for _ in note_ids)
        versions = {r[0]: (r[1], r[2]) for r in conn.execute(
            f"SELECT id, row_version, created_at FROM notes WHERE id IN ({marks})", note_ids)}
    bams_ids = [r["object_id"] for r in rows if r["entry_kind"] != "note" and r["event_type"].startswith("bams_alert.")]
    bams_names: Dict[str, str] = {}
    if bams_ids:
        marks = ",".join("?" for _ in bams_ids)
        bams_names = {r[0]: r[1] for r in conn.execute(
            "SELECT e.id, o.name FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id"
            f" JOIN bams_objects o ON o.id = m.object_id WHERE e.id IN ({marks})", bams_ids)}
    items = []
    for r in rows:
        if r["entry_kind"] == "note":
            items.append({"kind": "note", "entry_key": r["entry_key"], "ts": r["ts"], "id": r["object_id"],
                          "note_type": r["event_type"], "subject": r["subject"], "body": r["body"],
                          "action_items": r["action_items"], "source": r["source"],
                          "row_version": versions.get(r["object_id"], (None, None))[0],
                          "updated_at": r["updated_at"], "client_id": client_id,
                          "created_at": versions.get(r["object_id"], (None, None))[1]})
        else:
            otype, _, action = r["event_type"].partition(".")
            label = r["subject"]
            server_name = _server_name(otype, r["object_id"], label, bams_names)
            items.append({"kind": "system", "entry_key": r["entry_key"], "ts": r["ts"], "event_type": r["event_type"],
                          "object_type": r["object_type"], "object_id": r["object_id"], "label": label,
                          "severity": r["severity"], "source": r["source"], "server_name": server_name,
                          "sentence": system_sentence(otype, action, label, r["old_value"], r["new_value"],
                                                      r["severity"])})
    nxt = _enc_cursor(rows[-1]["ts"], rows[-1]["entry_key"]) if has_more and rows else None
    return {"items": items, "next_cursor": nxt, "has_more": has_more}


# ------------------------------------------------------------------ recent changes


def recent_changes(conn: sqlite3.Connection, limit: int = C.RECENT_CHANGES_LIMIT) -> List[Dict[str, Any]]:
    out = []
    for r in rows_to_dicts(conn.execute(load_query("recent_changes.sql"), {"limit": limit})):
        sev = r.get("severity")
        out.append({"entry_key": r["entry_key"], "ts": r["ts"], "client_id": r["client_id"],
                    "client_name": r["client_name"], "object_type": r["object_type"], "object_id": r["object_id"],
                    "object_label": r["object_label"], "action": r["action"], "severity": sev,
                    "server_name": _server_name(r["object_type"], r["object_id"], r["object_label"],
                                                {r["object_id"]: r.get("server_name")}),
                    "sentence": system_sentence(r["object_type"], r["action"], r["object_label"],
                                                r["old_value"], r["new_value"], sev)})
    return out


# ------------------------------------------------------------------ settings


def read_settings(conn: sqlite3.Connection) -> Dict[str, str]:
    vals = dict(C.SETTING_DEFAULTS)
    for k, v in conn.execute("SELECT key, value FROM app_meta WHERE key LIKE 'setting.%'"):
        name = k[len("setting."):]
        if name in vals:
            vals[name] = v
    return vals


def public_settings(raw: Dict[str, str]) -> Dict[str, Any]:
    out: Dict[str, Any] = dict(raw)
    out["open_browser_on_start"] = raw.get("open_browser_on_start") == "1"
    return out


def schema_version(conn: sqlite3.Connection) -> int:
    return migrate.current_version(conn)
