"""Account import orchestration: template, Inspect, plan refresh, Apply, skipped-rows download.
Routes call these functions only (no SQL, no workbook code in app.py)."""
from __future__ import annotations

import datetime as _dt
import logging
import uuid
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import unquote

from .. import constants as C
from ..audit import write_audit
from ..dbkit import migrate, transaction
from ..errors import (AlreadyApplied, Conflict, ConfirmationRequired, ImportExpired, NotFound, PreviewStale,
                      UnresolvedDuplicates, ValidationFailed)
from ..schemas import ImportApply
from . import plan as P
from . import reader, repo, template
from .sessions import Session, SessionStore

log = logging.getLogger("tam.import")

# Test seams (never set in production): called as HOOKS[name](context). Used to inject failures and concurrent edits.
HOOKS: Dict[str, Callable[..., None]] = {}


def _hook(name: str, *a: Any) -> None:
    fn = HOOKS.get(name)
    if fn:
        fn(*a)


def store(rt: Any) -> SessionStore:
    if rt.import_sessions is None:
        rt.import_sessions = SessionStore()
    return rt.import_sessions


def _iso(ts: Optional[_dt.datetime] = None) -> str:
    t = ts or _dt.datetime.now(_dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


# ------------------------------------------------------------------ template


def template_file(fmt: str) -> Dict[str, Any]:
    if fmt not in ("xlsx", "csv"):
        raise ValidationFailed("Request validation failed.", fields={"format": "must be xlsx or csv"})
    data = template.build_template(fmt)
    return {"data": data, "media": template.CSV_MEDIA if fmt == "csv" else template.XLSX_MEDIA,
            "filename": f"tam_accounts_import_template.{fmt}"}


# ------------------------------------------------------------------ Inspect / plan


def _file_block(s: Session) -> Dict[str, Any]:
    p = s.parsed
    return {"name": s.file_name, "size_bytes": p.size_bytes, "format": p.format, "sheet": p.sheet,
            "rows_found": p.rows_found, "encoding": p.encoding, "delimiter": p.delimiter, "notes": p.notes}


def _item(s: Session, plan: P.Plan) -> Dict[str, Any]:
    s.sigs = dict(plan.sigs)
    exp = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=C.IMPORT_SESSION_TTL_SECONDS)
    return {"import_id": s.id, "plan_hash": plan.plan_hash, "expires_at": _iso(exp), "file": _file_block(s),
            "limits": {"max_rows": C.IMPORT_MAX_ROWS, "max_candidates": C.IMPORT_MAX_CANDIDATES,
                       "max_bytes": C.MAX_IMPORT_BYTES},
            "counts": plan.counts, "warnings": s.parsed.warnings, "rows": [r.public() for r in plan.rows]}


