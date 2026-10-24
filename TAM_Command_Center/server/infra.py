"""Read-only infrastructure payloads (PM US-9.1, D-02): BAMS objects, alerts, upgrades, server counts."""
from __future__ import annotations

import datetime as _dt
import sqlite3
from collections import defaultdict
from typing import Any, Dict, List, Optional

from .dbkit import load_query, migrate, rows_to_dicts
from .ops.effective import upgrades_30d

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


def _next_upgrade(upgrades: List[Dict[str, Any]], today: Optional[str]) -> Optional[Dict[str, str]]:
    """Same rule as account_summary.sql: earliest scheduled_date >= today, status not Completed/Deferred (FE-AC-4).
    `upgrades` is already ordered by (scheduled_date, server_name, id)."""
    if today is None:
        return None
    for u in upgrades:
        if u["scheduled_date"] and u["scheduled_date"] >= today and u["status"] not in ("Completed", "Deferred"):
            return {"date": u["scheduled_date"], "server": u["server_name"]}
    return None


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


_SEV_RANK = {"Critical": 3, "Warning": 2, "Info": 1}
SPARK_WINDOW_DAYS = 7
SPARK_MAX_POINTS = 28


def _instant(s: str) -> _dt.datetime:
    return _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")


def _fmt(t: _dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _downsample(rows: List[Any], limit: int = SPARK_MAX_POINTS) -> List[List[Any]]:
    """rows = [(iso, value)] oldest first. <= limit -> as is; else `limit` equal-time buckets over the span
    first..last, each non-empty bucket contributing its maximum (at that sample's timestamp)."""
    if len(rows) <= limit:
        return [[t, v] for t, v in rows]
    t0, t1 = _instant(rows[0][0]), _instant(rows[-1][0])
    span = (t1 - t0).total_seconds()
    best: Dict[int, Any] = {}
    for t, v in rows:
        idx = min(limit - 1, int((_instant(t) - t0).total_seconds() / span * limit)) if span > 0 else 0
        if idx not in best or v > best[idx][1]:
            best[idx] = (t, v)
    return [[best[i][0], best[i][1]] for i in sorted(best)]


def _spark(conn: sqlite3.Connection, metric_id: str, metric_name: str, now: _dt.datetime) -> Optional[Dict[str, Any]]:
    """One metric, one time range, nothing else is read (spec section 45)."""
    lo = _fmt(now - _dt.timedelta(days=SPARK_WINDOW_DAYS))
    rows = [(r[0], r[1]) for r in conn.execute(
        "SELECT sampled_at, value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at >= :lo"
        " AND sampled_at <= :hi ORDER BY sampled_at, id", {"m": metric_id, "lo": lo, "hi": _fmt(now)})]
    if not rows:
        return None
    hours = -(-int((now - _instant(rows[0][0])).total_seconds()) // 3600)
    return {"metric": metric_name, "window_hours": max(1, min(SPARK_WINDOW_DAYS * 24, hours)),
            "points": _downsample(rows)}


def _server_tiles(conn: sqlite3.Connection, objects: List[Dict[str, Any]], upgrades: List[Dict[str, Any]],
                  alerts_by_obj: Dict[str, List[Dict[str, Any]]], metrics: List[Dict[str, Any]],
                  now: _dt.datetime) -> List[Dict[str, Any]]:
    """PM-AC-3 / PM section 10.4 #6-#7: one tile per distinct server name (case-insensitive)."""
    names: Dict[str, str] = {}
    for o in objects:
        names.setdefault(o["name"].strip().casefold(), o["name"])
    for u in upgrades:
        names.setdefault(u["server_name"].strip().casefold(), u["server_name"])
    env: Dict[str, Optional[str]] = {}
    for u in sorted(upgrades, key=lambda u: (u["schedule_year"] or 0, u["schedule_quarter"] or "",
                                             u["scheduled_date"] or "")):
        env[u["server_name"].strip().casefold()] = u["environment"]
    for o in objects:
        env.setdefault(o["name"].strip().casefold(), o.get("environment"))
    metrics_by_obj: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for m in metrics:
        metrics_by_obj[m["object_id"]].append(m)
    tiles = []
    for key in sorted(names, key=lambda k: (k, names[k])):
        ups = [u for u in upgrades if u["server_name"].strip().casefold() == key]
        open_ups = sorted((u for u in ups if u["status"] not in ("Completed", "Deferred")),
                          key=lambda u: (u["scheduled_date"] is None, u["scheduled_date"] or "", u["id"]))
        done_ups = sorted((u for u in ups if u["status"] == "Completed"),
                          key=lambda u: (u["scheduled_date"] or "", u["id"]))
        version = (open_ups[0]["current_version"] if open_ups and open_ups[0]["current_version"] else None)
        if version is None and not open_ups and done_ups:
            version = done_ups[-1]["target_version"]
        objs = [o for o in objects if o["name"].strip().casefold() == key and o["enabled"]]
        open_alerts = [(a, o) for o in objs for a in alerts_by_obj.get(o["id"], []) if a["status"] == "open"]
        open_alerts.sort(key=lambda p: (-_SEV_RANK.get(p[0]["severity"], 0), p[0]["opened_at"], p[0]["id"]))
        metric = None
        if open_alerts:
            wanted = open_alerts[0][0]["metric_name"]
            metric = next((m for m in metrics_by_obj[open_alerts[0][1]["id"]]
                           if m["metric_name"] == wanted and m["enabled"]), None)
        else:
            cpu = sorted((m for o in objs for m in metrics_by_obj[o["id"]]
                          if m["enabled"] and "cpu" in m["metric_name"].casefold()),
                         key=lambda m: (m["metric_name"], m["id"]))
            metric = cpu[0] if cpu else None
        tiles.append({"name": names[key], "environment": env.get(key),
                      "version": version,
                      "alert_severity": open_alerts[0][0]["severity"] if open_alerts else None,
                      "spark": _spark(conn, metric["id"], metric["metric_name"], now) if metric else None})
    return tiles


def build_infrastructure(conn: sqlite3.Connection, channel: str, *, client_id: Optional[str] = None,
                         include_metrics: bool = True, today: Optional[str] = None,
                         server_tiles: bool = False, provider_available: bool = True) -> Dict[str, Dict[str, Any]]:
    """Returns {client_id: payload} for one account or for all accounts."""
    cond, params = ("WHERE client_id = :c", {"c": client_id}) if client_id else ("", {})
    objects = rows_to_dicts(conn.execute(f"SELECT * FROM bams_objects {cond} ORDER BY name COLLATE NOCASE, id", params))  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
    upgrades = rows_to_dicts(conn.execute(
        f"SELECT * FROM server_upgrades {cond} ORDER BY (scheduled_date IS NULL), scheduled_date, server_name, id", params))  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
    fresh = rows_to_dicts(conn.execute(load_query("metric_freshness.sql"), {
        "wall_now": migrate.utc_now(), "provider_running": 0, "channel": channel}))
    fresh_by_obj: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for f in fresh:
        if not provider_available and f["freshness"] != "Disabled":      # PROD fails closed: never a number without a provider
            f["freshness"], f["current_value"] = "No Data", None
        fresh_by_obj[f["object_id"]].append(f)
    metrics = rows_to_dicts(conn.execute("SELECT id, object_id, metric_name, enabled FROM bams_metrics"
                                         " ORDER BY metric_name, id"))
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

    objects_raw: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for o in objects:
        objects_raw[o["client_id"]].append(o)
    now = _instant(migrate.utc_now())
    out: Dict[str, Dict[str, Any]] = {}
    clients = [client_id] if client_id else [r[0] for r in conn.execute("SELECT id FROM clients")]
    for cid in clients:
        out[cid] = {"client_id": cid, "bams_objects": [], "server_upgrades": [], "active_alerts": 0,
                    "next_upgrade": None, "upgrades_30d": []}
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
    soon = upgrades_30d(conn, today, client_id)     # Operations-derived timeline for the Overview only
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
        payload["next_upgrade"] = _next_upgrade(ups, today)
        payload["upgrades_30d"] = soon.get(cid, [])
        if server_tiles:
            payload["server_tiles"] = _server_tiles(conn, objects_raw.get(cid, []), ups, alerts_by_obj, metrics, now)
    return out
