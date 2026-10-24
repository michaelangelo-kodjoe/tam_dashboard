"""BAMS import orchestration (T-123..T-125): template, Inspect, plan refresh, Apply, skipped-rows download.
Reuses the Run 3 session store, reader, limits, backup and error vocabulary. Routes call these functions only."""
from __future__ import annotations

import dataclasses
import datetime as _dt
import logging
import uuid
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import unquote

from .. import constants as C
from ..audit import write_audit
from ..dbkit import migrate, transaction
from ..errors import (AlreadyApplied, AppError, Conflict, ConfirmationRequired, ImportExpired, ImportFailed, NotFound,
                      PreviewStale, UnresolvedDuplicates, ValidationFailed)
from ..schemas import BamsImportApply
from . import bams_plan as P
from . import bams_reader, bams_repo, bams_template, template
from . import bams_terminal_adapter as terminal_adapter
from .reader import display_file_name
from .sessions import Session, SessionStore

log = logging.getLogger("tam.import")
HOOKS: Dict[str, Callable[..., None]] = {}          # test seams: after_backup(rt, plan), after_write(n, dest)


def _hook(name: str, *a: Any) -> None:
    fn = HOOKS.get(name)
    if fn:
        fn(*a)


def store(rt: Any) -> SessionStore:
    if getattr(rt, "bams_import_sessions", None) is None:
        rt.bams_import_sessions = SessionStore()
    return rt.bams_import_sessions


def _iso(ts: Optional[_dt.datetime] = None) -> str:
    t = ts or _dt.datetime.now(_dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def template_file(fmt: str) -> Dict[str, Any]:
    if fmt not in ("xlsx", "csv"):
        raise ValidationFailed("Request validation failed.", fields={"format": "must be xlsx or csv"})
    return {"data": bams_template.build_template(fmt), "media": template.CSV_MEDIA if fmt == "csv" else template.XLSX_MEDIA,
            "filename": f"tam_bams_import_template.{fmt}"}


def _plan(rt: Any, s: Session) -> P.BPlan:
    with rt.db() as conn:
        return P.build_plan(s.rows, bams_repo.load_snapshot(conn))


def _item(s: Session, plan: P.BPlan) -> Dict[str, Any]:
    s.sigs = dict(plan.sigs)
    p = s.parsed
    exp = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=C.IMPORT_SESSION_TTL_SECONDS)
    return {"import_id": s.id, "plan_hash": plan.plan_hash, "expires_at": _iso(exp),
            "file": {"name": s.file_name, "size_bytes": p.size_bytes, "format": p.format, "sheet": p.sheet,
                     "rows_found": p.rows_found, "encoding": p.encoding, "delimiter": p.delimiter, "notes": p.notes},
            "limits": {"max_rows": C.IMPORT_MAX_ROWS, "max_candidates": C.IMPORT_MAX_CANDIDATES, "max_bytes": C.MAX_IMPORT_BYTES},
            "counts": plan.counts, "appliances": plan.appliances, "operations_note": ops_note(plan.ops_missing), "metrics": plan.metrics, "warnings": p.warnings,
            "review": plan.review(), "rows": [r.public() for r in plan.rows]}


def ops_note(n: int) -> Dict[str, Any]:
    """D-108: one informational line, never an error."""
    return {"count": n, "text": (f"{n} appliances need East or West set for Operations" if n else None)}


def _read(data: bytes, name: str) -> Any:
    """Read a BAMS upload. A Bloomberg Terminal BAMS export (Client, Ticker, Region, Metric, DC Location)
    is auto-detected and converted in memory to the template schema; any other file is read unchanged."""
    norm = terminal_adapter.normalize_terminal_upload(data, name)
    if norm is None:
        return bams_reader.read_upload(data, name)
    parsed = bams_reader.read_upload(norm.data, "bloomberg_terminal_bams.xlsx")
    note = (f"Bloomberg Terminal BAMS export recognised (sheet \"{norm.source_sheet}\", {norm.rows_adapted} rows converted). "
            "Terminal Region and current values are ignored; Environment and Polarity are left for you to set.")
    return dataclasses.replace(parsed, size_bytes=len(data), notes=list(parsed.notes) + [note])


