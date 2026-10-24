"""BAMS read models: state table, metric detail, trend, alerts, notifications, templates. Never calls the provider."""
from __future__ import annotations

import datetime as _dt
import sqlite3
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional

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


_SPARK_CHUNK = 300


def spark_many(conn: sqlite3.Connection, metric_ids: Iterable[str], now: _dt.datetime) -> Dict[str, List[float]]:
    """24 hourly points per metric from ONE statement (was 24 round trips per row).

    Bucket i (23..0) is the window [now-(i+1)h, now-i h], both ends inclusive; its point is the latest sample in
    that window (identical semantics to the former per-bucket queries; empty buckets are skipped). The lookups
    stay index seeks on (metric_id, sampled_at), so we never scan or load all samples.
    """
    ids = list(dict.fromkeys(metric_ids))
    out: Dict[str, List[float]] = {m: [] for m in ids}
    bound: Dict[str, Any] = {}
    values = []
    for k, i in enumerate(range(23, -1, -1)):
        bound[f"hi{k}"] = fmt(now - _dt.timedelta(hours=i))
        bound[f"lo{k}"] = fmt(now - _dt.timedelta(hours=i + 1))
        values.append(f"({k}, :hi{k}, :lo{k})")
    buckets = ", ".join(values)
    for start in range(0, len(ids), _SPARK_CHUNK):          # chunked: stays under SQLite's bound-parameter limit
        chunk = ids[start:start + _SPARK_CHUNK]
        params = dict(bound)
        params.update({f"m{j}": mid for j, mid in enumerate(chunk)})
        marks = ", ".join(f"(:m{j})" for j in range(len(chunk)))
        sql = (f"WITH b(k, hi, lo) AS (VALUES {buckets}), ids(mid) AS (VALUES {marks}) "  # nosec B608 - generated placeholders only
               "SELECT ids.mid, b.k, (SELECT s.value FROM bams_metric_samples s WHERE s.metric_id = ids.mid"
               " AND s.sampled_at <= b.hi AND s.sampled_at >= b.lo ORDER BY s.sampled_at DESC LIMIT 1) AS v"
               " FROM ids CROSS JOIN b ORDER BY ids.mid, b.k")
        for mid, _k, v in conn.execute(sql, params):
            if v is not None:
                out[mid].append(v)
    return out


def spark(conn: sqlite3.Connection, metric_id: str, now: _dt.datetime) -> List[float]:
    return spark_many(conn, [metric_id], now)[metric_id]


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
        sparks = spark_many(conn, [r["id"] for r in rows if r["current_value"] is not None], ctx.now)
        for r in rows:
            r["spark"] = sparks[r["id"]] if r["current_value"] is not None else []
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


ZOOM_MAX_POINTS = 2000
ZOOM_MAX_WINDOW = 7 * 86400
SAMPLE_RETENTION_DAYS = 100          # monitor.PRUNE_DAYS


def _instant(field: str, v: str) -> _dt.datetime:
    from ..schemas import normalize_instant
    try:
        return parse(normalize_instant(v))
    except ValueError as exc:
        raise _bad(field, str(exc)) from None


