"""Operations write services: data change + audit row(s) in ONE transaction (rules as server/services.py)."""
from __future__ import annotations

import sqlite3
import uuid
from typing import Any, Dict, List, Optional

from ..audit import write_audit
from ..dbkit import migrate, transaction
from ..errors import Conflict, ConfirmationRequired, NotFound, ValidationFailed
from ..services import _check_version, _map_integrity, _ok
from . import derive as D
from . import repo
from .schemas import ApplianceReset, ApplianceSave, QuarterDelete, QuarterSave, SetVersion

_QFIELDS = ("apics_version", "dev_upgrade_date", "east_prod_date", "west_prod_date")


def _fail(field: str, msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={field: msg})


def _audit(conn: sqlite3.Connection, otype: str, action: str, oid: str, label: str, *, client_id: Optional[str] = None,
           old: Any = None, new: Any = None, reason: Optional[str] = None) -> None:
    write_audit(conn, category="operations", client_id=client_id, object_type=otype, object_id=oid, label=label,
                action=action, old=old, new=new, reason=reason, source="GUI")


def get(rt: Any, year: Optional[int], q: Optional[str], f: Dict[str, Any]) -> Dict[str, Any]:
    if (year is None) != (q is None):
        raise _fail("year" if year is None else "quarter", "year and quarter go together")
    with rt.db() as conn:
        return {"ok": True, **D.build(conn, rt.today(), year, q, f)}


# ===================================================================== quarters
def _qlabel(y: int, q: str) -> str:
    return D.label(y, q)


def quarter_save(rt: Any, body: QuarterSave) -> Dict[str, Any]:
    vals = {k: getattr(body, k) for k in _QFIELDS}
    with rt.db() as conn:
        try:
            with transaction(conn):
                cur = repo.quarter(conn, body.year, body.quarter)
                now = migrate.utc_now()
                lab = _qlabel(body.year, body.quarter)
                oid = f"{body.year}-{body.quarter}"
                if body.expected_row_version is None:
                    if cur is not None:
                        raise Conflict(f"{lab} already exists. Edit it instead.", fields={"quarter": "already exists"})
                    repo.insert_quarter(conn, {"year": body.year, "quarter": body.quarter, **vals}, now)
                    _audit(conn, "quarterly_upgrade_window", "created", oid, lab, new=vals)
                else:
                    if cur is None:
                        raise NotFound("Quarter not found.")
                    _check_version(cur, body.expected_row_version)
                    ch = {k: v for k, v in vals.items() if cur[k] != v}
                    if ch:
                        repo.update_quarter(conn, body.year, body.quarter, vals, now)
                        _audit(conn, "quarterly_upgrade_window", "updated", oid, lab,
                               old={k: cur[k] for k in ch}, new=ch)
                item = repo.quarter(conn, body.year, body.quarter)
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "quarter") from exc
        return _ok(D.quarter_item({**(item or {}), "records": repo.record_count(conn, body.year, body.quarter)}))


