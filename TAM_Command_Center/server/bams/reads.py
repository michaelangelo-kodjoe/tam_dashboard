"""BAMS read models: state table, metric detail, trend, alerts, notifications, templates. Never calls the provider."""
from __future__ import annotations

import datetime as _dt
import sqlite3
from collections import defaultdict
from typing import Any, Dict, List, Optional

from ..errors import NotFound, ValidationFailed
from . import lifecycle as L
from . import repo
from .clock import fmt, parse

SEV = {"Critical": 3, "Warning": 2, "Info": 1}
DISPLAY_RANK = {"open": 0, "recovered": 1, "stale": 2, "no_data": 3, "delayed": 4, "live": 5, "disabled": 6}
FRESH_KEY = {"Live": "live", "Delayed": "delayed", "Stale": "stale", "No Data": "no_data"}
ROW_CAP = 2000
RANGES = {"24h": 24 * 3600, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400}
MAX_POINTS = 500


class Ctx:
    """Everything a row needs besides the metric record."""

    def __init__(self, now: _dt.datetime, interval: int, available: bool, simulated: bool) -> None:
        self.now, self.interval, self.available, self.simulated = now, interval, available, simulated
        self.live_s = L.live_seconds(interval)


def alert_summary(ev: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": ev["id"], "status": ev["status"], "severity": ev["severity"], "opened_at": ev["opened_at"]}


def pick_alert(events: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not events:
        return None
    return sorted(events, key=lambda e: (-SEV[e["severity"]], e["opened_at"], e["id"]))[0]


def spark(conn: sqlite3.Connection, metric_id: str, now: _dt.datetime) -> List[float]:
    out: List[float] = []
    for i in range(23, -1, -1):
        hi = now - _dt.timedelta(hours=i)
        v = repo.spark_points(conn, metric_id, fmt(hi), fmt(hi - _dt.timedelta(hours=1)))
        if v is not None:
            out.append(v)
    return out


def build_row(m: Dict[str, Any], ctx: Ctx, events: List[Dict[str, Any]], with_spark: Optional[sqlite3.Connection] = None
              ) -> Dict[str, Any]:
    # Freshness is communication freshness: the age of the last successful receipt, NOT of the last value change.
    has_val = ctx.available and m["current_value"] is not None and m["last_received"] is not None
    age = None
    if m["last_received"]:
        age = max(0, int((ctx.now - parse(m["last_received"])).total_seconds()))
    fresh = L.freshness(age, has_val, ctx.live_s, m["stale_after_seconds"], ctx.available)
    disabled = not (m["m_enabled"] and m["o_enabled"])
    alert = pick_alert(events)
    if disabled:
        disp = "disabled"
    elif any(e["status"] == "open" for e in events):
        disp = "open"
    elif events:
        disp = "recovered"
    else:
        disp = FRESH_KEY[fresh]
    row = {
        "id": m["metric_id"], "metric_name": m["metric_name"], "ticker": m["ticker"], "enabled": bool(m["m_enabled"]),
        "stale_after_seconds": m["stale_after_seconds"], "row_version": m["m_version"],
        "object": {"id": m["object_id"], "name": m["object_name"], "client_id": m["client_id"],
                   "client_name": m["client_name"], "region": m["region"], "location": m["location"],
                   "environment": m["environment"], "enabled": bool(m["o_enabled"]), "row_version": m["o_version"]},
        "current_value": m["current_value"] if has_val else None,
        "last_source_update": m["last_source_update"] if ctx.available else None,
        "last_received": m["last_received"] if ctx.available else None,
        "age_seconds": age if has_val else None, "freshness": fresh, "simulated": bool(ctx.simulated and has_val),
        "highs": {"d30": {"value": m["high_30"], "date": m["high_30_date"]},
                  "d60": {"value": m["high_60"], "date": m["high_60_date"]},
                  "d90": {"value": m["high_90"], "date": m["high_90_date"]}},
        "alert": alert_summary(alert) if alert else None, "active_alerts": len(events), "display_status": disp,
    }
    if with_spark is not None:
        row["spark"] = spark(with_spark, m["metric_id"], ctx.now) if has_val else []
    return row


def events_by_metric(conn: sqlite3.Connection, enabled_only: bool = True) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for e in repo.active_events(conn):
        out[e["metric_id"]].append(e)
    return out


_VIEWS = ("all", "active_alerts", "delayed_stale", "live", "no_data")
_STATUSES = ("open", "recovered", "live", "delayed", "stale", "no_data")
_SORTS = ("status", "appliance", "location", "metric", "current", "high30", "high60", "high90", "last_update")


def _bad(field: str, msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={field: msg})


def _sort_value(r: Dict[str, Any], key: str) -> Any:
    o = r["object"]
    return {"appliance": (o["name"] or "").casefold(), "location": (o["location"] or "").casefold(),
            "metric": r["metric_name"].casefold(), "current": r["current_value"], "high30": r["highs"]["d30"]["value"],
            "high60": r["highs"]["d60"]["value"], "high90": r["highs"]["d90"]["value"],
            "last_update": r["last_received"]}[key]


def build_state(conn: sqlite3.Connection, ctx: Ctx, monitor: Dict[str, Any], provider: Dict[str, Any], banner: Optional[Dict[str, Any]],
                q: Dict[str, Any]) -> Dict[str, Any]:
    view, status = q.get("view") or "all", q.get("status")
    if view not in _VIEWS:
        raise _bad("view", "unknown view")
    if status is not None and status not in _STATUSES:
        raise _bad("status", "unknown status")
    sort, direction = q.get("sort") or "status", q.get("dir") or "asc"
    if sort not in _SORTS:
        raise _bad("sort", "unknown sort")
    if direction not in ("asc", "desc"):
        raise _bad("dir", "must be asc or desc")
    text = (q.get("q") or "").strip().casefold()
    if len(text) > 100:
        raise _bad("q", "at most 100 characters")
    accounts = {a for a in (q.get("account") or "").split(",") if a}
    ev = events_by_metric(conn)
    base = repo.metric_rows(conn, include_disabled=bool(q.get("include_disabled")))
    rows_all = [build_row(m, ctx, ev.get(m["metric_id"], [])) for m in base]
    enabled_rows = [r for r in rows_all if r["display_status"] != "disabled"] if q.get("include_disabled") else rows_all

    def match(r: Dict[str, Any]) -> bool:
        o = r["object"]
        if accounts and o["client_id"] not in accounts:
            return False
        if q.get("object_id") and o["id"] != q["object_id"]:
            return False
        if q.get("location") and (o["location"] or "").casefold() != q["location"].casefold():
            return False
        if q.get("metric") and r["metric_name"].casefold() != q["metric"].casefold():
            return False
        if status:
            if status in ("open", "recovered"):
                if r["display_status"] != status:
                    return False
            elif FRESH_KEY[r["freshness"]] != status:
                return False
        if text and not any(text in (s or "").casefold() for s in
                            (o["name"], o["client_name"], r["metric_name"], r["ticker"])):
            return False
        return True
    filtered = [r for r in rows_all if match(r)]

    def in_view(r: Dict[str, Any], v: str) -> bool:
        return {"all": True, "active_alerts": r["active_alerts"] > 0,
                "delayed_stale": r["freshness"] in ("Delayed", "Stale"), "live": r["freshness"] == "Live",
                "no_data": r["freshness"] == "No Data"}[v]
    view_counts = {v: sum(1 for r in filtered if in_view(r, v)) for v in _VIEWS}
    rows = [r for r in filtered if in_view(r, view)]
    rev = direction == "desc"
    if sort == "status":
        rows.sort(key=lambda r: (DISPLAY_RANK[r["display_status"]], (r["object"]["name"] or "").casefold(),
                                 r["metric_name"].casefold(), r["id"]), reverse=rev)
    else:
        have = sorted((r for r in rows if _sort_value(r, sort) is not None),
                      key=lambda r: (_sort_value(r, sort), r["id"]), reverse=rev)
        rows = have + [r for r in rows if _sort_value(r, sort) is None]
    truncated = len(rows) > ROW_CAP
    rows = rows[:ROW_CAP]
    if q.get("spark", 1) not in (0, "0", False):
        for r in rows:
            r["spark"] = spark(conn, r["id"], ctx.now) if r["current_value"] is not None else []
    # summary over all enabled metrics (events counted from enabled items only)
    summ_events = [e for r in enabled_rows for e in ev.get(r["id"], [])]
    fc = lambda name: sum(1 for r in enabled_rows if r["freshness"] == name)  # noqa: E731
    summary = {"active_alerts": len(summ_events), "open": sum(1 for e in summ_events if e["status"] == "open"),
               "recovered": sum(1 for e in summ_events if e["status"] == "recovered"), "delayed": fc("Delayed"),
               "stale": fc("Stale"), "delayed_stale": fc("Delayed") + fc("Stale"), "live": fc("Live"),
               "no_data": fc("No Data"), "total": len(enabled_rows)}
    accts, objs = {}, {}
    for r in enabled_rows:
        o = r["object"]
        accts[o["client_id"]] = o["client_name"]
        objs[o["id"]] = {"id": o["id"], "name": o["name"], "client_id": o["client_id"], "client_name": o["client_name"]}
    counts: Dict[str, Any] = {"rows": len(rows), "unfiltered": len(enabled_rows)}
    if truncated:
        counts["truncated"] = True
    return {"ok": True, "server_time": fmt(ctx.now), "monitor": monitor, "provider": provider, "banner": banner,
            "summary": summary, "view_counts": view_counts,
            "filters": {"accounts": [{"id": k, "name": v} for k, v in sorted(accts.items(), key=lambda kv: kv[1].casefold())],
                        "locations": sorted({r["object"]["location"] for r in enabled_rows if r["object"]["location"]}, key=str.casefold),
                        "objects": sorted(objs.values(), key=lambda o: (o["name"].casefold(), o["id"])),
                        "metrics": sorted({r["metric_name"] for r in enabled_rows}, key=str.casefold)},
            "counts": counts, "rows": rows}


# ------------------------------------------------------------------ rules / events
def rule_public(rule: Dict[str, Any], metric_name: str, highs: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "metric_id", "rule_type", "operator", "threshold", "reference_period", "consecutive_updates",
            "severity", "cooldown_minutes", "breach_count", "row_version", "created_at", "updated_at")
    out = {k: rule[k] for k in keys}
    out.update(enabled=bool(rule["enabled"]), suppress_until_clear=bool(rule["suppress_until_clear"]),
               preview=L.preview_for(rule, metric_name, highs))
    return out


def event_public(ev: Dict[str, Any], rule: Optional[Dict[str, Any]], row: Optional[Dict[str, Any]], metric_name: str) -> Dict[str, Any]:
    keys = ("id", "metric_id", "rule_id", "alert_type", "severity", "status", "message", "opened_at", "last_triggered_at",
            "recovered_at", "closed_at", "trigger_value", "current_value", "peak_value", "closed_note", "row_version")
    out = {k: ev[k] for k in keys}
    out["still_breaching"] = still_breaching(ev, rule, row)
    if rule is not None:
        out["rule_summary"] = L.rule_summary(rule)
    else:
        msg = ev.get("message") or ""
        pre = metric_name + " "
        msg = msg[len(pre):] if msg.startswith(pre) else msg
        out["rule_summary"] = msg.split(" (value")[0] or None
    return out


def still_breaching(ev: Dict[str, Any], rule: Optional[Dict[str, Any]], row: Optional[Dict[str, Any]]) -> bool:
    if ev["status"] == "closed" or rule is None or row is None:
        return False
    if row["freshness"] in ("Stale", "No Data") or row["current_value"] is None:
        return False
    highs = {"high_30": row["highs"]["d30"]["value"], "high_60": row["highs"]["d60"]["value"],
             "high_90": row["highs"]["d90"]["value"]}
    return bool(L.breaches(rule, row["current_value"], highs))


def metric_detail(conn: sqlite3.Connection, ctx: Ctx, metric_id: str, alerts_limit: int) -> Dict[str, Any]:
    rows = repo.metric_rows(conn, include_disabled=True, metric_id=metric_id)
    if not rows:
        raise NotFound("Metric not found.")
    m = rows[0]
    ev = [e for e in repo.active_events(conn) if e["metric_id"] == metric_id]
    row = build_row(m, ctx, ev if (m["m_enabled"] and m["o_enabled"]) else [])
    highs = {"high_30": m["high_30"], "high_60": m["high_60"], "high_90": m["high_90"]}
    rules = repo.rules_for_metric(conn, metric_id)
    by_id = {r["id"]: r for r in rules}
    hist = [dict(r) for r in conn.execute(
        "SELECT * FROM bams_alert_events WHERE metric_id = :m ORDER BY opened_at DESC, id DESC LIMIT :n",
        {"m": metric_id, "n": alerts_limit})]
    total = conn.execute("SELECT count(*) FROM bams_alert_events WHERE metric_id = :m", {"m": metric_id}).fetchone()[0]
    return {"ok": True, "item": {"row": row, "rules": [rule_public(r, m["metric_name"], highs) for r in rules],
                                 "alerts": [event_public(e, by_id.get(e["rule_id"]), row, m["metric_name"]) for e in hist],
                                 "alerts_total": total, "ranges": list(RANGES)}}


def trend(conn: sqlite3.Connection, ctx: Ctx, metric_id: str, rng: str) -> Dict[str, Any]:
    if rng not in RANGES:
        raise _bad("range", "must be one of 24h, 7d, 30d, 90d")
    rows = repo.metric_rows(conn, include_disabled=True, metric_id=metric_id)
    if not rows:
        raise NotFound("Metric not found.")
    m = rows[0]
    lo_dt, hi_dt = ctx.now - _dt.timedelta(seconds=RANGES[rng]), ctx.now
    lo, hi = fmt(lo_dt), fmt(hi_dt)
    item: Dict[str, Any] = {"metric_id": metric_id, "range": rng, "from": lo, "to": hi, "points": [],
                            "downsampled": False,
                            "text": {"min": None, "max": None, "last": None, "count": 0, "from": None, "to": None},
                            "reference_lines": [], "rule_lines": []}
    if not ctx.available:
        return {"ok": True, "item": item}
    p = {"m": metric_id, "lo": lo, "hi": hi}
    agg = conn.execute("SELECT min(value), max(value), count(*), min(sampled_at), max(sampled_at) FROM bams_metric_samples"
                       " WHERE metric_id = :m AND sampled_at >= :lo AND sampled_at <= :hi", p).fetchone()
    n = agg[2]
    if n:
        last = conn.execute("SELECT value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at >= :lo AND"
                            " sampled_at <= :hi ORDER BY sampled_at DESC, id DESC LIMIT 1", p).fetchone()[0]
        item["text"] = {"min": agg[0], "max": agg[1], "last": last, "count": n, "from": agg[3], "to": agg[4]}
        if n <= MAX_POINTS:
            item["points"] = [{"t": r[0], "v": r[1]} for r in conn.execute(
                "SELECT sampled_at, value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at >= :lo AND"
                " sampled_at <= :hi ORDER BY sampled_at, id", p)]
        else:
            width = RANGES[rng] / MAX_POINTS
            cur = conn.execute(
                "SELECT min(CAST((julianday(sampled_at) - julianday(:lo)) * 86400.0 / :w AS INTEGER), 499) AS b, avg(value)"
                " FROM bams_metric_samples WHERE metric_id = :m AND sampled_at >= :lo AND sampled_at <= :hi"
                " GROUP BY b ORDER BY b", {**p, "w": width})
            item["points"] = [{"t": fmt(lo_dt + _dt.timedelta(seconds=b * width)), "v": round(v, 3)}
                              for b, v in cur]
            item["downsampled"] = True
    for key, label, k in (("high_30", "30D high", "30"), ("high_60", "60D high", "60"), ("high_90", "90D high", "90")):
        if m[key] is not None:
            item["reference_lines"].append({"id": "high_" + k, "label": label, "value": m[key], "date": m["high_%s_date" % k]})
    highs = {"high_30": m["high_30"], "high_60": m["high_60"], "high_90": m["high_90"]}
    for r in repo.rules_for_metric(conn, metric_id, enabled_only=True):
        lv = L.level(r, highs)
        if lv is not None:
            item["rule_lines"].append({"rule_id": r["id"], "label": f"{r['severity']} threshold {L.num(lv)}",
                                       "value": lv, "severity": r["severity"]})
    return {"ok": True, "item": item}


# ------------------------------------------------------------------ alerts list
def alerts_list(conn: sqlite3.Connection, ctx: Ctx, status: str, account: Optional[str], metric_id: Optional[str],
                limit: int, before: Optional[str]) -> Dict[str, Any]:
    if status not in ("active", "open", "recovered", "closed", "all"):
        raise _bad("status", "unknown status")
    sql = ("SELECT e.*, m.metric_name, m.ticker, m.enabled AS m_enabled, o.id AS object_id, o.name AS object_name,"
           " o.client_id, o.location, o.enabled AS o_enabled, c.name AS client_name FROM bams_alert_events e"
           " JOIN bams_metrics m ON m.id = e.metric_id JOIN bams_objects o ON o.id = m.object_id"
           " JOIN clients c ON c.id = o.client_id")
    rows = [dict(r) for r in conn.execute(sql)]
    ids = {a for a in (account or "").split(",") if a}
    rows = [r for r in rows if (not ids or r["client_id"] in ids) and (not metric_id or r["metric_id"] == metric_id)]
    visible = lambda r: r["status"] == "closed" or (r["m_enabled"] and r["o_enabled"])  # noqa: E731
    rows = [r for r in rows if visible(r)]
    counts = {"active": 0, "open": 0, "recovered": 0, "closed": 0}
    for r in rows:
        counts[r["status"]] += 1
        if r["status"] != "closed":
            counts["active"] += 1
    want = {"active": ("open", "recovered"), "open": ("open",), "recovered": ("recovered",), "closed": ("closed",),
            "all": ("open", "recovered", "closed")}[status]
    sel = [r for r in rows if r["status"] in want]
    act = sorted((r for r in sel if r["status"] != "closed"),
                 key=lambda r: (0 if r["status"] == "open" else 1, -SEV[r["severity"]], r["opened_at"], r["id"]))
    clo = sorted((r for r in sel if r["status"] == "closed"), key=lambda r: (r["opened_at"], r["id"]), reverse=True)
    ordered = act + clo
    if before:
        ordered = [r for r in ordered if r["status"] == "closed" and r["opened_at"] < before]
    page = ordered[:limit]
    nxt = page[-1]["opened_at"] if len(ordered) > limit and page else None
    rule_cache: Dict[str, Optional[Dict[str, Any]]] = {}
    mrows = {m["metric_id"]: m for m in repo.metric_rows(conn, include_disabled=True)}
    ev_by = events_by_metric(conn)
    items = []
    for r in page:
        rule = None
        if r["rule_id"]:
            rule = rule_cache.setdefault(r["rule_id"], repo.rule_row(conn, r["rule_id"]))
        m = mrows.get(r["metric_id"])
        row = build_row(m, ctx, ev_by.get(r["metric_id"], [])) if m else None
        ev = {k: r[k] for k in r.keys() if k in
              ("id", "metric_id", "rule_id", "alert_type", "severity", "status", "message", "opened_at", "last_triggered_at",
               "recovered_at", "closed_at", "trigger_value", "current_value", "peak_value", "closed_note", "row_version")}
        items.append({"event": event_public(ev, rule, row, r["metric_name"]),
                      "metric": {"id": r["metric_id"], "metric_name": r["metric_name"], "ticker": r["ticker"]},
                      "object": {"id": r["object_id"], "name": r["object_name"], "client_id": r["client_id"],
                                 "client_name": r["client_name"], "location": r["location"]},
                      "freshness": row["freshness"] if row else "No Data"})
    return {"ok": True, "counts": counts, "items": items, "next_before": nxt}


# ------------------------------------------------------------------ notifications
def notifications(conn: sqlite3.Connection, limit: int, unread_only: bool) -> Dict[str, Any]:
    wm = int(repo.meta_get(conn, repo.READ_KEY) or 0)
    unread = conn.execute("SELECT count(*) FROM bams_notification_log WHERE channel = 'in_app' AND id > :w", {"w": wm}).fetchone()[0]
    cur = conn.execute(
        "SELECT n.id, n.event_id, n.kind, n.attempted_at, e.severity, e.status, e.current_value, e.trigger_value,"
        " m.metric_name, o.name AS object_name, c.name AS client_name FROM bams_notification_log n"
        " JOIN bams_alert_events e ON e.id = n.event_id JOIN bams_metrics m ON m.id = e.metric_id"
        " JOIN bams_objects o ON o.id = m.object_id JOIN clients c ON c.id = o.client_id"
        " WHERE n.channel = 'in_app' AND (:u = 0 OR n.id > :w) ORDER BY n.id DESC LIMIT :n",
        {"u": 1 if unread_only else 0, "w": wm, "n": limit})
    items = []
    for r in cur:
        val = r["trigger_value"] if r["kind"] == "opened" else r["current_value"]
        items.append({"id": r["id"], "event_id": r["event_id"], "kind": r["kind"], "attempted_at": r["attempted_at"],
                      "title": f"{r['severity']} {r['kind']}: {r['metric_name']}",
                      "detail": f"{r['client_name']} / {r['object_name']}" + (f" · value {L.num(val)}%" if val is not None else ""),
                      "severity": r["severity"], "unread": r["id"] > wm, "status": r["status"]})
    return {"ok": True, "unread_count": unread, "items": items}


# ------------------------------------------------------------------ templates
def config_public(c: Dict[str, Any], matches: int) -> Dict[str, Any]:
    keys = ("id", "name", "metric_match", "rule_type", "operator", "threshold", "reference_period",
            "consecutive_updates", "severity", "cooldown_minutes", "row_version")
    out = {k: c[k] for k in keys}
    out.update(enabled=bool(c["enabled"]), starter=bool(c["starter"]), matches=matches,
               preview=L.preview_for(c, "a matching metric", None))
    return out


def config_matches(conn: sqlite3.Connection, pattern: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT m.id AS metric_id, m.metric_name, o.name AS object_name, c.name AS client_name FROM bams_metrics m"
        " JOIN bams_objects o ON o.id = m.object_id JOIN clients c ON c.id = o.client_id"
        " WHERE m.enabled = 1 AND o.enabled = 1 AND lower(m.metric_name) GLOB lower(:p) ORDER BY o.name, m.metric_name, m.id",
        {"p": pattern})]


def configs_list(conn: sqlite3.Connection) -> Dict[str, Any]:
    cfgs = [dict(r) for r in conn.execute("SELECT * FROM bams_alert_configs ORDER BY starter DESC, name COLLATE NOCASE, id")]
    return {"ok": True, "items": [config_public(c, len(config_matches(conn, c["metric_match"]))) for c in cfgs]}
