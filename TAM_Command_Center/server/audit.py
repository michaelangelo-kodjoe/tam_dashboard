"""Audit trail (spec section 35, PM US-1.5). One INSERT helper; must run inside the data transaction."""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from .dbkit import migrate


def _j(v: Any) -> Optional[str]:
    if v is None:
        return None
    return json.dumps(v, ensure_ascii=False, sort_keys=True, default=str)


def write_audit(conn: sqlite3.Connection, *, category: str, object_type: str, action: str,
                object_id: Optional[str] = None, label: Optional[str] = None,
                client_id: Optional[str] = None, old: Any = None, new: Any = None,
                reason: Optional[str] = None, source: str = "GUI") -> None:
    if not conn.in_transaction:
        raise RuntimeError("audit rows must be written inside the data transaction")
    conn.execute(
        "INSERT INTO audit_events (timestamp, category, client_id, object_type, object_id, object_label,"
        " action, old_value, new_value, reason, source)"
        " VALUES (:ts, :category, :client_id, :object_type, :object_id, :label, :action, :old, :new, :reason, :source)",
        {"ts": migrate.utc_now(), "category": category, "client_id": client_id, "object_type": object_type,
         "object_id": object_id, "label": (label or None) and label[:500], "action": action,
         "old": _j(old), "new": _j(new), "reason": reason, "source": source})
