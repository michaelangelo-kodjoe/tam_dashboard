"""Read access for the importer (the only SQL here is parameter-free SELECTs)."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List

_COLS = "id, name, status, bpid, products, next_contact, notes, row_version"


def load_accounts(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(f"SELECT {_COLS} FROM clients ORDER BY id")]


def row_versions(conn: sqlite3.Connection, ids: List[str]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        marks = ",".join("?" for _ in chunk)
        out.update({r[0]: r[1] for r in conn.execute(f"SELECT id, row_version FROM clients WHERE id IN ({marks})", chunk)})
    return out