def quarter_delete(rt: Any, body: QuarterDelete) -> Dict[str, Any]:
    with rt.db() as conn:
        cur = repo.quarter(conn, body.year, body.quarter)
        if cur is None:
            raise NotFound("Quarter not found.")
        _check_version(cur, body.expected_row_version)
        lab = _qlabel(body.year, body.quarter)
        n = repo.record_count(conn, body.year, body.quarter)
        if n:
            raise Conflict(f"{n} appliances have a status in this quarter", details={"reason": "has_records", "records": n})
        if body.confirm is not True:
            raise ConfirmationRequired('Deleting a quarter needs confirmation. Resend with "confirm": true.',
                                       details={"label": lab})
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            for o in repo.orphan_records(conn, body.year, body.quarter):     # QA-6-1: records whose appliance is gone
                repo.delete_record(conn, o["id"])
                _audit(conn, "server_upgrade", "deleted", o["id"], f"{o['server_name']} {lab}", client_id=o["client_id"],
                       old={k: o[k] for k in ("status", "scheduled_date", "target_version")},
                       reason="orphan record removed with the quarter; safety backup " + backup["name"])
            if repo.delete_quarter(conn, body.year, body.quarter) != 1:
                raise NotFound("Quarter not found.")
            _audit(conn, "quarterly_upgrade_window", "deleted", f"{body.year}-{body.quarter}", lab,
                   old={k: cur[k] for k in _QFIELDS}, reason="safety backup " + backup["name"])
    return _ok({"year": body.year, "quarter": body.quarter, "label": lab},
               [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


# ===================================================================== appliance records
def _context(conn: sqlite3.Connection, object_id: str, year: int, q: str) -> tuple:
    w = repo.quarter(conn, year, q)
    if w is None:
        raise NotFound("Quarter not found. Add it first.")
    a = repo.appliance(conn, object_id)
    if a is None:
        raise NotFound("Appliance not found.")
    return w, a


def _row(conn: sqlite3.Connection, a: Dict[str, Any], w: Dict[str, Any], today: str) -> Dict[str, Any]:
    rec = repo.record_for(conn, a["client_id"], a["appliance"], w["schedule_year"], w["schedule_quarter"])
    return D.build_row(repo.appliance(conn, a["object_id"]) or a, rec, w, today)


def _need_target(a: Dict[str, Any]) -> tuple:
    env, pol, problem = D.record_target(a["environment"], D.polarity_of(a["region"]))
    if problem:
        raise _fail("polarity" if problem == "needs_polarity" else "environment",
                    D.REASONS[problem] + ". Fix it on the appliance, then save again.")
    return env, pol


def appliance_save(rt: Any, body: ApplianceSave) -> Dict[str, Any]:
    prov = body.provided("object_id", "year", "quarter", "expected_row_version")
    if "status" in prov and prov["status"] is None:
        raise _fail("status", "cannot be blank")
    with rt.db() as conn:
        try:
            with transaction(conn):
                w, a = _context(conn, body.object_id, body.year, body.quarter)
                rec = repo.record_for(conn, a["client_id"], a["appliance"], body.year, body.quarter)
                now = migrate.utc_now()
                if rec is None:
                    if body.expected_row_version is not None:
                        raise NotFound("This appliance has no saved record in this quarter (it may have been reset).")
                    env, pol = _need_target(a)
                    vals = {"id": str(uuid.uuid4()), "client_id": a["client_id"], "server_name": a["appliance"],
                            "environment": env, "polarity": pol, "year": body.year, "quarter": body.quarter,
                            "target_version": prov.get("target_version"), "scheduled_date": prov.get("date_override"),
                            "status": prov.get("status") or "Planned", "notes": prov.get("notes"), "now": now}
                    repo.insert_record(conn, vals)
                    _audit(conn, "server_upgrade", "created", vals["id"], f"{a['appliance']} {D.label(body.year, body.quarter)}",
                           client_id=a["client_id"], new={k: vals[k] for k in ("status", "scheduled_date", "target_version", "notes")})
                else:
                    _check_version(rec, body.expected_row_version)
                    st = prov.get("status")
                    if st is not None and st not in D.STATUSES and st != rec["status"]:
                        raise _fail("status", "must be one of: " + ", ".join(D.STATUSES))
                    ren = {"date_override": "scheduled_date"}
                    ch = {ren.get(k, k): v for k, v in prov.items() if rec[ren.get(k, k)] != v}
                    if ch:
                        new = {**rec, **ch}
                        env, pol, problem = D.record_target(a["environment"], D.polarity_of(a["region"]))
                        if problem:
                            env, pol = rec["environment"], rec["polarity"]     # keep the stored pair; appliance data is incomplete
                        repo.update_record(conn, rec["id"], {"environment": env, "polarity": pol,
                                           "target_version": new["target_version"], "scheduled_date": new["scheduled_date"],
                                           "status": new["status"], "notes": new["notes"]}, now)
                        _audit(conn, "server_upgrade", "updated", rec["id"],
                               f"{a['appliance']} {D.label(body.year, body.quarter)}", client_id=a["client_id"],
                               old={k: rec[k] for k in ch}, new=ch)
                row = _row(conn, a, w, rt.today())
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "appliance") from exc
        return _ok(row)


def appliance_reset(rt: Any, body: ApplianceReset) -> Dict[str, Any]:
    with rt.db() as conn:
        w, a = _context(conn, body.object_id, body.year, body.quarter)
        rec = repo.record_for(conn, a["client_id"], a["appliance"], body.year, body.quarter)
        if rec is None:
            return _ok(_row(conn, a, w, rt.today()))          # already following the quarter
        _check_version(rec, body.expected_row_version)
        if body.confirm is not True:
            raise ConfirmationRequired('Resetting to the quarter needs confirmation. Resend with "confirm": true.',
                                       details={"appliance": a["appliance"]})
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            repo.delete_record(conn, rec["id"])
            _audit(conn, "server_upgrade", "deleted", rec["id"], f"{a['appliance']} {D.label(body.year, body.quarter)}",
                   client_id=a["client_id"], old={k: rec[k] for k in ("status", "scheduled_date", "target_version", "notes")},
                   reason="reset to quarter; safety backup " + backup["name"])
        return _ok(_row(conn, a, w, rt.today()), [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


def set_version(rt: Any, body: SetVersion) -> Dict[str, Any]:
    """D-119: one transaction, one audit event per changed appliance, skipped (with reasons) reported not raised."""
    ids = list(dict.fromkeys(body.object_ids))
    ver = body.target_version
    updated: List[Dict[str, Any]] = []
    unchanged: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    with rt.db() as conn:
        w = repo.quarter(conn, body.year, body.quarter)
        if w is None:
            raise NotFound("Quarter not found. Add it first.")
        found = {a["object_id"]: a for a in repo.appliances(conn, ids)}
        with transaction(conn):
            now = migrate.utc_now()
            for oid in ids:
                a = found.get(oid)
                if a is None:
                    skipped.append({"object_id": oid, "appliance": None, "client_name": None, "code": "not_found",
                                    "reason": "Appliance not found"})
                    continue
                tag = {"object_id": oid, "appliance": a["appliance"], "client_name": a["client_name"]}
                rec = repo.record_for(conn, a["client_id"], a["appliance"], body.year, body.quarter)
                label = f"{a['appliance']} {D.label(body.year, body.quarter)}"
                if rec is not None:
                    if rec["target_version"] == ver:
                        unchanged.append(tag)
                        continue
                    repo.update_record(conn, rec["id"], {k: rec[k] for k in ("environment", "polarity", "scheduled_date", "status", "notes")}
                                       | {"target_version": ver}, now)
                    _audit(conn, "server_upgrade", "updated", rec["id"], label, client_id=a["client_id"],
                           old={"target_version": rec["target_version"]}, new={"target_version": ver}, reason="set version")
                    updated.append(tag)
                    continue
                if ver is None:
                    unchanged.append(tag)      # nothing stored, already follows the quarter
                    continue
                env, pol, problem = D.record_target(a["environment"], D.polarity_of(a["region"]))
                if problem:
                    skipped.append({**tag, "code": problem, "reason": D.REASONS[problem]})
                    continue
                rid = str(uuid.uuid4())
                repo.insert_record(conn, {"id": rid, "client_id": a["client_id"], "server_name": a["appliance"],
                                          "environment": env, "polarity": pol, "year": body.year, "quarter": body.quarter,
                                          "target_version": ver, "scheduled_date": None, "status": "Planned", "notes": None,
                                          "now": now})
                _audit(conn, "server_upgrade", "created", rid, label, client_id=a["client_id"],
                       new={"target_version": ver, "status": "Planned"}, reason="set version")
                updated.append(tag)
    msg = (f"Version {'set' if ver else 'cleared'} on {len(updated)}" + (f"; {len(skipped)} skipped" if skipped else "")
           + ((": " + "; ".join(sorted({s['reason'].lower() for s in skipped}))) if skipped else ""))
    return _ok({"updated": updated, "unchanged": unchanged, "skipped": skipped, "target_version": ver, "message": msg})