def _zoom(conn: sqlite3.Connection, ctx: Ctx, m: Dict[str, Any], frm: str, to: str) -> Dict[str, Any]:
    """Raw samples inside [from, to]; evenly thinned (first and last kept) only above ZOOM_MAX_POINTS."""
    lo_dt, hi_dt = _instant("from", frm), _instant("to", to)
    if lo_dt >= hi_dt:
        raise _bad("from", "must be earlier than to")
    if (hi_dt - lo_dt).total_seconds() > ZOOM_MAX_WINDOW:
        raise _bad("to", "the window can be at most 7 days")
    if lo_dt < ctx.now - _dt.timedelta(days=SAMPLE_RETENTION_DAYS):
        raise _bad("from", f"is older than the {SAMPLE_RETENTION_DAYS}-day sample retention")
    if lo_dt > ctx.now:
        raise _bad("from", "must not be in the future")
    lo, hi = fmt(lo_dt), fmt(hi_dt)
    item = _empty_trend(m["metric_id"], "custom", lo, hi)
    item["sample_interval_seconds"] = ctx.interval
    if ctx.available:
        rows = conn.execute("SELECT sampled_at, value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at >= :lo"
                            " AND sampled_at <= :hi ORDER BY sampled_at, id", {"m": m["metric_id"], "lo": lo, "hi": hi}).fetchall()
        n = len(rows)
        if n:
            vals = [r[1] for r in rows]
            item["text"] = {"min": min(vals), "max": max(vals), "last": vals[-1], "count": n, "from": rows[0][0], "to": rows[-1][0]}
            if n > ZOOM_MAX_POINTS:
                idx = sorted({round(i * (n - 1) / (ZOOM_MAX_POINTS - 1)) for i in range(ZOOM_MAX_POINTS)})
                rows = [rows[i] for i in idx]
                item["downsampled"] = True
            item["points"] = [{"t": r[0], "v": r[1]} for r in rows]
    _add_lines(conn, item, m)
    return {"ok": True, "item": item}


def _empty_trend(metric_id: str, rng: str, lo: str, hi: str) -> Dict[str, Any]:
    return {"metric_id": metric_id, "range": rng, "from": lo, "to": hi, "points": [], "downsampled": False,
            "text": {"min": None, "max": None, "last": None, "count": 0, "from": None, "to": None},
            "reference_lines": [], "rule_lines": []}


def _add_lines(conn: sqlite3.Connection, item: Dict[str, Any], m: Dict[str, Any]) -> None:
    metric_id = item["metric_id"]
    for key, label, k in (("high_30", "30D high", "30"), ("high_60", "60D high", "60"), ("high_90", "90D high", "90")):
        if m[key] is not None:
            item["reference_lines"].append({"id": "high_" + k, "label": label, "value": m[key], "date": m["high_%s_date" % k]})
    highs = {"high_30": m["high_30"], "high_60": m["high_60"], "high_90": m["high_90"]}
    for r in repo.rules_for_metric(conn, metric_id, enabled_only=True):
        lv = L.level(r, highs)
        if lv is not None:
            item["rule_lines"].append({"rule_id": r["id"], "label": f"{r['severity']} threshold {L.num(lv)}",
                                       "value": lv, "severity": r["severity"]})


def trend(conn: sqlite3.Connection, ctx: Ctx, metric_id: str, rng: str, frm: Optional[str] = None,
          to: Optional[str] = None) -> Dict[str, Any]:
    if (frm is None) != (to is None):
        raise _bad("from" if frm is None else "to", "from and to must be given together")
    if frm is None and rng not in RANGES:
        raise _bad("range", "must be one of 24h, 7d, 30d, 90d")
    rows = repo.metric_rows(conn, include_disabled=True, metric_id=metric_id)
    if not rows:
        raise NotFound("Metric not found.")
    m = rows[0]
    if frm is not None:
        return _zoom(conn, ctx, m, frm, to)
    lo_dt, hi_dt = ctx.now - _dt.timedelta(seconds=RANGES[rng]), ctx.now
    lo, hi = fmt(lo_dt), fmt(hi_dt)
    item = _empty_trend(metric_id, rng, lo, hi)
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
    _add_lines(conn, item, m)
    return {"ok": True, "item": item}


