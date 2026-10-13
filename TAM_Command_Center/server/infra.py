"""Read-only infrastructure payloads (PM US-9.1, D-02): BAMS objects, alerts, upgrades, server counts."""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from typing import Any, Dict, List, Optional

from .dbkit import load_query, migrate, rows_to_dicts

_RANK = {"Stale": 4, "No Data": 3, "Delayed": 2, "Live": 1}


def _worst(states: List[str]) -> str:
    monitored = [s for s in states if s != "Disabled"]
    if not states:
        return "No Data"
    if not monitored:
        return "Disabled"
    return max(monitored, key=lambda s: _RANK.get(s, 0))


def _upgrade_row(r: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "client_id", "server_name", "environment", "polarity", "schedule_year", "schedule_quarter",
            "current_version", "target_version", "scheduled_date", "maintenance_window", "status",
            "validation_status", "waiting_on", "reference", "notes", "row_version", "created_at", "updated_at")
    return {k: r.get(k) for k in keys}


def _env_summary(objects: List[Dict[str, Any]], upgrades: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Environment precedence (QA-1-15): upgrade rows (most recent release) first, BAMS object env otherwise."""
    env: Dict[str, Optional[str]] = {}
    ordered = sorted(upgrades, key=lambda u: (u["schedule_year"] or 0, u["schedule_quarter"] or "",
                                              u["scheduled_date"] or ""))
    for u in ordered:                      # later (more recent) rows overwrite earlier ones
        env[u["server_name"].strip().casefold()] = u["environment"]
    for o in objects:
        env.setdefault(o["name"].strip().casefold(), o.get("environment"))
    summary = {"PROD": 0, "DEV": 0, "unknown": 0}
    for v in env.values():
        summary[v if v in ("PROD", "DEV") else "unknown"] += 1
    regions = sorted({o["region"] for o in objects if o.get("region")})
    return {"servers": len(env), "environment_summary": {**summary, "regions": regions}}


def build_infrastructure(conn: sqlite3.Connection, channel: str, *, client_id: Optional[str] = None,
                         include_metrics: bool = True) -> Dict[str, Dict[str, Any]]:
    """Returns {client_id: payload} for one account or for all accounts."""
    cond, params = ("WHERE client_id = :c", {"c": client_id}) if client_id else ("", {})
    objects = rows_to_dicts(conn.execute(f"SELECT * FROM bams_objects {cond} ORDER BY name COLLATE NOCASE, id", params))
    upgrades = rows_to_dicts(conn.execute(
        f"SELECT * FROM server_upgrades {cond} ORDER BY (scheduled_date IS NULL), scheduled_date, server_name, id", params))
    fresh = rows_to_dicts(conn.execute(load_query("metric_freshness.sql"), {
        "wall_now": migrate.utc_now(), "provider_running": 0, "channel": channel}))
    fresh_by_obj: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for f in fresh:
        fresh_by_obj[f["object_id"]].append(f)
    metrics = rows_to_dicts(conn.execute("SELECT id, object_id, enabled FROM bams_metrics"))
    enabled_by_metric = {m["id"]: bool(m["enabled"]) for m in metrics}
    alerts_by_obj: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for a in rows_to_dicts(conn.execute(
            "SELECT e.id, e.severity, e.status, e.opened_at, e.message, m.metric_name, o.id AS object_id"
            " FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id"
            " JOIN bams_objects o ON o.id = m.object_id"
            " WHERE e.status IN ('open','recovered') AND o.enabled = 1 AND m.enabled = 1"
            " ORDER BY e.opened_at, e.id")):
        oid = a.pop("object_id")
        alerts_by_obj[oid].append(a)

    out: Dict[str, Dict[str, Any]] = {}
    clients = [client_id] if client_id else [r[0] for r in conn.execute("SELECT id FROM clients")]
    for cid in clients:
        out[cid] = {"client_id": cid, "bams_objects": [], "server_upgrades": [], "active_alerts": 0}
    objs_by_client: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for o in objects:
        states = [f["freshness"] for f in fresh_by_obj.get(o["id"], [])]
        item = {"id": o["id"], "client_id": o["client_id"], "name": o["name"], "region": o["region"],
                "location": o["location"], "environment": o["environment"], "enabled": bool(o["enabled"]),
                "row_version": o["row_version"],
                "worst_status": "Disabled" if not o["enabled"] else _worst(states),
                "metric_count": len(states), "alerts": alerts_by_obj.get(o["id"], [])}
        if include_metrics:
            item["metrics"] = [{"id": f["metric_id"], "metric_name": f["metric_name"],
                                "current_value": f["current_value"], "last_received": f["last_received"],
                                "freshness": f["freshness"], "enabled": enabled_by_metric.get(f["metric_id"], False)}
                               for f in fresh_by_obj.get(o["id"], [])]
        objs_by_client[o["client_id"]].append(item)
    ups_by_client: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for u in upgrades:
        ups_by_client[u["client_id"]].append(_upgrade_row(u))
    for cid, payload in out.items():
        objs = objs_by_client.get(cid, [])
        ups = ups_by_client.get(cid, [])
        payload["bams_objects"] = objs
        payload["server_upgrades"] = ups
        payload["active_alerts"] = sum(len(o["alerts"]) for o in objs)
        payload.update(_env_summary(objs, ups))
    return out
