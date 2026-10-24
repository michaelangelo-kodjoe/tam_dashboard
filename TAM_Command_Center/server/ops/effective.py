"""Overview '30 days' timeline (B-6): the upgrades Operations would show for the next 30 days, per account.

For every BAMS appliance x every quarter window: the saved record if present, else the derived row, using exactly
ops/derive.build_row (record date override, else the quarter-window date; status Planned without a record). Only rows
whose effective date is in [today, today+30] and whose status is not Completed/Deferred are returned. Read-only.
This feeds ONLY `upgrades_30d`; server_upgrades, next_upgrade, counts and Today stay saved-records-only.
"""
from __future__ import annotations

import datetime as _dt
import sqlite3
from typing import Any, Dict, List, Optional

from . import derive as D
from . import repo

WINDOW_DAYS = 30


def upgrades_30d(conn: sqlite3.Connection, today: Optional[str], client_id: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """-> {client_id: [item, ...]} ordered by date then server. Empty when `today` is unknown."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    if today is None:
        return out
    hi = (_dt.date.fromisoformat(today) + _dt.timedelta(days=WINDOW_DAYS)).isoformat()
    apps = [a for a in repo.appliances(conn) if not client_id or a["client_id"] == client_id]
    for w in repo.quarters(conn):
        recs = {(r["client_id"], r["server_name"].casefold()): r for r in repo.records(conn, w["schedule_year"], w["schedule_quarter"])}
        for a in apps:
            row = D.build_row(a, recs.get((a["client_id"], a["appliance"].casefold())), w, today)
            d = row["date"]["effective"]
            if not d or d < today or d > hi or row["status"] in D.CLOSED:
                continue
            env, pol, _p = D.record_target(row["environment"], row["polarity"])
            out.setdefault(a["client_id"], []).append({
                "server_name": a["appliance"], "date": d, "status": row["status"], "environment": env, "polarity": pol,
                "object_id": a["object_id"], "release": {"year": w["schedule_year"], "quarter": w["schedule_quarter"]}})
    for items in out.values():
        items.sort(key=lambda i: (i["date"], i["server_name"].casefold(), i["object_id"]))
    return out
