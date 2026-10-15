"""Read access for the BAMS importer (parameter-free SELECTs; the snapshot is built in memory)."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List


def load_snapshot(conn: sqlite3.Connection) -> Dict[str, List[Dict[str, Any]]]:
    clients = [dict(r) for r in conn.execute("SELECT id, name, bpid FROM clients ORDER BY id")]
    objects = [dict(r) for r in conn.execute(
        "SELECT id, client_id, name, region, location, environment, enabled, row_version FROM bams_objects ORDER BY id")]
    metrics = [dict(r) for r in conn.execute(
        "SELECT m.id, m.object_id, m.metric_name, m.ticker, m.enabled, m.stale_after_seconds, o.name AS object_name,"
        " o.client_id, c.name AS client_name FROM bams_metrics m JOIN bams_objects o ON o.id = m.object_id"
        " JOIN clients c ON c.id = o.client_id ORDER BY m.id")]
    return {"clients": clients, "objects": objects, "metrics": metrics}