def inspect(rt: Any, data: bytes, raw_name: Optional[str]) -> Dict[str, Any]:
    name = display_file_name(unquote(raw_name or ""))
    parsed = _read(data, name)
    s = Session(uuid.uuid4().hex, parsed, name, store(rt).now())
    plan = _plan(rt, s)
    store(rt).add(s)
    log.info("bams import inspect: file=%s format=%s size=%d rows=%d counts=%s", name, parsed.format, len(data),
             parsed.rows_found, plan.counts)
    return _item(s, plan)


def _session(rt: Any, import_id: str) -> Session:
    s = store(rt).get(import_id)
    if s is None:
        raise ImportExpired("This import timed out. Choose the file again.")
    return s


def get_plan(rt: Any, import_id: str) -> Dict[str, Any]:
    s = _session(rt, import_id)
    if s.applied:
        raise AlreadyApplied("This import was already applied.", details={"result": s.applied})
    return _item(s, _plan(rt, s))


def _stale(old: Dict[int, str], new: P.BPlan, why: str) -> PreviewStale:
    changed = [{"row": r, "reason": "changed_since_preview"} for r, sg in new.sigs.items() if old.get(r) != sg]
    for r in new.rows:
        if r.state == "invalid" and any(e["code"] == "ticker_conflict" for e in r.errors) and old.get(r.row) != new.sigs.get(r.row):
            why = "ticker_conflict"
    return PreviewStale("The appliances or tickers changed since the preview. Preview again.",
                        details={"changed": changed[:100], "why": why})


def _rows_text(rows: List[int]) -> str:
    return ("rows " if len(rows) > 1 else "row ") + ", ".join(str(r) for r in rows[:40]) + (f" (+{len(rows) - 40} more)" if len(rows) > 40 else "")


