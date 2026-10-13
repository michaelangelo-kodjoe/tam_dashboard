"""Today payload: executes db/queries/today_queue.sql UNMODIFIED (the ranking is not reimplemented)."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List

from . import constants as C
from .dbkit import load_query, rows_to_dicts
from .reads import account_summaries, recent_changes

_ITEM_KEYS = ("kind", "id", "tier", "tier_label", "client_id", "client_name", "type_label", "title", "status",
              "urgency", "date", "date_kind", "days_delta", "context", "priority", "severity", "server_name")


def _item(r: Dict[str, Any]) -> Dict[str, Any]:
    return {k: r.get(k) for k in _ITEM_KEYS}


def build_today(conn: sqlite3.Connection, today: str) -> Dict[str, Any]:
    queue: List[Dict[str, Any]] = []
    upcoming: List[Dict[str, Any]] = []
    for r in rows_to_dicts(conn.execute(load_query("today_queue.sql"), {"today": today})):
        (queue if r["section"] == "queue" else upcoming).append(_item(r))
    load = [{"client_id": s["id"], "client_name": s["name"], "open_tasks": s["open_tasks"], "overdue": s["overdue"],
             "waiting": s["waiting"], "active_alerts": s["active_alerts"], "next_contact": s["next_contact"]}
            for s in account_summaries(conn, today, "Active")[:C.ACCOUNT_LOAD_ROWS]]
    return {"today": today, "queue": queue, "upcoming": upcoming,
            "recent_changes": recent_changes(conn, C.RECENT_CHANGES_LIMIT), "account_load": load}