def inspect(rt: Any, data: bytes, raw_name: Optional[str]) -> Dict[str, Any]:
    name = reader.display_file_name(unquote(raw_name or ""))
    parsed = reader.read_upload(data, name)
    s = Session(uuid.uuid4().hex, parsed, name, store(rt).now())
    with rt.db() as conn:
        plan = P.build_plan(parsed.rows, repo.load_accounts(conn))
    store(rt).add(s)
    log.info("import inspect: file=%s format=%s size=%d rows=%d counts=%s", name, parsed.format, len(data),
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
    with rt.db() as conn:
        plan = P.build_plan(s.rows, repo.load_accounts(conn))
    return _item(s, plan)


# ------------------------------------------------------------------ Apply

_FIELDS = ("name", "status", "bpid", "products", "next_contact", "notes")


def _rows_text(rows: List[int]) -> str:
    shown = ", ".join(str(r) for r in rows[:40])
    return ("rows " if len(rows) > 1 else "row ") + shown + (f" (+{len(rows) - 40} more)" if len(rows) > 40 else "")


def _stale(plan_sigs: Dict[int, str], new: P.Plan, why: str) -> PreviewStale:
    changed = [{"row": r, "reason": "changed_since_preview"} for r, sg in new.sigs.items() if plan_sigs.get(r) != sg]
    return PreviewStale("The accounts changed since the preview. Review the refreshed plan and try again.",
                        details={"changed": changed[:100], "why": why})


def apply(rt: Any, body: ImportApply) -> Dict[str, Any]:
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
            plan = P.build_plan(s.rows, repo.load_accounts(conn))
            if plan.plan_hash != body.plan_hash:
                raise _stale(s.sigs, plan, "plan_hash")
            by_row = P.validate_decisions(plan, decisions)
            missing = [r.row for r in plan.rows if r.state == "needs_review" and r.row not in by_row]
            if missing:
                raise UnresolvedDuplicates("Every possible duplicate needs a decision before the import can run.",
                                           details={"rows": missing})
            res = P.resolve(plan, by_row)
            dests: List[P.Dest] = res["dests"]
            todo = [d for d in dests if d.is_new or d.changes]
            backup: Optional[Dict[str, Any]] = None
            created: List[Dict[str, Any]] = []
            updated: List[Dict[str, Any]] = []
            audit_n = 0
            if todo:
                backup = rt.backups.create(conn, "pre-import")            # online backup API; failure -> backup_failed
                _hook("after_backup", rt, plan)
                with transaction(conn):
                    touched = [d.account["id"] for d in dests if not d.is_new]
                    now_versions = repo.row_versions(conn, touched)
                    changed = [{"row": d.rows[0], "reason": "account_changed"} for d in dests if not d.is_new
                               and now_versions.get(d.account["id"]) != d.account["row_version"]]
                    if changed:
                        raise PreviewStale("An account changed while the import was being applied. Nothing was written.",
                                           details={"changed": changed, "why": "row_version"})
                    again = P.build_plan(s.rows, repo.load_accounts(conn))
                    if again.plan_hash != plan.plan_hash:
                        raise _stale(plan.sigs, again, "plan_hash_in_transaction")
                    for n, d in enumerate(todo, start=1):
                        reason = f"Bulk import: {s.file_name}, {_rows_text(d.rows)}"[:2000]
                        if d.is_new:
                            cid = str(uuid.uuid4())
                            v = d.values
                            vals = {"id": cid, "name": v["name"], "status": v.get("status") or "Active",
                                    "bpid": v.get("bpid"), "products": v.get("products"),
                                    "next_contact": v.get("next_contact"), "notes": v.get("notes"),
                                    "now": migrate.utc_now()}
                            conn.execute("INSERT INTO clients (id, name, status, bpid, products, next_contact, notes,"
                                         " created_at, updated_at) VALUES (:id, :name, :status, :bpid, :products,"
                                         " :next_contact, :notes, :now, :now)", vals)
                            write_audit(conn, category="crm", client_id=cid, object_type="client", object_id=cid,
                                        label=vals["name"], action="created",
                                        new={k: vals[k] for k in _FIELDS}, reason=reason, source="Bulk Import")
                            created.append({"id": cid, "name": vals["name"], "rows": d.rows})
                        else:
                            from ..services import _apply_update
                            acc = d.account
                            _apply_update(conn, "clients", acc, d.changes,
                                          ("name", "bpid", "products", "status", "next_contact", "notes", "last_contact"))
                            write_audit(conn, category="crm", client_id=acc["id"], object_type="client",
                                        object_id=acc["id"], label=acc["name"], action="updated",
                                        old={k: acc.get(k) for k in d.changes}, new=dict(d.changes),
                                        reason=reason, source="Bulk Import")
                            updated.append({"id": acc["id"], "name": acc["name"], "rows": d.rows,
                                            "filled": sorted(d.changes)})
                        audit_n += 1
                        _hook("after_write", n, d)
        unchanged = [d for d in dests if not d.is_new and not d.changes]
        skipped = res["skipped"]
        sk_invalid = sum(1 for x in skipped if x["kind"] == "invalid")
        result = {
            "import_id": s.id, "applied_at": _iso(), "file": {"name": s.file_name, "rows_found": s.parsed.rows_found,
                                                              "format": s.parsed.format},
            "counts": {"created": len(created), "updated": len(updated), "unchanged": len(unchanged),
                       "skipped": len(skipped), "invalid": sk_invalid, "overwritten": 0},
            "breakdown": {
                "created_new": sum(1 for d in dests if d.is_new and not d.marked_different),
                "created_marked_different": sum(1 for d in dests if d.is_new and d.marked_different),
                "updated_exact": sum(1 for d in dests if not d.is_new and d.changes and d.exact_row),
                "updated_marked_same": sum(1 for d in dests if not d.is_new and d.changes and not d.exact_row),
                "skipped_invalid": sk_invalid, "skipped_by_user": len(skipped) - sk_invalid},
            "fields_filled": sum(len(u["filled"]) for u in updated), "audit_events": audit_n,
            "backup": ({"name": backup["name"], "reason": "pre-import", "size_bytes": backup["size_bytes"]}
                       if backup else None),
            "created": created, "updated": updated,
            "skipped": [{"row": x["row"], "name": x["name"], "kind": x["kind"], "reason": x["reason"]} for x in skipped],
            "skipped_url": (f"/api/import/accounts/{s.id}/skipped.{s.parsed.format}" if skipped else None),
        }
        s.applied, s.applied_at = result, st.now()
        log.info("import applied: file=%s created=%d updated=%d unchanged=%d skipped=%d backup=%s", s.file_name,
                 len(created), len(updated), len(unchanged), len(skipped), result["backup"] and result["backup"]["name"])
        return {"item": result, "side_effects": ([{"type": "backup_created", "file": backup["name"],
                                                   "reason": "pre-import"}] if backup else [])}
    finally:
        st.apply_lock.release()


# ------------------------------------------------------------------ skipped rows


def skipped_file(rt: Any, import_id: str, fmt: str) -> Dict[str, Any]:
    s = _session(rt, import_id)
    if not s.applied:
        raise Conflict("This import has not been applied yet.")
    if fmt != s.parsed.format:
        raise NotFound("The skipped-rows file is available in the same format as the upload "
                       f"(.{s.parsed.format}).", )
    by_row = {r.row: r for r in s.rows}
    # rebuild "Possible duplicate of" from the stored result text
    out: List[List[str]] = []
    for x in s.applied["skipped"]:
        r = by_row[x["row"]]
        src = r.raw if x["kind"] == "invalid" else {k: ("" if v is None else v) for k, v in r.values.items()}
        dup = ""
        if x["reason"].startswith("Skipped by you (possible duplicate of "):
            dup = x["reason"][len("Skipped by you (possible duplicate of "):-1]
        out.append([src.get(f, "") or "" for f in reader.FIELDS] + [str(x["row"]), x["reason"], dup])
    data = template.build_skipped_csv(out) if fmt == "csv" else template.build_skipped_xlsx(out)
    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M")
    return {"data": data, "media": template.CSV_MEDIA if fmt == "csv" else template.XLSX_MEDIA,
            "filename": f"tam_accounts_skipped_{stamp}.{fmt}"}
