"""Business rules and writes. Every write = data change + audit row(s) in ONE transaction.

Contracts honoured here
* explicit `row_version = row_version + 1` on every UPDATE (never rely on the auto-bump + RETURNING)
* `expected_row_version` mismatch -> 409 stale_write (404 if the row is gone)
* no REPLACE in any spelling (plain INSERT / UPDATE / DELETE / ON CONFLICT DO UPDATE only)
* safety backup (online backup API) BEFORE any delete; backup failure aborts the delete
"""
from __future__ import annotations

import datetime as _dt
import sqlite3
import uuid
from typing import Any, Dict, List, Optional

from . import constants as C
from . import reads
from .audit import write_audit
from .dbkit import migrate, one, open_db, transaction
from .errors import (AppError, Conflict, ConfirmationRequired, NotFound, PossibleDuplicate, StaleWrite,
                     ValidationFailed)
from .similar import find_similar
from .runtime import Runtime
from .schemas import (ClientDelete, ClientSave, ContactSave, DeleteBody, NoteSave, SettingsSave, TaskArchive,
                      TaskSave)
from . import logsetup

Result = Dict[str, Any]


def _ok(item: Any, side_effects: Optional[List[Dict[str, Any]]] = None) -> Result:
    return {"ok": True, "item": item, "side_effects": side_effects or []}


def _fail(field: str, msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={field: msg})


def _check_version(row: Dict[str, Any], expected: Optional[int]) -> None:
    if expected is not None and row["row_version"] != expected:
        raise StaleWrite("This record was changed since you loaded it. Reload and try again.",
                         details={"current_row_version": row["row_version"]})


def _apply_update(conn: sqlite3.Connection, table: str, row: Dict[str, Any], changes: Dict[str, Any],
                  allowed: tuple) -> None:
    """UPDATE one row by id, guarded by its current row_version, bumping row_version explicitly."""
    assert set(changes) <= set(allowed), "unexpected column"
    sets = ", ".join(f"{c} = :{c}" for c in changes)
    params = dict(changes)
    params.update(_id=row["id"], _v=row["row_version"], _now=migrate.utc_now())
    cur = conn.execute(f"UPDATE {table} SET {sets}, updated_at = :_now, row_version = row_version + 1"  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
                       f" WHERE id = :_id AND row_version = :_v", params)
    if cur.rowcount != 1:  # cannot happen inside BEGIN IMMEDIATE; defensive
        raise StaleWrite("This record was changed since you loaded it. Reload and try again.")


def _diff(old: Dict[str, Any], provided: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in provided.items() if old.get(k) != v}


def _old_new(old: Dict[str, Any], changes: Dict[str, Any]) -> tuple:
    return {k: old.get(k) for k in changes}, dict(changes)


def _unique_violation(exc: sqlite3.IntegrityError, field: str = "name") -> Optional[Conflict]:
    msg = str(exc)
    if msg.startswith("UNIQUE constraint failed"):
        if "one primary contact" in msg:
            return Conflict("This account already has a primary contact.", fields={"is_primary": "already has a primary"})
        return Conflict("A record with this value already exists.", fields={field: "already exists"})
    return None


def _map_integrity(exc: sqlite3.IntegrityError, field: str = "name") -> AppError:
    c = _unique_violation(exc, field)
    if c:
        return c
    msg = str(exc)
    if msg.startswith("CHECK constraint failed") or msg.startswith("NOT NULL constraint failed"):
        return ValidationFailed("A value was rejected by a database constraint.", details={"constraint": msg[:200]})
    if msg.startswith("FOREIGN KEY constraint failed"):
        return ValidationFailed("A referenced record does not exist.")
    raise exc


# ===================================================================== settings