# ------------------------------------------------------------------ alerts list
def alerts_list(conn: sqlite3.Connection, ctx: Ctx, status: str, account: Optional[str], metric_id: Optional[str],
                limit: int, before: Optional[str]) -> Dict[str, Any]:
    if status not in ("active", "open", "recovered", "closed", "all"):
        raise _bad("status", "unknown status")
    base = (" FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id JOIN bams_objects o ON o.id = m.object_id"
            " JOIN clients c ON c.id = o.client_id")
    # Visibility and filters are applied in SQL; closed history is counted with GROUP BY and only one page is read.
    where = ["(e.status = 'closed' OR (m.enabled = 1 AND o.enabled = 1))"]
    params: Dict[str, Any] = {}
    ids = sorted({a for a in (account or "").split(",") if a})
    if ids:
        names = [f"a{i}" for i in range(len(ids))]
        where.append("o.client_id IN (" + ",".join(":" + n for n in names) + ")")
        params.update(zip(names, ids))
    if metric_id:
        where.append("e.metric_id = :metric_id")
        params["metric_id"] = metric_id
    flt = " WHERE " + " AND ".join(where)
    cols = ("SELECT e.*, m.metric_name, m.ticker, m.enabled AS m_enabled, o.id AS object_id, o.name AS object_name,"
            " o.client_id, o.location, o.enabled AS o_enabled, c.name AS client_name")
    counts = {"active": 0, "open": 0, "recovered": 0, "closed": 0}
    for st, n in conn.execute("SELECT e.status, count(*)" + base + flt + " GROUP BY e.status", params):
        counts[st] += n
        if st != "closed":
            counts["active"] += n
    want = {"active": ("open", "recovered"), "open": ("open",), "recovered": ("recovered",), "closed": ("closed",),
            "all": ("open", "recovered", "closed")}[status]
    act: List[Dict[str, Any]] = []
    act_want = [s_ for s_ in want if s_ != "closed"]
    if act_want and not before:                     # active events are few (open/recovered only), so read them all
        marks = ",".join(f":w{i}" for i in range(len(act_want)))
        p = {**params, **{f"w{i}": v for i, v in enumerate(act_want)}}
        act = sorted((dict(r) for r in conn.execute(cols + base + flt + f" AND e.status IN ({marks})", p)),
                     key=lambda r: (0 if r["status"] == "open" else 1, -SEV[r["severity"]], r["opened_at"], r["id"]))
    clo: List[Dict[str, Any]] = []
    room = limit + 1 - len(act)
    if "closed" in want and room > 0:
        q = cols + base + flt + " AND e.status = 'closed'"
        if before:
            q += " AND e.opened_at < :before"
            params["before"] = before
        clo = [dict(r) for r in conn.execute(q + " ORDER BY e.opened_at DESC, e.id DESC LIMIT :lim", {**params, "lim": room})]
    ordered = act + clo
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
    out.update(enabled=bool(c["enabled"]), starter=bool(c["starter"]), auto_apply=bool(c.get("auto_apply", 0)),
               matches=matches, preview=L.preview_for(c, "a matching metric", None))
    return out


def config_matches(conn: sqlite3.Connection, pattern: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT m.id AS metric_id, m.metric_name, o.name AS object_name, c.name AS client_name FROM bams_metrics m"
        " JOIN bams_objects o ON o.id = m.object_id JOIN clients c ON c.id = o.client_id"
        " WHERE m.enabled = 1 AND o.enabled = 1 AND lower(m.metric_name) GLOB lower(:p) ORDER BY o.name, m.metric_name, m.id",
        {"p": pattern})]


def metric_catalog(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Distinct enabled metric names for metric-first alert policy configuration."""
    rows = conn.execute(
        "SELECT MIN(m.metric_name) AS metric_name, count(*) AS metric_count,"
        " count(DISTINCT o.id) AS appliance_count, count(DISTINCT o.client_id) AS account_count"
        " FROM bams_metrics m JOIN bams_objects o ON o.id = m.object_id"
        " WHERE m.enabled = 1 AND o.enabled = 1"
        " GROUP BY lower(m.metric_name) ORDER BY lower(MIN(m.metric_name))"
    ).fetchall()
    return {"ok": True, "items": [
        {"metric_name": r["metric_name"], "metric_count": int(r["metric_count"]),
         "appliance_count": int(r["appliance_count"]), "account_count": int(r["account_count"])}
        for r in rows
    ]}


def configs_list(conn: sqlite3.Connection) -> Dict[str, Any]:
    cfgs = [dict(r) for r in conn.execute("SELECT * FROM bams_alert_configs ORDER BY starter DESC, name COLLATE NOCASE, id")]
    return {"ok": True, "items": [config_public(c, len(config_matches(conn, c["metric_match"]))) for c in cfgs]}