def apply(rt: Any, body: BamsImportApply) -> Dict[str, Any]:
    if body.confirm is not True:
        raise ConfirmationRequired('Applying an import needs confirmation. Resend with "confirm": true.')
    s = _session(rt, body.import_id)
    st = store(rt)
    if not st.apply_lock.acquire(blocking=False):
        raise Conflict("Another import is being applied. Try again in a moment.", details={"reason": "apply_in_progress"})
    try:
        if s.applied:
            raise AlreadyApplied("This import was already applied.", details={"result": s.applied})
        decisions = [d.model_dump() for d in body.decisions]
        with rt.db() as conn:
            plan = P.build_plan(s.rows, bams_repo.load_snapshot(conn))
            if plan.plan_hash != body.plan_hash:
                raise _stale(s.sigs, plan, "plan_hash")
            by_key = P.validate_decisions(plan, decisions)
            missing = [g for g in plan.groups if g.flagged and g.valid_rows() and g.key not in by_key]
            if missing:
                raise UnresolvedDuplicates("Every possible duplicate appliance needs a decision before the import can run.",
                                           details={"keys": [g.key for g in missing],
                                                    "rows": sorted(r.row for g in missing for r in g.valid_rows())})
            res = P.resolve(plan, by_key)
            dests: List[P.Dest] = res["dests"]
            todo = [d for d in dests if d.created or (not d.is_new and d.fills)]
            backup: Optional[Dict[str, Any]] = None
            audit_n = {"appliance": 0, "metric": 0}
            created: List[Dict[str, Any]] = []
            updated: List[Dict[str, Any]] = []
            policy_sync = {"created": 0, "adopted": 0, "updated": 0, "disabled": 0, "matched": 0}
            if todo:
                backup = rt.backups.create(conn, "pre-import")
                _hook("after_backup", rt, plan)
                cur_row = [0]
                try:
                    with transaction(conn):
                        again = P.build_plan(s.rows, bams_repo.load_snapshot(conn))
                        if again.plan_hash != plan.plan_hash:
                            raise _stale(plan.sigs, again, "plan_hash_in_transaction")
                        for n, d in enumerate(todo, start=1):
                            cur_row[0] = d.rows[0]
                            _write_dest(conn, s, d, audit_n, created, updated, cur_row)
                            _hook("after_write", n, d)
                        # Persistent metric alert policies must attach immediately to newly
                        # imported metrics, even when the monitor is currently stopped.
                        from ..bams.service import sync_auto_policies
                        policy_sync = sync_auto_policies(conn)
                except AppError:
                    raise
                except Exception as exc:  # noqa: BLE001 - rolled back by the transaction; report plainly
                    log.exception("bams import failed and was rolled back")
                    raise ImportFailed("The import could not be completed and nothing was written.",
                                       details={"rolled_back": True, "row": cur_row[0],
                                                "reason": "A database error stopped the import; no changes were kept.",
                                                "backup": backup["name"]}) from exc
        skipped = res["skipped"]
        inv = sum(1 for x in skipped if x["kind"] == "invalid")
        ex_changed = [d for d in dests if not d.is_new and (d.created or d.fills)]
        unchanged_d = [d for d in dests if not d.is_new and not (d.created or d.fills)]
        upd_rows = sum(len(d.unchanged_rows) for d in ex_changed if d.fills)
        unch_rows = sum(len(d.unchanged_rows) for d in dests) - upd_rows
        touched: Dict[str, str] = {}
        for item in created + updated:
            touched[item["client_id"]] = item["client_name"]
        result = {
            "import_id": s.id, "applied_at": _iso(),
            "file": {"name": s.file_name, "rows_found": s.parsed.rows_found, "format": s.parsed.format},
            "counts": {"appliances_created": len(created), "appliances_updated": len(updated),
                       "appliances_unchanged": len(unchanged_d), "metrics_created": sum(len(d.created) for d in dests),
                       "metrics_updated": upd_rows, "metrics_unchanged": unch_rows, "skipped": len(skipped),
                       "invalid": inv, "overwritten": 0},
            "breakdown": {"created_new": sum(1 for d in dests if d.is_new and not d.marked_different and not d.marked_same),
                          "created_marked_different": sum(1 for d in dests if d.is_new and d.marked_different),
                          "merged_exact": sum(1 for d in ex_changed if d.exact and not d.marked_same),
                          "merged_marked_same": sum(1 for d in dests if d.marked_same and (d.created or d.fills)),
                          "skipped_invalid": inv, "skipped_by_user": len(skipped) - inv},
            "operations_note": ops_note(_ops_after(rt, dests)),
            "decisions": res["decisions"], "fields_filled": sum(len(u["filled"]) for u in updated),
            "audit_events": audit_n["appliance"] + audit_n["metric"], "audit_breakdown": audit_n,
            "backup": ({"name": backup["name"], "reason": "pre-import", "size_bytes": backup["size_bytes"]} if backup else None),
            "touched_accounts": [{"id": k, "name": v} for k, v in sorted(touched.items(), key=lambda kv: kv[1].casefold())],
            "created": created, "updated": updated, "skipped": skipped,
            "policy_sync": policy_sync,
            "skipped_url": (f"/api/import/bams/{s.id}/skipped.{s.parsed.format}" if skipped else None),
        }
        s.applied, s.applied_at = result, st.now()
        log.info("bams import applied: file=%s appliances_created=%d updated=%d metrics_created=%d skipped=%d backup=%s",
                 s.file_name, len(created), len(updated), result["counts"]["metrics_created"], len(skipped),
                 result["backup"] and result["backup"]["name"])
        return {"item": result, "side_effects": ([{"type": "backup_created", "file": backup["name"], "reason": "pre-import"}]
                                                 if backup else [])}
    finally:
        st.apply_lock.release()