def save_settings(rt: Runtime, body: SettingsSave) -> Result:
    incoming = body.settings
    errors: Dict[str, str] = {}
    norm: Dict[str, str] = {}
    for k, v in incoming.items():
        if k not in C.SETTING_DEFAULTS:
            errors[k] = "unknown setting"
        elif k == "open_browser_on_start":
            if not isinstance(v, bool):
                errors[k] = "must be true or false"
            else:
                norm[k] = "1" if v else "0"
        elif not isinstance(v, str) or v not in C.SETTING_ENUMS[k]:
            errors[k] = "must be one of: " + ", ".join(C.SETTING_ENUMS[k])
        else:
            norm[k] = v
    if errors:
        raise ValidationFailed("Request validation failed.", fields=errors)
    with rt.db() as conn:
        cur = reads.read_settings(conn)
        changed = {k: v for k, v in norm.items() if cur[k] != v}
        if not changed:
            return _ok(reads.public_settings(cur), [{"type": "no_change"}])
        with transaction(conn):
            for k, v in changed.items():
                conn.execute("INSERT INTO app_meta (key, value) VALUES (:k, :v)"
                             " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                             {"k": f"setting.{k}", "v": v})
                write_audit(conn, category="settings", object_type="setting", action="updated", object_id=k,
                            label=k, old={"value": cur[k]}, new={"value": v})
        new = reads.read_settings(conn)
    if "log_level" in changed:
        logsetup.set_level(changed["log_level"])
    return _ok(reads.public_settings(new))


# ===================================================================== clients

_CLIENT_COLS = ("name", "bpid", "products", "status", "next_contact", "notes", "last_contact")


def _name_conflict(conn: sqlite3.Connection, name: str, exclude_id: Optional[str]) -> None:
    folded = name.casefold()
    for r in conn.execute("SELECT id, name FROM clients"):
        if r["id"] != exclude_id and r["name"].casefold() == folded:
            raise Conflict("An account with this name already exists.", fields={"name": "already exists"})


def save_client(rt: Runtime, body: ClientSave) -> Result:
    prov = body.provided("id", "expected_row_version", "duplicates_confirmed")
    today = rt.today()
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    if not prov.get("name"):
                        raise _fail("name", "is required")
                    for k in ("status",):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    name = prov["name"]
                    _name_conflict(conn, name, None)
                    sim = find_similar(conn, name, prov.get("bpid"))
                    if sim["exact"] is not None:        # exact twin (case/spacing): same account, never a second one
                        raise Conflict("An account with this name already exists.", fields={"name": "already exists"})
                    if sim["candidates"] and body.duplicates_confirmed is not True:
                        raise PossibleDuplicate("This looks like an account that already exists. Review the matches "
                                                "or confirm that it is a different account.",
                                                details={"exact": None, "candidates": sim["candidates"]})
                    cid = str(uuid.uuid4())
                    now = migrate.utc_now()
                    vals = {"id": cid, "name": name, "status": prov.get("status") or "Active",
                            "bpid": prov.get("bpid"), "products": prov.get("products"),
                            "next_contact": prov.get("next_contact"), "notes": prov.get("notes"), "now": now}
                    conn.execute("INSERT INTO clients (id, name, status, bpid, products, next_contact, notes,"
                                 " created_at, updated_at) VALUES (:id, :name, :status, :bpid, :products,"
                                 " :next_contact, :notes, :now, :now)", vals)
                    write_audit(conn, category="crm", client_id=cid, object_type="client", object_id=cid,
                                label=name, action="created",
                                new={k: vals[k] for k in ("name", "status", "bpid", "products", "next_contact", "notes")})
                    side: List[Dict[str, Any]] = []
                else:
                    row = reads.require_client(conn, body.id)
                    _check_version(row, body.expected_row_version)
                    for k in ("name", "status"):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    changes = _diff(row, prov)
                    if "name" in changes:
                        _name_conflict(conn, changes["name"], row["id"])
                    if not changes:
                        return _ok(reads.get_account(conn, row["id"], today), [{"type": "no_change"}])
                    _apply_update(conn, "clients", row, changes, _CLIENT_COLS)
                    label = changes.get("name", row["name"])
                    special = {"next_contact": "next_contact_changed", "status": "status_changed"}
                    generic = {k: v for k, v in changes.items() if k not in special}
                    if generic:
                        o, n = _old_new(row, generic)
                        write_audit(conn, category="crm", client_id=row["id"], object_type="client",
                                    object_id=row["id"], label=label, action="updated", old=o, new=n)
                    for col, action in special.items():
                        if col in changes:
                            o, n = _old_new(row, {col: changes[col]})
                            write_audit(conn, category="crm", client_id=row["id"], object_type="client",
                                        object_id=row["id"], label=label, action=action, old=o, new=n)
                    cid = row["id"]
                    side = []
                item = reads.get_account(conn, cid, today)
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "name") from exc
    return _ok(item, side)


