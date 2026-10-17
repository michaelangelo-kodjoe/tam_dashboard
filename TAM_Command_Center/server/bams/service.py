"""BAMS write services: every write = data change + audit row(s) in ONE transaction (rules as server/services.py)."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from typing import Any, Dict, List, Optional

from ..audit import write_audit
from ..dbkit import migrate, transaction
from ..errors import Conflict, ConfirmationRequired, NotFound, PreviewStale, ValidationFailed
from ..services import _apply_update, _check_version, _map_integrity, _ok
from . import lifecycle as L
from . import reads, repo
from .clock import fmt
from .monitor import backfill, make_ctx, record_in_app
from .provider import SimulatedProvider
from .schemas import (BamsSettingsSave, CloseAlert, ConfigApply, ConfigDelete, ConfigSave, DeleteById, DevClock,
                      DevForce, DevOutage, DevReset, DevStale, MetricIn, MetricSave, NotificationsRead, ObjectSave,
                      RuleSave)

BANNER_PROD = "BLPAPI provider is not connected. No live values are shown."


def _fail(field: str, msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={field: msg})


def _audit(conn: sqlite3.Connection, object_type: str, action: str, oid: str, label: str, *, client_id: Optional[str] = None,
           old: Any = None, new: Any = None, reason: Optional[str] = None, source: str = "GUI",
           category: str = "bams") -> None:
    write_audit(conn, category=category, client_id=client_id, object_type=object_type, object_id=oid, label=label,
                action=action, old=old, new=new, reason=reason, source=source)


# ===================================================================== monitor and settings
def banner(rt: Any) -> Optional[Dict[str, str]]:
    ok, msg = rt.bams.provider.availability()
    if ok:
        return None
    return {"code": "provider_unavailable", "text": BANNER_PROD if not rt.bams.provider.simulated else (msg or "")}


def _desired(conn: sqlite3.Connection, rt: Any) -> bool:
    v = repo.meta_get(conn, repo.DESIRED_KEY)
    return (v == "1") if v is not None else rt.config.mode == "DEV"


def monitor_block(rt: Any, conn: sqlite3.Connection) -> Dict[str, Any]:
    return rt.bams.info(_desired(conn, rt), repo.read_settings(conn)["poll_interval_seconds"])


def monitor_get(rt: Any) -> Dict[str, Any]:
    with rt.db() as conn:
        return {"ok": True, "monitor": monitor_block(rt, conn), "provider": rt.bams.provider_info()}


def _set_running(rt: Any, want: bool) -> Dict[str, Any]:
    with rt.db() as conn:
        noop = _desired(conn, rt) == want and rt.bams.active == want
        if not noop:
            with transaction(conn):
                old = _desired(conn, rt)
                repo.meta_set(conn, repo.DESIRED_KEY, "1" if want else "0")
                _audit(conn, "setting", "monitor_started" if want else "monitor_stopped", "bams.monitor", "BAMS monitor",
                       old={"desired_running": old}, new={"desired_running": want})
            rt.bams.activate() if want else rt.bams.deactivate()
        return _ok({"monitor": monitor_block(rt, conn)})


def monitor_start(rt: Any) -> Dict[str, Any]:
    return _set_running(rt, True)


def monitor_stop(rt: Any) -> Dict[str, Any]:
    return _set_running(rt, False)


def settings_get(rt: Any) -> Dict[str, Any]:
    with rt.db() as conn:
        return {"ok": True, "item": repo.read_settings(conn)}


def settings_save(rt: Any, body: BamsSettingsSave) -> Dict[str, Any]:
    prov = body.provided()
    with rt.db() as conn:
        cur = repo.read_settings(conn)
        changed = {k: v for k, v in prov.items() if v is not None and cur[k] != v}
        if changed:
            with transaction(conn):
                for k, v in changed.items():
                    repo.write_setting(conn, k, v)
                    _audit(conn, "setting", "updated", "bams." + k, "BAMS " + k, old={"value": cur[k]}, new={"value": v})
            rt.bams.poll_interval = repo.read_settings(conn)["poll_interval_seconds"]
        return _ok(repo.read_settings(conn), [] if changed else [{"type": "no_change"}])


# ===================================================================== close alert
def close_alert(rt: Any, event_id: str, body: CloseAlert) -> Dict[str, Any]:
    with rt.db() as conn:
        with transaction(conn):
            ev = repo.event_row(conn, event_id)
            if ev is None:
                raise NotFound("Alert not found.")
            _check_version(ev, body.expected_row_version)
            if ev["status"] == "closed":
                raise Conflict("This alert is already closed.", details={"reason": "already_closed"})
            ctx = make_ctx(rt.bams, conn)
            rule = repo.rule_row(conn, ev["rule_id"]) if ev["rule_id"] else None
            mrows = repo.metric_rows(conn, include_disabled=True, metric_id=ev["metric_id"])
            row = reads.build_row(mrows[0], ctx, [ev]) if mrows else None
            breaching = reads.still_breaching(ev, rule, row)
            now = ctx.now
            closed_at = max(fmt(now), ev["opened_at"], ev["recovered_at"] or "", ev["last_triggered_at"] or "")
            cur = conn.execute(
                "UPDATE bams_alert_events SET status = 'closed', closed_at = :c, closed_note = :n, updated_at = :c,"
                " row_version = row_version + 1 WHERE id = :i AND status IN ('open','recovered')",
                {"c": closed_at, "n": body.note, "i": event_id})
            if cur.rowcount != 1:
                raise Conflict("This alert is already closed.", details={"reason": "already_closed"})
            if breaching and rule is not None:
                conn.execute("UPDATE bams_alert_rules SET suppress_until_clear = 1 WHERE id = :i", {"i": rule["id"]})
            context = repo.event_context(conn, event_id) or {}
            record_in_app(conn, event_id, "closed", closed_at, repo.read_settings(conn))
            _audit(conn, "bams_alert_event", "closed", event_id, f"{context.get('object_name')} / {context.get('metric_name')}",
                   client_id=context.get("client_id"), old={"status": ev["status"]},
                   new={"status": "closed", "suppressed_until_clear": bool(breaching and rule is not None)}, reason=body.note)
        fresh = repo.event_row(conn, event_id) or {}
        return _ok({"event": reads.event_public(fresh, rule, row, mrows[0]["metric_name"] if mrows else ""),
                    "suppressed_until_clear": bool(breaching and rule is not None)})


# ===================================================================== appliances and metrics
def _obj_public(o: Dict[str, Any], metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    out = {k: o[k] for k in ("id", "client_id", "name", "region", "location", "environment", "row_version")}
    out["enabled"] = bool(o["enabled"])
    out["metrics"] = [{"id": m["id"], "metric_name": m["metric_name"], "ticker": m["ticker"], "enabled": bool(m["enabled"]),
                       "stale_after_seconds": m["stale_after_seconds"], "row_version": m["row_version"]} for m in metrics]
    return out


def _object_row(conn: sqlite3.Connection, oid: str) -> Optional[Dict[str, Any]]:
    r = conn.execute("SELECT * FROM bams_objects WHERE id = :i", {"i": oid}).fetchone()
    return dict(r) if r else None


def _metric_list(conn: sqlite3.Connection, oid: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute("SELECT * FROM bams_metrics WHERE object_id = :o ORDER BY metric_name, id", {"o": oid})]


def _ticker_conflict(conn: sqlite3.Connection, ticker: str, exclude: Optional[str], field: str) -> None:
    owner = repo.ticker_owner(conn, ticker, exclude)
    if owner:
        raise Conflict(f"Ticker {ticker} is already used by {owner['metric_name']} on {owner['object_name']}.",
                       fields={field: f"Ticker {ticker} is already used by {owner['metric_name']} on {owner['object_name']}."},
                       details={"owner": owner})


def _name_conflict(conn: sqlite3.Connection, client_id: str, name: str, exclude: Optional[str]) -> None:
    r = conn.execute("SELECT 1 FROM bams_objects WHERE client_id = :c AND lower(name) = lower(:n) AND id <> :x",
                     {"c": client_id, "n": name, "x": exclude or ""}).fetchone()
    if r:
        raise Conflict(f"An appliance named {name} already exists for this account.",
                       fields={"name": f"An appliance named {name} already exists for this account."})


def _check_batch(items: List[MetricIn], existing_names: Dict[str, str]) -> None:
    """Conflicts inside one request: repeated tickers and repeated metric names."""
    seen_t: Dict[str, int] = {}
    for i, m in enumerate(items):
        p = m.provided("id", "expected_row_version")
        t = p.get("ticker")
        if t:
            k = t.casefold()
            if k in seen_t:
                raise Conflict(f"Ticker {t} is used twice in this request.",
                               fields={f"metrics[{seen_t[k]}].ticker": "Repeated ticker.", f"metrics[{i}].ticker": "Repeated ticker."})
            seen_t[k] = i


def _insert_metric(conn: sqlite3.Connection, obj: Dict[str, Any], p: Dict[str, Any], idx: int, now: str) -> Dict[str, Any]:
    for need in ("metric_name", "ticker"):
        if not p.get(need):
            raise _fail(f"metrics[{idx}].{need}", "is required")
    _ticker_conflict(conn, p["ticker"], None, f"metrics[{idx}].ticker")
    dup = conn.execute("SELECT 1 FROM bams_metrics WHERE object_id = :o AND lower(metric_name) = lower(:n)",
                       {"o": obj["id"], "n": p["metric_name"]}).fetchone()
    if dup:
        raise Conflict(f"This appliance already has a metric named {p['metric_name']}.",
                       fields={f"metrics[{idx}].metric_name": "Metric name already exists on this appliance."})
    mid = str(uuid.uuid4())
    vals = {"id": mid, "o": obj["id"], "n": p["metric_name"], "t": p["ticker"], "e": 1 if p.get("enabled", True) else 0,
            "s": p.get("stale_after_seconds") or 120, "now": now}
    conn.execute("INSERT INTO bams_metrics (id, object_id, metric_name, ticker, enabled, stale_after_seconds, created_at,"
                 " updated_at) VALUES (:id, :o, :n, :t, :e, :s, :now, :now)", vals)
    _audit(conn, "bams_metric", "created", mid, f"{obj['name']} / {p['metric_name']}", client_id=obj["client_id"],
           new={"metric_name": p["metric_name"], "ticker": p["ticker"], "enabled": bool(vals["e"]),
                "stale_after_seconds": vals["s"]})
    return {"id": mid}


def _patch_metric(conn: sqlite3.Connection, obj: Dict[str, Any], mrow: Dict[str, Any], p: Dict[str, Any], expected: Optional[int],
                  idx: str) -> bool:
    _check_version(mrow, expected)
    ch: Dict[str, Any] = {}
    for k in ("metric_name", "ticker", "stale_after_seconds"):
        if k in p and p[k] is not None and p[k] != mrow[k]:
            ch[k] = p[k]
    if "enabled" in p and p["enabled"] is not None and int(p["enabled"]) != mrow["enabled"]:
        ch["enabled"] = int(p["enabled"])
    if not ch:
        return False
    if "ticker" in ch:
        _ticker_conflict(conn, ch["ticker"], mrow["id"], f"{idx}.ticker")
    if "metric_name" in ch:
        dup = conn.execute("SELECT 1 FROM bams_metrics WHERE object_id = :o AND lower(metric_name) = lower(:n) AND id <> :i",
                           {"o": obj["id"], "n": ch["metric_name"], "i": mrow["id"]}).fetchone()
        if dup:
            raise Conflict("This appliance already has a metric with that name.",
                           fields={f"{idx}.metric_name": "Metric name already exists on this appliance."})
    _apply_update(conn, "bams_metrics", mrow, ch, ("metric_name", "ticker", "stale_after_seconds", "enabled"))
    if "ticker" in ch:                     # history belongs to the metric; the cached reading does not
        conn.execute("UPDATE bams_metrics SET current_value = NULL, last_source_update = NULL, last_received = NULL"
                     " WHERE id = :i", {"i": mrow["id"]})
    _audit(conn, "bams_metric", "updated", mrow["id"], f"{obj['name']} / {mrow['metric_name']}", client_id=obj["client_id"],
           old={k: mrow[k] for k in ch}, new=dict(ch))
    return True


def _carry_upgrade_records(conn: sqlite3.Connection, obj: Dict[str, Any], new_name: str, now: str) -> None:
    """Renaming an appliance moves its Operations records (server_upgrades.server_name) with it, same transaction.
    A record already stored under the new name in the same quarter (an orphan) is never merged or overwritten:
    the rename is refused with a 409 naming the quarter."""
    from ..ops import repo as ops_repo
    recs = ops_repo.records_named(conn, obj["client_id"], obj["name"])
    for r in recs:
        for o in ops_repo.records_named(conn, obj["client_id"], new_name):
            if o["id"] != r["id"] and o["schedule_year"] == r["schedule_year"] and o["schedule_quarter"] == r["schedule_quarter"] \
                    and (r["schedule_year"] is not None or (o["scheduled_date"] or "") == (r["scheduled_date"] or "")):
                lab = f"{o['schedule_year']} {o['schedule_quarter']}" if o["schedule_year"] else "an ad-hoc upgrade"
                raise Conflict(f"Cannot rename: an Operations record named {new_name} already exists for {lab}. "
                               "Reset or delete that record first, then rename.",
                               fields={"name": "an Operations record with this name already exists"},
                               details={"reason": "upgrade_record_collision", "quarter": lab})
    for r in recs:
        ops_repo.rename_record(conn, r["id"], new_name, now)
        label = f"{new_name} {r['schedule_year']} {r['schedule_quarter']}" if r["schedule_year"] else new_name
        write_audit(conn, category="operations", client_id=obj["client_id"], object_type="server_upgrade", object_id=r["id"],
                    label=label, action="updated", old={"server_name": obj["name"]}, new={"server_name": new_name},
                    reason="appliance renamed in BAMS", source="GUI")


def object_save(rt: Any, body: ObjectSave) -> Dict[str, Any]:
    prov = body.provided("id", "expected_row_version", "metrics", "client_id")
    items = body.metrics or []
    with rt.db() as conn:
        try:
            with transaction(conn):
                now = migrate.utc_now()
                changed = False
                if body.id is None:
                    if not body.client_id:
                        raise _fail("client_id", "is required")
                    if conn.execute("SELECT 1 FROM clients WHERE id = :i", {"i": body.client_id}).fetchone() is None:
                        raise _fail("client_id", "unknown account")
                    if not prov.get("name"):
                        raise _fail("name", "is required")
                    if not items:
                        raise _fail("metrics", "Add at least one metric.")
                    _name_conflict(conn, body.client_id, prov["name"], None)
                    _check_batch(items, {})
                    names: Dict[str, int] = {}
                    for i, m in enumerate(items):
                        n = (m.metric_name or "").casefold()
                        if n and n in names:
                            raise Conflict("A metric name is repeated in this appliance.",
                                           fields={f"metrics[{names[n]}].metric_name": "Repeated metric name.",
                                                   f"metrics[{i}].metric_name": "Repeated metric name."})
                        names[n] = i
                    oid = str(uuid.uuid4())
                    conn.execute("INSERT INTO bams_objects (id, client_id, name, region, location, environment, enabled,"
                                 " created_at, updated_at) VALUES (:id, :c, :n, :r, :l, :e, :en, :now, :now)",
                                 {"id": oid, "c": body.client_id, "n": prov["name"], "r": prov.get("region"),
                                  "l": prov.get("location"), "e": prov.get("environment"),
                                  "en": 0 if prov.get("enabled") is False else 1, "now": now})
                    obj = _object_row(conn, oid) or {}
                    _audit(conn, "bams_object", "created", oid, obj["name"], client_id=body.client_id,
                           new={"name": obj["name"], "region": obj["region"], "location": obj["location"],
                                "environment": obj["environment"], "enabled": bool(obj["enabled"]), "metrics": len(items)})
                    for i, m in enumerate(items):
                        _insert_metric(conn, obj, m.provided("id", "expected_row_version"), i, now)
                    changed = True
                else:
                    obj = _object_row(conn, body.id)
                    if obj is None:
                        raise NotFound("Appliance not found.")
                    _check_version(obj, body.expected_row_version)
                    if body.client_id and body.client_id != obj["client_id"]:
                        raise _fail("client_id", "cannot be changed")
                    ch = {k: (int(v) if k == "enabled" else v) for k, v in prov.items() if v != obj.get(k)
                          and not (k == "enabled" and v is None)}
                    ch = {k: v for k, v in ch.items() if not (k == "name" and v is None)}
                    if "name" in ch:
                        _name_conflict(conn, obj["client_id"], ch["name"], obj["id"])
                    _check_batch(items, {})
                    if ch:
                        if "name" in ch:
                            _carry_upgrade_records(conn, obj, ch["name"], now)     # D-112 rename limit (QA-6 follow-up)
                        _apply_update(conn, "bams_objects", obj, ch, ("name", "region", "location", "environment", "enabled"))
                        _audit(conn, "bams_object", "updated", obj["id"], obj["name"], client_id=obj["client_id"],
                               old={k: obj[k] for k in ch}, new=dict(ch))
                        changed = True
                    have = {m["id"]: m for m in _metric_list(conn, obj["id"])}
                    for i, m in enumerate(items):
                        p = m.provided("id", "expected_row_version")
                        if m.id:
                            if m.id not in have:
                                raise _fail(f"metrics[{i}].id", "unknown metric for this appliance")
                            changed |= _patch_metric(conn, obj, have[m.id], p, m.expected_row_version, f"metrics[{i}]")
                        else:
                            _insert_metric(conn, obj, p, i, now)
                            changed = True
                    oid = obj["id"]
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc) from exc
        out = _object_row(conn, oid) or {}
        return _ok({"object": _obj_public(out, _metric_list(conn, oid))}, [] if changed else [{"type": "no_change"}])


def metric_save(rt: Any, body: MetricSave) -> Dict[str, Any]:
    prov = body.provided("id", "expected_row_version", "object_id")
    with rt.db() as conn:
        try:
            with transaction(conn):
                now = migrate.utc_now()
                if body.id is None:
                    if not body.object_id:
                        raise _fail("object_id", "is required")
                    obj = _object_row(conn, body.object_id)
                    if obj is None:
                        raise _fail("object_id", "unknown appliance")
                    mid = _insert_metric(conn, obj, prov, 0, now)["id"]
                    changed = True
                else:
                    row = conn.execute("SELECT * FROM bams_metrics WHERE id = :i", {"i": body.id}).fetchone()
                    if row is None:
                        raise NotFound("Metric not found.")
                    mrow = dict(row)
                    obj = _object_row(conn, mrow["object_id"]) or {}
                    if body.object_id and body.object_id != mrow["object_id"]:
                        raise _fail("object_id", "cannot be changed")
                    changed = _patch_metric(conn, obj, mrow, prov, body.expected_row_version, "metric")
                    mid = body.id
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc) from exc
        m = dict(conn.execute("SELECT * FROM bams_metrics WHERE id = :i", {"i": mid}).fetchone())
        return _ok({"metric": {k: m[k] for k in ("id", "object_id", "metric_name", "ticker", "stale_after_seconds", "row_version")}
                    | {"enabled": bool(m["enabled"])}}, [] if changed else [{"type": "no_change"}])


# ---------------------------------------------------------------- deletes
def delete_preview(conn: sqlite3.Connection, kind: str, item_id: str) -> Dict[str, Any]:
    if kind == "object":
        o = _object_row(conn, item_id)
        if o is None:
            raise NotFound("Appliance not found.")
        p = {"i": item_id}
        q = lambda sql: conn.execute(sql, p).fetchone()[0]  # noqa: E731
        metrics = q("SELECT count(*) FROM bams_metrics WHERE object_id = :i")
        samples = q("SELECT count(*) FROM bams_metric_samples s JOIN bams_metrics m ON m.id = s.metric_id WHERE m.object_id = :i")
        rules = q("SELECT count(*) FROM bams_alert_rules r JOIN bams_metrics m ON m.id = r.metric_id WHERE m.object_id = :i")
        total = q("SELECT count(*) FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id WHERE m.object_id = :i")
        active = q("SELECT count(*) FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id WHERE m.object_id = :i AND e.status <> 'closed'")
        name = o["name"]
    else:
        m = conn.execute("SELECT * FROM bams_metrics WHERE id = :i", {"i": item_id}).fetchone()
        if m is None:
            raise NotFound("Metric not found.")
        p = {"i": item_id}
        q = lambda sql: conn.execute(sql, p).fetchone()[0]  # noqa: E731
        metrics = 1
        samples = q("SELECT count(*) FROM bams_metric_samples WHERE metric_id = :i")
        rules = q("SELECT count(*) FROM bams_alert_rules WHERE metric_id = :i")
        total = q("SELECT count(*) FROM bams_alert_events WHERE metric_id = :i")
        active = q("SELECT count(*) FROM bams_alert_events WHERE metric_id = :i AND status <> 'closed'")
        name = m["metric_name"]
    reason = None
    if active:
        reason = f"{active} alert{' is' if active == 1 else 's are'} still open or recovered. Close {'it' if active == 1 else 'them'} first."
    return {"name": name, "metrics": metrics, "samples": samples, "rules": rules, "alerts_total": total,
            "alerts_active": active, "blocked": bool(active), "blocked_reason": reason}


def delete_preview_route(rt: Any, kind: str, item_id: str) -> Dict[str, Any]:
    with rt.db() as conn:
        return _ok(delete_preview(conn, kind, item_id))


def delete_item(rt: Any, kind: str, body: DeleteById) -> Dict[str, Any]:
    with rt.db() as conn:
        pv = delete_preview(conn, kind, body.id)
        row = _object_row(conn, body.id) if kind == "object" else dict(
            conn.execute("SELECT * FROM bams_metrics WHERE id = :i", {"i": body.id}).fetchone())
        _check_version(row, body.expected_row_version)
        if pv["blocked"]:
            raise Conflict(pv["blocked_reason"], details={"reason": "active_alert", **pv})
        if body.confirm is not True:
            raise ConfirmationRequired("Deleting needs confirmation. Resend with \"confirm\": true.", details=pv)
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            if kind == "object":
                cid = row["client_id"]
                conn.execute("DELETE FROM bams_objects WHERE id = :i", {"i": body.id})
                _audit(conn, "bams_object", "deleted", body.id, row["name"], client_id=cid,
                       old={"name": row["name"], "metrics": pv["metrics"], "samples": pv["samples"], "rules": pv["rules"],
                            "alerts": pv["alerts_total"]}, reason="safety backup " + backup["name"])
            else:
                obj = _object_row(conn, row["object_id"]) or {}
                conn.execute("DELETE FROM bams_metrics WHERE id = :i", {"i": body.id})
                _audit(conn, "bams_metric", "deleted", body.id, f"{obj.get('name')} / {row['metric_name']}",
                       client_id=obj.get("client_id"),
                       old={"metric_name": row["metric_name"], "ticker": row["ticker"], "samples": pv["samples"],
                            "rules": pv["rules"], "alerts": pv["alerts_total"]}, reason="safety backup " + backup["name"])
    return _ok({"deleted": {"id": body.id, "name": pv["name"], "metrics": pv["metrics"], "samples": pv["samples"],
                            "rules": pv["rules"], "alerts": pv["alerts_total"]}},
               [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


# ===================================================================== rules and templates
_RULE_COLS = ("rule_type", "operator", "threshold", "reference_period", "consecutive_updates", "severity", "cooldown_minutes")
_RULE_DEFAULTS = {"operator": ">", "consecutive_updates": 1, "severity": "Warning", "cooldown_minutes": 0, "enabled": 1,
                  "threshold": None, "reference_period": None, "rule_type": None}


def _merge_rule(base: Dict[str, Any], prov: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in prov.items():
        out[k] = (int(v) if isinstance(v, bool) else v)
    return out


def _validate_merged(merged: Dict[str, Any], extra: Optional[Dict[str, str]] = None) -> None:
    f = L.validate_rule_fields(merged)
    f.update(extra or {})
    if f:
        raise ValidationFailed("Request validation failed.", fields=f)


def rule_save(rt: Any, body: RuleSave) -> Dict[str, Any]:
    prov = body.provided("id", "expected_row_version", "metric_id")
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    if not body.metric_id:
                        raise _fail("metric_id", "is required")
                    mrow = conn.execute("SELECT m.metric_name, m.object_id, o.name AS oname, o.client_id FROM bams_metrics m"
                                        " JOIN bams_objects o ON o.id = m.object_id WHERE m.id = :i", {"i": body.metric_id}).fetchone()
                    if mrow is None:
                        raise _fail("metric_id", "unknown metric")
                    merged = _merge_rule({**_RULE_DEFAULTS, "breach_count": 0, "suppress_until_clear": 0}, prov)
                    _validate_merged(merged)
                    rid = str(uuid.uuid4())
                    now = migrate.utc_now()
                    conn.execute(
                        "INSERT INTO bams_alert_rules (id, metric_id, rule_type, operator, threshold, reference_period,"
                        " consecutive_updates, severity, cooldown_minutes, enabled, suppress_until_clear, created_at, updated_at)"
                        " VALUES (:id, :m, :rule_type, :operator, :threshold, :reference_period, :consecutive_updates,"
                        " :severity, :cooldown_minutes, :enabled, :suppress_until_clear, :now, :now)",
                        {**{k: merged[k] for k in _RULE_COLS}, "id": rid, "m": body.metric_id, "enabled": merged["enabled"],
                         "suppress_until_clear": merged["suppress_until_clear"], "now": now})
                    _audit(conn, "bams_alert_rule", "created", rid, f"{mrow['oname']} / {mrow['metric_name']}",
                           client_id=mrow["client_id"], new={k: merged[k] for k in _RULE_COLS} | {"enabled": bool(merged["enabled"])})
                    changed = True
                else:
                    rule = repo.rule_row(conn, body.id)
                    if rule is None:
                        raise NotFound("Rule not found.")
                    _check_version(rule, body.expected_row_version)
                    merged = _merge_rule(rule, prov)
                    _validate_merged(merged)
                    cols = _RULE_COLS + ("enabled", "suppress_until_clear")
                    ch = {k: merged[k] for k in cols if merged[k] != rule[k]}
                    changed = bool(ch)
                    rid = rule["id"]
                    if ch:
                        cfg = {k: v for k, v in ch.items() if k != "suppress_until_clear"}
                        sets = dict(ch)
                        if cfg:
                            sets["breach_count"] = 0
                        sets_sql = ", ".join(f"{k} = :{k}" for k in sets)
                        conn.execute(f"UPDATE bams_alert_rules SET {sets_sql}, updated_at = :_now, row_version = row_version + 1"  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
                                     " WHERE id = :_id AND row_version = :_v",
                                     {**sets, "_now": migrate.utc_now(), "_id": rid, "_v": rule["row_version"]})
                        mrow = conn.execute("SELECT m.metric_name, o.name AS oname, o.client_id FROM bams_metrics m JOIN"
                                            " bams_objects o ON o.id = m.object_id WHERE m.id = :i", {"i": rule["metric_id"]}).fetchone()
                        _audit(conn, "bams_alert_rule", "updated", rid, f"{mrow['oname']} / {mrow['metric_name']}",
                               client_id=mrow["client_id"], old={k: rule[k] for k in ch}, new=dict(ch))
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc) from exc
        rule = repo.rule_row(conn, rid) or {}
        mr = conn.execute("SELECT metric_name, high_30, high_60, high_90 FROM bams_metrics WHERE id = :i", {"i": rule["metric_id"]}).fetchone()
        return _ok({"rule": reads.rule_public(rule, mr["metric_name"], dict(mr))}, [] if changed else [{"type": "no_change"}])


def rule_delete(rt: Any, body: DeleteById) -> Dict[str, Any]:
    with rt.db() as conn:
        rule = repo.rule_row(conn, body.id)
        if rule is None:
            raise NotFound("Rule not found.")
        _check_version(rule, body.expected_row_version)
        active = conn.execute("SELECT count(*) FROM bams_alert_events WHERE rule_id = :i AND status <> 'closed'",
                              {"i": body.id}).fetchone()[0]
        if active:       # schema trigger trg_bams_alert_rules_no_delete_active (DA): close the alert first
            raise Conflict("This rule has an alert that is still open or recovered. Close it first.",
                           details={"reason": "active_alert", "alerts_active": active})
        if body.confirm is not True:
            raise ConfirmationRequired("Deleting needs confirmation. Resend with \"confirm\": true.")
        with transaction(conn):
            mrow = conn.execute("SELECT m.metric_name, o.name AS oname, o.client_id FROM bams_metrics m JOIN bams_objects o"
                                " ON o.id = m.object_id WHERE m.id = :i", {"i": rule["metric_id"]}).fetchone()
            conn.execute("DELETE FROM bams_alert_rules WHERE id = :i", {"i": body.id})
            _audit(conn, "bams_alert_rule", "deleted", body.id, f"{mrow['oname']} / {mrow['metric_name']}",
                   client_id=mrow["client_id"], old={k: rule[k] for k in _RULE_COLS})
    return _ok({"deleted": {"id": body.id}})


# ---------------------------------------------------------------- starter templates (alert configs)
STARTERS = (("Exceeds the 90-day high (Warning)", "*", "exceeds_high", ">", None, "90d", "Warning"),
            ("90% of the 90-day high (Critical)", "*", "pct_of_high", ">=", 90.0, "90d", "Critical"))


def ensure_starters(conn: sqlite3.Connection) -> None:
    """Fresh databases get the two starter templates once (marker in app_meta); never re-created after a delete."""
    if repo.meta_get(conn, repo.STARTERS_KEY) is not None:
        return
    with transaction(conn):
        if conn.execute("SELECT count(*) FROM bams_alert_configs").fetchone()[0] == 0:
            now = migrate.utc_now()
            for name, match, rt_, op, thr, ref, sev in STARTERS:
                conn.execute("INSERT INTO bams_alert_configs (id, name, metric_match, rule_type, operator, threshold,"
                             " reference_period, consecutive_updates, severity, cooldown_minutes, enabled, starter,"
                             " created_at, updated_at) VALUES (:id, :n, :m, :t, :o, :th, :r, 1, :s, 0, 1, 1, :now, :now)",
                             {"id": str(uuid.uuid4()), "n": name, "m": match, "t": rt_, "o": op, "th": thr, "r": ref,
                              "s": sev, "now": now})
        repo.meta_set(conn, repo.STARTERS_KEY, "1")


def configs_save(rt: Any, body: ConfigSave) -> Dict[str, Any]:
    prov = body.provided("id", "expected_row_version", "metric_id", "suppress_until_clear")
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    merged = _merge_rule({**_RULE_DEFAULTS, "name": None, "metric_match": None, "starter": 0}, prov)
                    extra = {k: "is required" for k in ("name", "metric_match") if not merged.get(k)}
                    _validate_merged(merged, extra)
                    cid = str(uuid.uuid4())
                    now = migrate.utc_now()
                    conn.execute(
                        "INSERT INTO bams_alert_configs (id, name, metric_match, rule_type, operator, threshold, reference_period,"
                        " consecutive_updates, severity, cooldown_minutes, enabled, starter, created_at, updated_at)"
                        " VALUES (:id, :name, :metric_match, :rule_type, :operator, :threshold, :reference_period,"
                        " :consecutive_updates, :severity, :cooldown_minutes, :enabled, 0, :now, :now)",
                        {**{k: merged[k] for k in _RULE_COLS + ("name", "metric_match", "enabled")}, "id": cid, "now": now})
                    _audit(conn, "bams_alert_config", "created", cid, merged["name"],
                           new={k: merged[k] for k in _RULE_COLS + ("name", "metric_match")})
                    changed = True
                else:
                    cfg = conn.execute("SELECT * FROM bams_alert_configs WHERE id = :i", {"i": body.id}).fetchone()
                    if cfg is None:
                        raise NotFound("Template not found.")
                    cfg = dict(cfg)
                    _check_version(cfg, body.expected_row_version)
                    merged = _merge_rule(cfg, prov)
                    _validate_merged(merged)
                    cols = _RULE_COLS + ("name", "metric_match", "enabled")
                    ch = {k: merged[k] for k in cols if merged[k] != cfg[k]}
                    changed = bool(ch)
                    cid = cfg["id"]
                    if ch:
                        _apply_update(conn, "bams_alert_configs", cfg, ch, cols)
                        _audit(conn, "bams_alert_config", "updated", cid, cfg["name"], old={k: cfg[k] for k in ch}, new=dict(ch))
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc) from exc
        c = dict(conn.execute("SELECT * FROM bams_alert_configs WHERE id = :i", {"i": cid}).fetchone())
        return _ok({"config": reads.config_public(c, len(reads.config_matches(conn, c["metric_match"])))},
                   [] if changed else [{"type": "no_change"}])


def configs_delete(rt: Any, body: ConfigDelete) -> Dict[str, Any]:
    with rt.db() as conn:
        cfg = conn.execute("SELECT * FROM bams_alert_configs WHERE id = :i", {"i": body.id}).fetchone()
        if cfg is None:
            raise NotFound("Template not found.")
        if body.confirm is not True:
            raise ConfirmationRequired("Deleting needs confirmation. Resend with \"confirm\": true.")
        with transaction(conn):
            conn.execute("DELETE FROM bams_alert_configs WHERE id = :i", {"i": body.id})
            _audit(conn, "bams_alert_config", "deleted", body.id, cfg["name"], old={"name": cfg["name"]})
    return _ok({"deleted": {"id": body.id}})


def _plan(conn: sqlite3.Connection, cfg: Dict[str, Any], metric_ids: Optional[List[str]]) -> Dict[str, Any]:
    matches = reads.config_matches(conn, cfg["metric_match"])
    by = {m["metric_id"]: m for m in matches}
    if metric_ids is not None:
        bad = [i for i in metric_ids if i not in by]
        if bad:
            raise _fail("metric_ids", "One or more metrics do not match this template.")
        matches = [by[i] for i in dict.fromkeys(metric_ids)]
    out = []
    for m in matches:
        ident = False
        for r in repo.rules_for_metric(conn, m["metric_id"]):
            if all(r[k] == cfg[k] for k in _RULE_COLS):
                ident = True
                break
        out.append({"metric_id": m["metric_id"], "metric_name": m["metric_name"], "object_name": m["object_name"],
                    "client_name": m["client_name"], "action": "skip_identical" if ident else "create"})
    blob = json.dumps([[cfg["id"], cfg["row_version"]] + [cfg[k] for k in _RULE_COLS],
                       [[x["metric_id"], x["action"]] for x in out]], sort_keys=True, default=str)
    return {"metrics": out, "plan_hash": "sha256:" + hashlib.sha256(blob.encode()).hexdigest(),
            "would_create": sum(1 for x in out if x["action"] == "create"),
            "skipped_identical": sum(1 for x in out if x["action"] == "skip_identical")}


def configs_apply(rt: Any, body: ConfigApply) -> Dict[str, Any]:
    with rt.db() as conn:
        c = conn.execute("SELECT * FROM bams_alert_configs WHERE id = :i", {"i": body.config_id}).fetchone()
        if c is None:
            raise NotFound("Template not found.")
        cfg = dict(c)
        if body.preview:
            pl = _plan(conn, cfg, body.metric_ids)
            return _ok({"config_id": cfg["id"], "plan_hash": pl["plan_hash"], "would_create": pl["would_create"],
                        "skipped_identical": pl["skipped_identical"], "metrics": pl["metrics"]})
        if body.confirm is not True:
            raise ConfirmationRequired("Applying a template needs confirmation. Resend with \"confirm\": true.")
        if not body.plan_hash:
            raise _fail("plan_hash", "is required: preview first")
        ids: List[str] = []
        with transaction(conn):
            pl = _plan(conn, cfg, body.metric_ids)
            if pl["plan_hash"] != body.plan_hash:
                raise PreviewStale("The matching metrics or existing rules changed since the preview. Preview again.")
            now = migrate.utc_now()
            for x in pl["metrics"]:
                if x["action"] != "create":
                    continue
                rid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO bams_alert_rules (id, metric_id, rule_type, operator, threshold, reference_period,"
                    " consecutive_updates, severity, cooldown_minutes, enabled, created_at, updated_at) VALUES (:id, :m,"
                    " :rule_type, :operator, :threshold, :reference_period, :consecutive_updates, :severity,"
                    " :cooldown_minutes, :enabled, :now, :now)",
                    {**{k: cfg[k] for k in _RULE_COLS}, "id": rid, "m": x["metric_id"], "enabled": cfg["enabled"], "now": now})
                ids.append(rid)
                cl = conn.execute("SELECT o.client_id FROM bams_metrics m JOIN bams_objects o ON o.id = m.object_id"
                                  " WHERE m.id = :i", {"i": x["metric_id"]}).fetchone()
                _audit(conn, "bams_alert_rule", "created", rid, f"{x['object_name']} / {x['metric_name']}",
                       client_id=cl[0], new={k: cfg[k] for k in _RULE_COLS}, reason="Applied template: " + cfg["name"])
        return _ok({"created": len(ids), "skipped_identical": pl["skipped_identical"], "rule_ids": ids})


# ===================================================================== notifications
def notifications_read(rt: Any, body: NotificationsRead) -> Dict[str, Any]:
    with rt.db() as conn:
        top = conn.execute("SELECT coalesce(max(id), 0) FROM bams_notification_log WHERE channel = 'in_app'").fetchone()[0]
        if body.all:
            through = top
        else:
            assert body.through_id is not None
            if conn.execute("SELECT 1 FROM bams_notification_log WHERE id = :i AND channel = 'in_app'",
                            {"i": body.through_id}).fetchone() is None:
                raise _fail("through_id", "unknown notification")
            through = body.through_id
        with transaction(conn):
            cur = int(repo.meta_get(conn, repo.READ_KEY) or 0)
            if through > cur:                       # the watermark only moves forward
                repo.meta_set(conn, repo.READ_KEY, str(through))
        wm = int(repo.meta_get(conn, repo.READ_KEY) or 0)
        n = conn.execute("SELECT count(*) FROM bams_notification_log WHERE channel = 'in_app' AND id > :w", {"w": wm}).fetchone()[0]
    return _ok({"unread_count": n})


# ===================================================================== DEV-only (registered only in DEV)
def _sim(rt: Any) -> SimulatedProvider:
    p = rt.bams.provider
    if not isinstance(p, SimulatedProvider) or rt.config.mode != "DEV":
        raise NotFound("Not found.")
    return p


def _ticker_of(conn: sqlite3.Connection, metric_id: str) -> str:
    r = conn.execute("SELECT ticker FROM bams_metrics WHERE id = :i", {"i": metric_id}).fetchone()
    if r is None:
        raise NotFound("Metric not found.")
    return r[0]


def dev_row(rt: Any, conn: sqlite3.Connection, metric_id: str) -> Dict[str, Any]:
    ctx = make_ctx(rt.bams, conn)
    ev = reads.events_by_metric(conn).get(metric_id, [])
    return reads.build_row(repo.metric_rows(conn, include_disabled=True, metric_id=metric_id)[0], ctx, ev)


def dev_force(rt: Any, body: DevForce) -> Dict[str, Any]:
    sim = _sim(rt)
    with rt.db() as conn:
        sim.forced[_ticker_of(conn, body.metric_id)] = body.value
        if not body.poll:
            return _ok({"forced": body.value})
        rt.bams.poll_once()
        return _ok({"monitor": monitor_block(rt, conn), "row": dev_row(rt, conn, body.metric_id)})


def dev_stale(rt: Any, body: DevStale) -> Dict[str, Any]:
    sim = _sim(rt)
    if body.metric_id is None:
        sim.stale_all = body.on
    else:
        with rt.db() as conn:
            tk = _ticker_of(conn, body.metric_id)
        (sim.stale_tickers.add if body.on else sim.stale_tickers.discard)(tk)
    return _ok({"metric_id": body.metric_id, "on": body.on})


def dev_outage(rt: Any, body: DevOutage) -> Dict[str, Any]:
    _sim(rt).outage = body.on
    return _ok({"on": body.on})


def dev_poll(rt: Any) -> Dict[str, Any]:
    _sim(rt)
    res = rt.bams.poll_once()
    with rt.db() as conn:
        return _ok({"result": res, "monitor": monitor_block(rt, conn)})


def dev_clock(rt: Any, body: DevClock) -> Dict[str, Any]:
    _sim(rt)
    clk = rt.bams.clock
    if body.advance_seconds is not None:
        clk.advance(body.advance_seconds)
    elif body.set is not None:
        from .clock import parse
        clk.set(parse(body.set))
    else:
        clk.reset()
    return _ok({"server_time": fmt(clk.now())})


def dev_reset(rt: Any, body: DevReset) -> Dict[str, Any]:
    sim = _sim(rt)
    if body.confirm is not True:
        raise ConfirmationRequired("Resetting BAMS history needs confirmation. Resend with \"confirm\": true.")
    with rt.db() as conn:
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            counts = repo.reset_history(conn)
            conn.execute("DELETE FROM app_meta WHERE key = :k", {"k": repo.PRUNE_KEY})
            sim.forced.clear()
            sim.stale_tickers.clear()
            sim.stale_all = False
            sim.outage = False
            backfill(conn, sim, rt.bams.clock.now(), limit=100000)
            _audit(conn, "setting", "bams_reset", "bams.dev", "BAMS DEV data", new=counts)
    return _ok({"cleared": counts}, [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])