def _write_dest(conn: Any, s: Session, d: P.Dest, audit_n: Dict[str, int], created: List[Dict[str, Any]],
                updated: List[Dict[str, Any]], cur_row: List[int]) -> None:
    from ..services import _apply_update
    from ..bams.repo import ticker_owner
    now = migrate.utc_now()
    reason = f"Bulk import: {s.file_name}, {_rows_text(d.rows)}"[:2000]
    if d.is_new:
        oid = str(uuid.uuid4())
        vals = {"id": oid, "c": d.client["id"], "n": d.name, "r": d.pool.get("region"), "l": d.pool.get("location"),
                "e": d.pool.get("environment"), "now": now}
        conn.execute("INSERT INTO bams_objects (id, client_id, name, region, location, environment, enabled, created_at,"
                     " updated_at) VALUES (:id, :c, :n, :r, :l, :e, 1, :now, :now)", vals)
        write_audit(conn, category="bams", client_id=d.client["id"], object_type="bams_object", object_id=oid, label=d.name,
                    action="created", new={"name": d.name, "region": vals["r"], "location": vals["l"], "environment": vals["e"],
                                           "enabled": True, "metrics": len(d.created)}, reason=reason, source="Bulk Import")
        audit_n["appliance"] += 1
        item = {"id": oid, "name": d.name, "client_id": d.client["id"], "client_name": d.client["name"], "rows": d.rows,
                "metrics": [r.values["metric"] for r in d.created]}
        created.append(item)
        obj_name = d.name
    else:
        obj = dict(conn.execute("SELECT * FROM bams_objects WHERE id = :i", {"i": d.obj["id"]}).fetchone())
        oid, obj_name = obj["id"], obj["name"]
        if d.fills:
            _apply_update(conn, "bams_objects", obj, dict(d.fills), ("region", "location", "environment"))
            write_audit(conn, category="bams", client_id=d.client["id"], object_type="bams_object", object_id=oid, label=obj_name,
                        action="updated", old={k: obj[k] for k in d.fills}, new=dict(d.fills), reason=reason, source="Bulk Import")
            audit_n["appliance"] += 1
        updated.append({"id": oid, "name": obj_name, "client_id": d.client["id"], "client_name": d.client["name"],
                        "rows": d.rows, "filled": sorted(d.fills), "metrics_added": [r.values["metric"] for r in d.created]})
    for r in d.created:
        cur_row[0] = r.row
        v = r.values
        if ticker_owner(conn, v["ticker"]) is not None:       # defence in depth; the plan hash already covers this
            raise PreviewStale("A ticker became used while the import was being applied. Nothing was written.",
                               details={"why": "ticker_conflict", "changed": [{"row": r.row, "reason": "ticker_conflict"}]})
        mid = str(uuid.uuid4())
        conn.execute("INSERT INTO bams_metrics (id, object_id, metric_name, ticker, enabled, stale_after_seconds, created_at,"
                     " updated_at) VALUES (:id, :o, :n, :t, :e, :s, :now, :now)",
                     {"id": mid, "o": oid, "n": v["metric"], "t": v["ticker"], "e": 1 if v["enabled"] else 0,
                      "s": v["stale_after_seconds"], "now": now})
        write_audit(conn, category="bams", client_id=d.client["id"], object_type="bams_metric", object_id=mid,
                    label=f"{obj_name} / {v['metric']}", action="created",
                    new={"metric_name": v["metric"], "ticker": v["ticker"], "enabled": bool(v["enabled"]),
                         "stale_after_seconds": v["stale_after_seconds"]},
                    reason=f"Bulk import: {s.file_name}, row {r.row}", source="Bulk Import")
        audit_n["metric"] += 1


def _ops_after(rt: Any, dests: List[P.Dest]) -> int:
    """Count appliances touched by this import that still lack East/West or Environment (read after commit)."""
    with rt.db() as conn:
        return _ops_count(conn, dests)


def _ops_count(conn: Any, dests: List[P.Dest]) -> int:
    n = 0
    for d in dests:
        if not d.rows:
            continue
        row = conn.execute("SELECT region, environment FROM bams_objects WHERE (id = :i) OR (client_id = :c AND name = :n)",
                           {"i": d.obj["id"] if d.obj else "", "c": d.client["id"], "n": d.name}).fetchone()
        if row is not None and bams_reader.needs_ops_fix(row["region"], row["environment"]):
            n += 1
    return n


# ------------------------------------------------------------------ skipped rows
def skipped_file(rt: Any, import_id: str, fmt: str) -> Dict[str, Any]:
    s = _session(rt, import_id)
    if not s.applied:
        raise Conflict("This import has not been applied yet.")
    if fmt != s.parsed.format:
        raise NotFound(f"The skipped-rows file is available in the same format as the upload (.{s.parsed.format}).")
    by_row = {r.row: r for r in s.rows}
    out: List[List[str]] = []
    for x in s.applied["skipped"]:
        r = by_row[x["row"]]
        if x["kind"] == "invalid":
            src = [r.raw.get(f, "") or "" for f in bams_reader.FIELDS]
        else:
            vals = r.values
            src = [("" if vals.get(f) is None else ("Yes" if vals[f] is True else "No" if vals[f] is False else str(vals[f])))
                   for f in bams_reader.FIELDS]
        out.append(src + [str(x["row"]), x["reason"], x.get("duplicate_of", "")])
    headers = bams_reader.HEADERS + template.EXTRA_HEADERS
    data = template.build_skipped_csv(out, headers) if fmt == "csv" else template.build_skipped_xlsx(out, headers, "Import")
    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M")
    return {"data": data, "media": template.CSV_MEDIA if fmt == "csv" else template.XLSX_MEDIA,
            "filename": f"tam_bams_skipped_{stamp}.{fmt}"}