def check_similar(rt: Runtime, body: Any) -> Result:
    with rt.db() as conn:
        return _ok(find_similar(conn, body.name, body.bpid))


def _require_confirm(confirm: bool, what: str) -> None:
    if confirm is not True:
        raise ConfirmationRequired(f"Deleting {what} needs confirmation. Resend with \"confirm\": true.")


def delete_client(rt: Runtime, body: ClientDelete) -> Result:
    _require_confirm(body.confirm, "an account")
    with rt.db() as conn:
        row = reads.require_client(conn, body.id)
        _check_version(row, body.expected_row_version)
        if body.confirm_name is None or body.confirm_name != row["name"]:
            raise ConfirmationRequired("Type the exact account name in \"confirm_name\" to delete it.",
                                       fields={"confirm_name": "does not match the account name"})
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            counts = {t: conn.execute(f"SELECT count(*) FROM {t} WHERE client_id = :c", {"c": row["id"]}).fetchone()[0]  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
                      for t in ("contacts", "tasks", "notes", "server_upgrades", "bams_objects")}
            cur = conn.execute("DELETE FROM clients WHERE id = :id", {"id": row["id"]})
            if cur.rowcount != 1:
                raise NotFound("Account not found.")
            write_audit(conn, category="crm", client_id=row["id"], object_type="client", object_id=row["id"],
                        label=row["name"], action="deleted", old={**reads.client_row(row), "deleted_children": counts},
                        reason="safety backup " + backup["name"])
    return _ok({"id": row["id"], "name": row["name"]}, [{"type": "backup_created", "file": backup["name"],
                                                         "reason": "pre-delete"}])


# ===================================================================== contacts

_CONTACT_COLS = ("name", "role", "email", "team", "is_primary")


def save_contact(rt: Runtime, body: ContactSave) -> Result:
    prov = body.provided("id", "expected_row_version", "client_id")
    side: List[Dict[str, Any]] = []
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    if not body.client_id:
                        raise _fail("client_id", "is required")
                    if not prov.get("name"):
                        raise _fail("name", "is required")
                    client = reads.get_client_raw(conn, body.client_id)
                    if client is None:
                        raise _fail("client_id", "unknown account")
                    cid = str(uuid.uuid4())
                    want_primary = bool(prov.get("is_primary"))
                    displaced = _displace_primary(conn, client["id"], None) if want_primary else None
                    now = migrate.utc_now()
                    conn.execute("INSERT INTO contacts (id, client_id, name, role, email, team, is_primary,"
                                 " created_at, updated_at) VALUES (:id, :client_id, :name, :role, :email, :team,"
                                 " :is_primary, :now, :now)",
                                 {"id": cid, "client_id": client["id"], "name": prov["name"],
                                  "role": prov.get("role"), "email": prov.get("email"), "team": prov.get("team"),
                                  "is_primary": 1 if want_primary else 0, "now": now})
                    write_audit(conn, category="crm", client_id=client["id"], object_type="contact", object_id=cid,
                                label=prov["name"], action="created",
                                new={"name": prov["name"], "role": prov.get("role"), "email": prov.get("email"),
                                     "team": prov.get("team"), "is_primary": want_primary})
                    if want_primary and displaced:
                        write_audit(conn, category="crm", client_id=client["id"], object_type="contact",
                                    object_id=cid, label=prov["name"], action="primary_changed",
                                    old={"primary_contact": displaced["name"]},
                                    new={"primary_contact": prov["name"]})
                        side.append({"type": "primary_cleared", "contact_id": displaced["id"],
                                     "name": displaced["name"]})
                else:
                    row = reads.get_contact_raw(conn, body.id)
                    if row is None:
                        raise NotFound("Contact not found.")
                    if body.client_id is not None and body.client_id != row["client_id"]:
                        raise _fail("client_id", "cannot be changed")
                    _check_version(row, body.expected_row_version)
                    for k in ("name", "is_primary"):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    if "is_primary" in prov:
                        prov["is_primary"] = 1 if prov["is_primary"] else 0
                    changes = _diff(row, prov)
                    if not changes:
                        return _ok(reads.contact_row(row), [{"type": "no_change"}])
                    cid = row["id"]
                    primary_change = changes.pop("is_primary", None)
                    displaced = None
                    if primary_change == 1:
                        displaced = _displace_primary(conn, row["client_id"], row["id"])
                    cur = dict(row)
                    if primary_change is not None:
                        changes["is_primary"] = primary_change
                    _apply_update(conn, "contacts", row, changes, _CONTACT_COLS)
                    label = changes.get("name", row["name"])
                    field_changes = {k: v for k, v in changes.items() if k != "is_primary"}
                    if field_changes:
                        o, n = _old_new(cur, field_changes)
                        write_audit(conn, category="crm", client_id=row["client_id"], object_type="contact",
                                    object_id=cid, label=label, action="updated", old=o, new=n)
                    if primary_change is not None:
                        if primary_change == 1:
                            o, n = {"primary_contact": displaced["name"] if displaced else None}, {"primary_contact": label}
                            if displaced:
                                side.append({"type": "primary_cleared", "contact_id": displaced["id"],
                                             "name": displaced["name"]})
                        else:
                            o, n = {"primary_contact": row["name"]}, {"primary_contact": None}
                        write_audit(conn, category="crm", client_id=row["client_id"], object_type="contact",
                                    object_id=cid, label=label, action="primary_changed", old=o, new=n)
                item = reads.contact_row(reads.get_contact_raw(conn, cid))
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "email") from exc
    return _ok(item, side)


