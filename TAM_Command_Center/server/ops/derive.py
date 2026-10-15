"""Operations read model (D-109..D-115). Pure functions plus one builder; derived on read, nothing is stored.

Quarter-level Target version applies AUTOMATICALLY to every appliance of that quarter: an appliance's own
`server_upgrades.target_version` (set with set-version / appliance save) wins, a blank one follows the quarter.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from . import repo

STATUSES = ("Planned", "Awaiting Client", "Scheduled", "In Progress", "Completed", "Deferred")
ALL_STATUSES = STATUSES + ("Validation Required", "Exception")
CLOSED = ("Completed", "Deferred")


def label(year: int, q: str) -> str:
    return f"{year} {q}"


def polarity_of(region: Optional[str]) -> Optional[str]:
    r = (region or "").strip().casefold()
    return "East" if r == "east" else "West" if r == "west" else None


def record_target(env: Optional[str], pol: Optional[str]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """-> (environment, record polarity, problem_code). A record needs DEV, or PROD with East/West (table CHECK)."""
    if env == "DEV":
        return "DEV", "DEV", None
    if env == "PROD":
        return ("PROD", pol, None) if pol else ("PROD", None, "needs_polarity")
    return None, None, "needs_environment"


REASONS = {"needs_polarity": "Set East or West first", "needs_environment": "Set Environment (PROD or DEV) first"}


def derived_date(env: Optional[str], pol: Optional[str], w: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """-> (date, reason when not set). The three cases of D-111 plus the specific 'Not set' reasons."""
    lab = label(w["schedule_year"], w["schedule_quarter"])
    if env is None:
        return None, "Set Environment (PROD or DEV)"
    if env == "DEV":
        d = w["dev_upgrade_date"]
        return (d, None) if d else (None, f"No DEV date in {lab}")
    if pol is None:
        return None, "Set East or West"
    d = w["east_prod_date"] if pol == "East" else w["west_prod_date"]
    return (d, None) if d else (None, f"No PROD {pol} date in {lab}")


def default_quarter(quarters: List[Dict[str, Any]], today: str) -> Optional[Dict[str, Any]]:
    """D-114: the quarter holding the earliest date on or after today, else the latest quarter."""
    best: Optional[Tuple[str, Dict[str, Any]]] = None
    for w in quarters:
        ds = [d for d in (w["dev_upgrade_date"], w["east_prod_date"], w["west_prod_date"]) if d and d >= today]
        if ds and (best is None or min(ds) < best[0]):
            best = (min(ds), w)
    if best:
        return best[1]
    return quarters[-1] if quarters else None


def quarter_item(w: Dict[str, Any]) -> Dict[str, Any]:
    return {"year": w["schedule_year"], "quarter": w["schedule_quarter"], "label": label(w["schedule_year"], w["schedule_quarter"]),
            "target_version": w["apics_version"], "dev_date": w["dev_upgrade_date"], "east_prod_date": w["east_prod_date"],
            "west_prod_date": w["west_prod_date"], "row_version": w["row_version"], "records": w.get("records")}


def build_row(a: Dict[str, Any], rec: Optional[Dict[str, Any]], w: Dict[str, Any], today: str) -> Dict[str, Any]:
    env, pol = a["environment"], polarity_of(a["region"])
    derived, reason = derived_date(env, pol, w)
    override = rec["scheduled_date"] if rec else None
    eff = override or derived
    status = rec["status"] if rec else "Planned"
    own = rec["target_version"] if rec else None
    ver = own or w["apics_version"]
    _e, _p, problem = record_target(env, pol)
    return {
        "object_id": a["object_id"], "client_id": a["client_id"], "client_name": a["client_name"], "appliance": a["appliance"],
        "enabled": bool(a["enabled"]), "environment": env, "polarity": pol, "region": a["region"],
        "object_row_version": a["object_row_version"],
        "record_id": rec["id"] if rec else None, "record_row_version": rec["row_version"] if rec else None,
        "status": status, "status_is_default": rec is None,
        "overdue": bool(eff and eff < today and status not in CLOSED),
        "date": {"effective": eff, "source": "override" if override else "quarter" if derived else "none",
                 "override": override, "derived": derived, "reason": None if eff else reason},
        "version": {"effective": ver, "source": "appliance" if own else "quarter" if ver else "none",
                    "own": own, "quarter_default": w["apics_version"]},
        "notes": rec["notes"] if rec else None,
        "can_record": problem is None, "record_problem": REASONS.get(problem) if problem else None,
    }


def _summary(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by: Dict[str, int] = {s: 0 for s in STATUSES}
    for r in rows:
        by[r["status"]] = by.get(r["status"], 0) + 1
    return {"total": len(rows), "by_status": by, "overdue": sum(1 for r in rows if r["overdue"])}


def _keep(r: Dict[str, Any], f: Dict[str, Any]) -> bool:
    if f.get("client_id") and r["client_id"] != f["client_id"]:
        return False
    if f.get("status") and r["status"] != f["status"]:
        return False
    if f.get("environment") and (r["environment"] or "unset") != f["environment"]:
        return False
    if f.get("polarity") and (r["polarity"] or "unset") != f["polarity"]:
        return False
    q = (f.get("q") or "").casefold()
    if q and q not in r["client_name"].casefold() and q not in r["appliance"].casefold():
        return False
    return True


def _row_key(r: Dict[str, Any]) -> Tuple[Any, ...]:
    d = r["date"]["effective"]
    return (d is None, d or "", r["appliance"].casefold())


def build(conn: sqlite3.Connection, today: str, year: Optional[int], q: Optional[str], f: Dict[str, Any]) -> Dict[str, Any]:
    qs = repo.quarters(conn)
    sel = next((w for w in qs if w["schedule_year"] == year and w["schedule_quarter"] == q), None) if year else None
    is_default = False
    if sel is None:
        sel, is_default = default_quarter(qs, today), True
    apps = repo.appliances(conn)
    out: Dict[str, Any] = {"today": today, "quarters": [quarter_item(w) for w in qs],
                           "selected": None, "default_selected": is_default and sel is not None,
                           "appliance_total": len(apps), "empty": None, "summary": _summary([]), "groups": []}
    if not qs:
        out["empty"] = "no_quarters"
        return out
    if not apps:
        out["empty"] = "no_appliances"
    out["selected"] = quarter_item(sel)  # type: ignore[arg-type]
    recs = {(r["client_id"], r["server_name"].casefold()): r for r in repo.records(conn, sel["schedule_year"], sel["schedule_quarter"])}  # type: ignore[index]
    rows = [build_row(a, recs.get((a["client_id"], a["appliance"].casefold())), sel, today) for a in apps]  # type: ignore[arg-type]
    rows = [r for r in rows if _keep(r, f)]
    groups: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        g = groups.setdefault(r["client_id"], {"client_id": r["client_id"], "client_name": r["client_name"], "rows": []})
        g["rows"].append(r)
    glist = sorted(groups.values(), key=lambda g: g["client_name"].casefold())
    for g in glist:
        g["rows"].sort(key=_row_key)
        g["count"] = len(g["rows"])
        g["summary"] = _summary(g["rows"])
    out["groups"], out["summary"] = glist, _summary(rows)
    return out