def _displace_primary(conn: sqlite3.Connection, client_id: str, keep_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """Clear the current primary (if any, other than keep_id) in the caller's transaction."""
    old = one(conn, "SELECT id, name FROM contacts WHERE client_id = :c AND is_primary = 1"
                    " AND (:keep IS NULL OR id <> :keep)", {"c": client_id, "keep": keep_id})
    if old:
        conn.execute("UPDATE contacts SET is_primary = 0, updated_at = :now, row_version = row_version + 1"
                     " WHERE id = :id", {"id": old["id"], "now": migrate.utc_now()})
    return old


def delete_contact(rt: Runtime, body: DeleteBody) -> Result:
    _require_confirm(body.confirm, "a contact")
    with rt.db() as conn:
        row = reads.get_contact_raw(conn, body.id)
        if row is None:
            raise NotFound("Contact not found.")
        _check_version(row, body.expected_row_version)
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            if conn.execute("DELETE FROM contacts WHERE id = :id", {"id": row["id"]}).rowcount != 1:
                raise NotFound("Contact not found.")
            write_audit(conn, category="crm", client_id=row["client_id"], object_type="contact", object_id=row["id"],
                        label=row["name"], action="deleted", old=reads.contact_row(row),
                        reason="safety backup " + backup["name"])
    return _ok({"id": row["id"]}, [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


# ===================================================================== tasks

_TASK_COLS = ("task", "client_id", "category", "priority", "due", "next_update", "status", "waiting", "notes",
              "archived")


def _task_client_check(conn: sqlite3.Connection, client_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if client_id is None:
        return None
    c = reads.get_client_raw(conn, client_id)
    if c is None:
        raise _fail("client_id", "unknown account")
    return c


def _task_action(old_status: Optional[str], new_status: Optional[str], created: bool) -> str:
    if created:
        return "created"
    if new_status is not None and new_status != old_status:
        if new_status == "Complete":
            return "completed"
        if old_status == "Complete":
            return "reopened"
    return "updated"


def _d07(conn: sqlite3.Connection, client_id: Optional[str], category: str, due: Optional[str],
         title: str, side: List[Dict[str, Any]]) -> None:
    """D-07: a Client Follow-Up task due earlier than next_contact (or with none set) moves next_contact."""
    if not client_id or not due or category != "Client Follow-Up":
        return
    client = reads.get_client_raw(conn, client_id)
    if client is None:
        return
    cur = client["next_contact"]
    if cur is None or due < cur:
        _apply_update(conn, "clients", client, {"next_contact": due}, _CLIENT_COLS)
        write_audit(conn, category="crm", client_id=client_id, object_type="client", object_id=client_id,
                    label=client["name"], action="next_contact_changed", old={"next_contact": cur},
                    new={"next_contact": due}, reason=f"D-07: Client Follow-Up task '{title}' due {due}",
                    source="System")
        side.append({"type": "next_contact_updated", "client_id": client_id, "old": cur, "new": due})


def save_task(rt: Runtime, body: TaskSave) -> Result:
    prov = body.provided("id", "expected_row_version", "update_next_contact")
    side: List[Dict[str, Any]] = []
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    if not prov.get("task"):
                        raise _fail("task", "is required")
                    for k in ("category", "priority", "status"):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    _task_client_check(conn, prov.get("client_id"))
                    tid = str(uuid.uuid4())
                    now = migrate.utc_now()
                    vals = {"id": tid, "task": prov["task"], "client_id": prov.get("client_id"),
                            "category": prov.get("category") or "Other", "priority": prov.get("priority") or "Medium",
                            "status": prov.get("status") or "Not Started", "due": prov.get("due"),
                            "next_update": prov.get("next_update"), "waiting": prov.get("waiting"),
                            "notes": prov.get("notes"), "now": now}
                    conn.execute("INSERT INTO tasks (id, task, client_id, category, priority, due, next_update,"
                                 " status, waiting, notes, created_at, updated_at) VALUES (:id, :task, :client_id,"
                                 " :category, :priority, :due, :next_update, :status, :waiting, :notes, :now, :now)",
                                 vals)
                    action = "completed" if vals["status"] == "Complete" else "created"
                    write_audit(conn, category="crm", client_id=vals["client_id"], object_type="task", object_id=tid,
                                label=vals["task"], action="created",
                                new={k: vals[k] for k in ("task", "client_id", "category", "priority", "status",
                                                          "due", "next_update", "waiting")})
                    if action == "completed":
                        write_audit(conn, category="crm", client_id=vals["client_id"], object_type="task",
                                    object_id=tid, label=vals["task"], action="completed",
                                    old={"status": None}, new={"status": "Complete"})
                    if body.update_next_contact:
                        _d07(conn, vals["client_id"], vals["category"], vals["due"], vals["task"], side)
                else:
                    row = reads.get_task_raw(conn, body.id)
                    if row is None:
                        raise NotFound("Task not found.")
                    _check_version(row, body.expected_row_version)
                    for k in ("task", "category", "priority", "status"):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    if "client_id" in prov:
                        _task_client_check(conn, prov["client_id"])
                    changes = _diff(row, prov)
                    tid = row["id"]
                    if not changes:
                        if body.update_next_contact:
                            _d07(conn, row["client_id"], row["category"], row["due"], row["task"], side)
                        if side:
                            return _ok(reads.task_row(reads.get_task_raw(conn, tid)), side)
                        return _ok(reads.task_row(row), [{"type": "no_change"}])
                    _apply_update(conn, "tasks", row, changes, _TASK_COLS)
                    new_row = {**row, **changes}
                    o, n = _old_new(row, changes)
                    write_audit(conn, category="crm", client_id=new_row["client_id"], object_type="task",
                                object_id=tid, label=new_row["task"],
                                action=_task_action(row["status"], changes.get("status"), False), old=o, new=n)
                    if body.update_next_contact:
                        _d07(conn, new_row["client_id"], new_row["category"], new_row["due"], new_row["task"], side)
                item = reads.task_row(reads.get_task_raw(conn, tid))
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "task") from exc
    return _ok(item, side)


def archive_task(rt: Runtime, body: TaskArchive) -> Result:
    with rt.db() as conn:
        with transaction(conn):
            row = reads.get_task_raw(conn, body.id)
            if row is None:
                raise NotFound("Task not found.")
            _check_version(row, body.expected_row_version)
            want = 1 if body.archived else 0
            if int(row["archived"]) == want:
                return _ok(reads.task_row(row), [{"type": "no_change"}])
            _apply_update(conn, "tasks", row, {"archived": want}, _TASK_COLS)
            write_audit(conn, category="crm", client_id=row["client_id"], object_type="task", object_id=row["id"],
                        label=row["task"], action="archived" if want else "unarchived",
                        old={"archived": bool(row["archived"])}, new={"archived": bool(want)})
            item = reads.task_row(reads.get_task_raw(conn, row["id"]))
    return _ok(item)


def delete_task(rt: Runtime, body: DeleteBody) -> Result:
    _require_confirm(body.confirm, "a task")
    with rt.db() as conn:
        row = reads.get_task_raw(conn, body.id)
        if row is None:
            raise NotFound("Task not found.")
        _check_version(row, body.expected_row_version)
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            if conn.execute("DELETE FROM tasks WHERE id = :id", {"id": row["id"]}).rowcount != 1:
                raise NotFound("Task not found.")
            write_audit(conn, category="crm", client_id=row["client_id"], object_type="task", object_id=row["id"],
                        label=row["task"], action="deleted", old=reads.task_row(row),
                        reason="safety backup " + backup["name"])
    return _ok({"id": row["id"]}, [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


# ===================================================================== notes

_NOTE_COLS = ("note_type", "timestamp", "subject", "body", "action_items")


def _local_date(instant: str) -> str:
    t = _dt.datetime.strptime(instant, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=_dt.timezone.utc)
    return t.astimezone().date().isoformat()


def _note_label(subject: Optional[str], body: Optional[str]) -> str:
    if subject:
        return subject
    return (body or "").strip().splitlines()[0][:80] if body else "(untitled note)"


def save_note(rt: Runtime, body: NoteSave) -> Result:
    prov = body.provided("id", "expected_row_version", "client_id")
    side: List[Dict[str, Any]] = []
    with rt.db() as conn:
        try:
            with transaction(conn):
                if body.id is None:
                    if not body.client_id:
                        raise _fail("client_id", "is required")
                    if not prov.get("note_type"):
                        raise _fail("note_type", "is required")
                    client = reads.get_client_raw(conn, body.client_id)
                    if client is None:
                        raise _fail("client_id", "unknown account")
                    if not (prov.get("subject") or prov.get("body")):
                        raise _fail("subject", "a subject or a body is required")
                    nid = str(uuid.uuid4())
                    now = migrate.utc_now()
                    vals = {"id": nid, "client_id": client["id"], "note_type": prov["note_type"],
                            "timestamp": prov.get("timestamp") or now, "subject": prov.get("subject"),
                            "body": prov.get("body"), "action_items": prov.get("action_items"), "now": now}
                    conn.execute("INSERT INTO notes (id, client_id, note_type, timestamp, subject, body,"
                                 " action_items, source, created_at, updated_at) VALUES (:id, :client_id,"
                                 " :note_type, :timestamp, :subject, :body, :action_items, 'GUI', :now, :now)", vals)
                    label = _note_label(vals["subject"], vals["body"])
                    write_audit(conn, category="crm", client_id=client["id"], object_type="note", object_id=nid,
                                label=label, action="created",
                                new={k: vals[k] for k in ("note_type", "timestamp", "subject", "action_items")})
                    _d08(conn, client, vals["note_type"], vals["timestamp"], side)
                else:
                    row = reads.get_note_raw(conn, body.id)
                    if row is None:
                        raise NotFound("Note not found.")
                    if body.client_id is not None and body.client_id != row["client_id"]:
                        raise _fail("client_id", "cannot be changed")
                    _check_version(row, body.expected_row_version)
                    for k in ("note_type", "timestamp"):
                        if k in prov and prov[k] is None:
                            raise _fail(k, "cannot be null")
                    changes = _diff(row, prov)
                    nid = row["id"]
                    if not changes:
                        return _ok(reads.note_row(row), [{"type": "no_change"}])
                    merged = {**row, **changes}
                    if not (merged["subject"] or merged["body"]):
                        raise _fail("subject", "a subject or a body is required")
                    _apply_update(conn, "notes", row, changes, _NOTE_COLS)
                    o, n = _old_new(row, {k: v for k, v in changes.items() if k != "body"})
                    if "body" in changes:
                        o["body_changed"], n["body_changed"] = False, True
                    write_audit(conn, category="crm", client_id=row["client_id"], object_type="note", object_id=nid,
                                label=_note_label(merged["subject"], merged["body"]), action="updated", old=o, new=n)
                    client = reads.require_client(conn, row["client_id"])
                    _d08(conn, client, merged["note_type"], merged["timestamp"], side)
                item = reads.note_row(reads.get_note_raw(conn, nid))
        except sqlite3.IntegrityError as exc:
            raise _map_integrity(exc, "subject") from exc
    return _ok(item, side)


def _d08(conn: sqlite3.Connection, client: Dict[str, Any], note_type: str, instant: str,
         side: List[Dict[str, Any]]) -> None:
    """D-08: a Meeting/Call note dated later than last_contact moves last_contact (audited, System)."""
    if note_type not in ("Meeting Note", "Call Note"):
        return
    day = _local_date(instant)
    fresh = reads.get_client_raw(conn, client["id"])
    cur = fresh["last_contact"]
    if cur is None or day > cur:
        _apply_update(conn, "clients", fresh, {"last_contact": day}, _CLIENT_COLS)
        write_audit(conn, category="crm", client_id=client["id"], object_type="client", object_id=client["id"],
                    label=client["name"], action="last_contact_changed", old={"last_contact": cur},
                    new={"last_contact": day}, reason=f"D-08: {note_type} dated {day}", source="System")
        side.append({"type": "last_contact_updated", "client_id": client["id"], "old": cur, "new": day})


def delete_note(rt: Runtime, body: DeleteBody) -> Result:
    _require_confirm(body.confirm, "a note")
    with rt.db() as conn:
        row = reads.get_note_raw(conn, body.id)
        if row is None:
            raise NotFound("Note not found.")
        _check_version(row, body.expected_row_version)
        backup = rt.backups.create(conn, "pre-delete")
        with transaction(conn):
            if conn.execute("DELETE FROM notes WHERE id = :id", {"id": row["id"]}).rowcount != 1:
                raise NotFound("Note not found.")
            write_audit(conn, category="crm", client_id=row["client_id"], object_type="note", object_id=row["id"],
                        label=_note_label(row["subject"], row["body"]), action="deleted", old=reads.note_row(row),
                        reason="safety backup " + backup["name"])
    return _ok({"id": row["id"]}, [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])


# ===================================================================== backups / dev


def manual_backup(rt: Runtime) -> Result:
    with rt.db() as conn:
        info = rt.backups.create(conn, C.MANUAL_BACKUP_REASON)
        with transaction(conn):
            write_audit(conn, category="data", object_type="backup", object_id=info["name"], label=info["name"],
                        action="created", new={"reason": "manual", "size_bytes": info["size_bytes"]})
    return _ok(info)


def dev_reseed(rt: Runtime, confirm: bool) -> Result:
    if rt.config.mode != "DEV":  # defence in depth: the route is not even registered in PROD
        raise NotFound("Not found.")
    _require_confirm(confirm, "the DEV database (reseed)")
    import json
    import seed_mock
    with rt.db() as conn:
        backup = rt.backups.create(conn, "pre-delete")
    conn = open_db(rt.config.db_path, channel=rt.config.channel, rows=False)  # plain tuples for the seed loader
    try:
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        try:
            counts = seed_mock.load(conn, data, rt.clock(), reset=True)
        except (seed_mock.SeedRefused, migrate.MigrationError) as exc:
            raise ValidationFailed(f"Reseed refused: {exc}") from exc
        conn.execute("BEGIN IMMEDIATE")
        try:
            write_audit(conn, category="system", object_type="schema", object_id="mock", label="DEV reseed",
                        action="reseeded", new={"counts": counts}, reason="safety backup " + backup["name"],
                        source="System")
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return _ok({"counts": counts}, [{"type": "backup_created", "file": backup["name"], "reason": "pre-delete"}])
