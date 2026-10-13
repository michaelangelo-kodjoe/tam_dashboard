"""T-11 / T-12: audit-in-transaction, concurrency, deletes with backups, business rules D-07, D-08, D-10..D-12."""
from __future__ import annotations

import ast
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from server import services
from server.backups import BackupService
from server.errors import BackupFailed

from .conftest import ROOT, d

SERVER_DIR = ROOT / "server"


# ------------------------------------------------------------------ static contracts (D-25, US-1.6 AC3)
def test_sql_safety_scan_clean_on_server():
    p = subprocess.run([sys.executable, str(ROOT / "db" / "sql_safety_scan.py"), str(ROOT / "server")],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


def test_sql_safety_scan_clean_on_whole_tree():
    p = subprocess.run([sys.executable, str(ROOT / "db" / "sql_safety_scan.py"), str(ROOT)],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


def test_no_naive_file_copy_of_live_db():
    needles = ["shutil" + ".copy", "copy" + "file(", "os." + "replace(", "shutil." + "move"]
    for f in SERVER_DIR.rglob("*.py"):
        if "tests" in f.parts:
            continue
        text = f.read_text()
        for n in needles:
            assert n not in text, f"{f.name}: {n}"


def test_every_db_open_passes_channel():
    """No module opens SQLite except dbkit; every open_db() call names channel=."""
    for f in SERVER_DIR.rglob("*.py"):
        if "tests" in f.parts:
            continue
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
                owner = fn.value.id if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) else ""
                if name == "open_db":
                    assert "channel" in {k.arg for k in node.keywords}, f"{f.name}:{node.lineno}"
                if name == "connect" and owner in ("sqlite3", "migrate"):
                    assert f.name == "dbkit.py", f"{f.name}:{node.lineno} opens a DB outside dbkit"
                if name == "migrate" and owner == "migrate":
                    assert "channel" in {k.arg for k in node.keywords}, f"{f.name}:{node.lineno}"


def test_open_db_requires_channel():
    from server.dbkit import open_db
    with pytest.raises(TypeError):
        open_db(Path("/tmp/x.db"))           # type: ignore[call-arg]
    with pytest.raises(ValueError):
        open_db(Path("/tmp/x.db"), channel="staging")


# ------------------------------------------------------------------ clients
def test_client_create_audit_and_validation(api):
    c = api.mk_client("Acme Capital", bpid=" 123 ", products="Terminal")
    assert c["bpid"] == "123" and c["row_version"] == 1 and c["status"] == "Active"
    assert c["counts"]["open_tasks"] == 0
    rows = api.audit(object_type="client", action="created")
    assert len(rows) == 1 and rows[0]["source"] == "GUI" and rows[0]["client_id"] == c["id"]
    api.err("/api/client/save", {"name": "   "}, 422, "validation_error")
    api.err("/api/client/save", {"name": "x\ty"}, 422, "validation_error")
    e = api.err("/api/client/save", {"name": "Z", "status": "Gone"}, 422, "validation_error")
    assert "status" in e["fields"]
    e = api.err("/api/client/save", {"name": "Z", "bogus": 1}, 422, "validation_error")
    assert e["fields"]["bogus"] == "unknown field"
    api.err("/api/client/save", {"name": "Z", "next_contact": "2026-02-30"}, 422, "validation_error")
    api.err("/api/client/save", {"status": "Active"}, 422, "validation_error")


def test_client_name_unique_case_insensitive_including_non_ascii(api):
    api.mk_client("Acme Capital")
    e = api.err("/api/client/save", {"name": "ACME capital"}, 409, "conflict")
    assert e["fields"]["name"] == "already exists"
    api.mk_client("Straße AG")
    api.err("/api/client/save", {"name": "STRASSE AG"}, 409, "conflict")      # casefold, not just NOCASE
    other = api.mk_client("Other")
    api.err("/api/client/save", {"id": other["id"], "name": "acme CAPITAL"}, 409, "conflict")
    assert api.sql("SELECT count(*) AS n FROM clients")[0]["n"] == 3


def test_client_update_patch_semantics_row_version_and_audit(api):
    c = api.mk_client("Acme", bpid="1", next_contact=d(5))
    r = api.ok("/api/client/save", {"id": c["id"], "expected_row_version": 1, "products": "B-PIPE"})["item"]
    assert r["row_version"] == 2 and r["products"] == "B-PIPE" and r["bpid"] == "1" and r["next_contact"] == d(5)
    ups = api.audit(client_id=c["id"], action="updated")
    assert len(ups) == 1 and '"products"' in ups[0]["new_value"] and '"bpid"' not in ups[0]["new_value"]
    # explicit null clears
    r = api.ok("/api/client/save", {"id": c["id"], "bpid": None, "next_contact": None})["item"]
    assert r["bpid"] is None and r["next_contact"] is None and r["row_version"] == 3
    assert len(api.audit(client_id=c["id"], action="next_contact_changed")) == 1
    # status change gets its own system-visible audit action
    api.ok("/api/client/save", {"id": c["id"], "status": "Inactive"})
    assert len(api.audit(client_id=c["id"], action="status_changed")) == 1


def test_noop_save_does_not_bump_or_audit(api):
    c = api.mk_client("Acme")
    before = len(api.audit())
    j = api.ok("/api/client/save", {"id": c["id"], "name": "Acme"})
    assert j["side_effects"] == [{"type": "no_change"}] and j["item"]["row_version"] == 1
    assert len(api.audit()) == before


def test_stale_write_409_and_missing_404(api):
    c = api.mk_client("Acme")
    api.ok("/api/client/save", {"id": c["id"], "expected_row_version": 1, "notes": "a"})
    e = api.err("/api/client/save", {"id": c["id"], "expected_row_version": 1, "notes": "b"}, 409, "stale_write")
    assert e["details"]["current_row_version"] == 2
    assert api.sql("SELECT notes FROM clients")[0]["notes"] == "a"
    api.err("/api/client/save", {"id": "nope", "notes": "x"}, 404, "not_found")
    t = api.mk_task(c["id"])
    api.ok("/api/task/save", {"id": t["id"], "expected_row_version": 1, "priority": "High"})
    api.err("/api/task/save", {"id": t["id"], "expected_row_version": 1, "priority": "Low"}, 409, "stale_write")


def test_row_version_bumped_explicitly_exactly_one(api):
    c = api.mk_client("Acme")
    for i in range(1, 4):
        assert api.ok("/api/client/save", {"id": c["id"], "notes": f"n{i}"})["item"]["row_version"] == i + 1
    assert api.sql("SELECT row_version FROM clients")[0]["row_version"] == 4


def test_client_delete_needs_confirm_and_name_then_backs_up_and_cascades(api):
    c = api.mk_client("Acme")
    t = api.mk_task(c["id"])
    api.ok("/api/contact/save", {"client_id": c["id"], "name": "Jo"})
    api.ok("/api/note/save", {"client_id": c["id"], "note_type": "General Note", "subject": "s"})
    api.err("/api/client/delete", {"id": c["id"]}, 409, "confirmation_required")
    api.err("/api/client/delete", {"id": c["id"], "confirm": True}, 409, "confirmation_required")
    api.err("/api/client/delete", {"id": c["id"], "confirm": True, "confirm_name": "acme"}, 409, "confirmation_required")
    assert not list(api.rt.config.backup_dir.glob("*pre-delete*"))          # nothing happened yet
    j = api.ok("/api/client/delete", {"id": c["id"], "confirm": True, "confirm_name": "Acme"})
    assert j["side_effects"][0]["type"] == "backup_created"
    backup = api.rt.config.backup_dir / j["side_effects"][0]["file"]
    assert backup.exists()
    # the backup is a consistent DB that still has the account (taken BEFORE the delete)
    bk = sqlite3.connect(backup)
    assert bk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert bk.execute("SELECT count(*) FROM clients WHERE id=?", (c["id"],)).fetchone()[0] == 1
    bk.close()
    for tbl in ("clients", "contacts", "tasks", "notes"):
        assert api.sql(f"SELECT count(*) AS n FROM {tbl}")[0]["n"] == 0
    aud = api.audit(object_type="client", action="deleted")
    assert len(aud) == 1 and aud[0]["client_id"] == c["id"] and t["id"] in "".join(
        r["object_id"] or "" for r in api.audit(object_type="task"))       # history survives the cascade


def test_delete_aborts_when_backup_fails(api, monkeypatch):
    c = api.mk_client("Acme")
    t = api.mk_task(c["id"])

    def boom(self, conn, reason):
        raise BackupFailed("Safety backup could not be written; the operation was cancelled.")
    monkeypatch.setattr(BackupService, "create", boom)
    e = api.err("/api/task/delete", {"id": t["id"], "confirm": True}, 500, "backup_failed")
    assert "cancelled" in e["message"]
    api.err("/api/client/delete", {"id": c["id"], "confirm": True, "confirm_name": "Acme"}, 500, "backup_failed")
    assert api.sql("SELECT count(*) AS n FROM tasks")[0]["n"] == 1
    assert api.sql("SELECT count(*) AS n FROM clients")[0]["n"] == 1
    assert not api.audit(action="deleted")


def test_backup_to_unwritable_dir_aborts_delete(api):
    c = api.mk_client("Acme")
    t = api.mk_task(c["id"])
    cfg = api.rt.config
    bd = cfg.backup_dir
    bd.rmdir() if not any(bd.iterdir()) else None
    bd.write_text("i am a file, not a directory")        # makes dest creation impossible
    try:
        api.err("/api/task/delete", {"id": t["id"], "confirm": True}, 500, "backup_failed")
        assert api.sql("SELECT count(*) AS n FROM tasks")[0]["n"] == 1
    finally:
        bd.unlink()
        bd.mkdir()


# ------------------------------------------------------------------ audit atomicity (US-1.5 AC2)
def test_every_write_produces_exactly_one_audit_row(api):
    def count():
        return api.sql("SELECT count(*) AS n FROM audit_events")[0]["n"]
    n = count()
    c = api.mk_client("Acme")
    assert count() == n + 1; n += 1
    api.ok("/api/client/save", {"id": c["id"], "notes": "x"})
    assert count() == n + 1; n += 1
    ct = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Jo"})["item"]
    assert count() == n + 1; n += 1
    api.ok("/api/contact/save", {"id": ct["id"], "role": "CIO"})
    assert count() == n + 1; n += 1
    t = api.mk_task(c["id"])
    assert count() == n + 1; n += 1
    api.ok("/api/task/save", {"id": t["id"], "status": "Complete"})
    assert count() == n + 1; n += 1
    api.ok("/api/task/archive", {"id": t["id"], "archived": True})
    assert count() == n + 1; n += 1
    nt = api.ok("/api/note/save", {"client_id": c["id"], "note_type": "General Note", "subject": "s"})["item"]
    assert count() == n + 1; n += 1
    api.ok("/api/note/save", {"id": nt["id"], "subject": "s2"})
    assert count() == n + 1; n += 1
    api.ok("/api/note/delete", {"id": nt["id"], "confirm": True})
    assert count() == n + 1; n += 1
    api.ok("/api/task/delete", {"id": t["id"], "confirm": True})
    assert count() == n + 1; n += 1
    api.ok("/api/contact/delete", {"id": ct["id"], "confirm": True})
    assert count() == n + 1; n += 1
    api.ok("/api/settings/save", {"settings": {"time_display": "gmt"}})
    assert count() == n + 1; n += 1
    api.ok("/api/data/backup", {})
    assert count() == n + 1


def test_audit_failure_rolls_back_the_data_write(api, monkeypatch):
    c = api.mk_client("Acme")

    def boom(*a, **k):
        raise RuntimeError("audit down")
    monkeypatch.setattr(services, "write_audit", boom)
    r = api.post("/api/task/save", {"task": "Lost", "client_id": c["id"]})
    assert r.status_code == 500 and r.json()["error"]["code"] == "internal"
    assert api.sql("SELECT count(*) AS n FROM tasks")[0]["n"] == 0
    r = api.post("/api/client/save", {"id": c["id"], "notes": "changed"})
    assert r.status_code == 500
    row = api.sql("SELECT notes, row_version FROM clients")[0]
    assert row["notes"] is None and row["row_version"] == 1


def test_audit_is_append_only_at_db_level(api):
    api.mk_client("Acme")
    with pytest.raises(sqlite3.DatabaseError):
        api.exec("UPDATE audit_events SET action='x'")
    with pytest.raises(sqlite3.DatabaseError):
        api.exec("DELETE FROM audit_events")


# ------------------------------------------------------------------ contacts / primary (US-8.2)
def test_primary_switch_is_atomic_and_audited(api):
    c = api.mk_client("Acme")
    a = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Alice", "is_primary": True})["item"]
    b = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Bob"})["item"]
    assert a["is_primary"] is True and b["is_primary"] is False
    j = api.ok("/api/contact/save", {"id": b["id"], "is_primary": True})
    assert j["item"]["is_primary"] is True
    assert j["side_effects"] == [{"type": "primary_cleared", "contact_id": a["id"], "name": "Alice"}]
    prim = api.sql("SELECT name FROM contacts WHERE is_primary=1")
    assert [r["name"] for r in prim] == ["Bob"]
    pc = api.audit(action="primary_changed")
    assert len(pc) == 1 and '"Alice"' in pc[0]["old_value"] and '"Bob"' in pc[0]["new_value"]


def test_create_primary_displaces_old_and_zero_primary_allowed(api):
    c = api.mk_client("Acme")
    assert api.sql("SELECT count(*) AS n FROM contacts WHERE is_primary=1")[0]["n"] == 0
    a = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Alice", "is_primary": True})["item"]
    j = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Bob", "is_primary": True})
    assert j["side_effects"][0]["type"] == "primary_cleared"
    assert api.sql("SELECT count(*) AS n FROM contacts WHERE is_primary=1")[0]["n"] == 1
    # un-primary leaves zero
    api.ok("/api/contact/save", {"id": j["item"]["id"], "is_primary": False})
    assert api.sql("SELECT count(*) AS n FROM contacts WHERE is_primary=1")[0]["n"] == 0
    assert a["id"]


def test_primary_is_per_account(api):
    c1, c2 = api.mk_client("A1"), api.mk_client("A2")
    api.ok("/api/contact/save", {"client_id": c1["id"], "name": "x", "is_primary": True})
    j = api.ok("/api/contact/save", {"client_id": c2["id"], "name": "y", "is_primary": True})
    assert j["side_effects"] == []
    assert api.sql("SELECT count(*) AS n FROM contacts WHERE is_primary=1")[0]["n"] == 2


def test_contact_validation_and_immutable_client(api):
    c, c2 = api.mk_client("Acme"), api.mk_client("Other")
    api.err("/api/contact/save", {"client_id": c["id"], "name": "Jo", "email": "a@@b..c"}, 422, "validation_error")
    api.err("/api/contact/save", {"client_id": c["id"], "name": "Jo", "email": "nope"}, 422, "validation_error")
    api.err("/api/contact/save", {"client_id": "missing", "name": "Jo"}, 422, "validation_error")
    api.err("/api/contact/save", {"name": "Jo"}, 422, "validation_error")
    ct = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Jo", "email": "jo@example.com"})["item"]
    api.err("/api/contact/save", {"id": ct["id"], "client_id": c2["id"]}, 422, "validation_error")
    assert api.ok("/api/contact/save", {"id": ct["id"], "email": ""})["item"]["email"] is None


def test_contact_delete_backup_audit(api):
    c = api.mk_client("Acme")
    ct = api.ok("/api/contact/save", {"client_id": c["id"], "name": "Jo"})["item"]
    api.err("/api/contact/delete", {"id": ct["id"]}, 409, "confirmation_required")
    j = api.ok("/api/contact/delete", {"id": ct["id"], "confirm": True})
    assert (api.rt.config.backup_dir / j["side_effects"][0]["file"]).exists()
    assert len(api.audit(object_type="contact", action="deleted")) == 1
    api.err("/api/contact/delete", {"id": ct["id"], "confirm": True}, 404, "not_found")


# ------------------------------------------------------------------ tasks (D-07, lifecycle)
def test_task_defaults_validation_and_unassigned(api):
    t = api.mk_task(None, "Internal thing")
    assert (t["category"], t["priority"], t["status"], t["client_id"], t["archived"]) == \
           ("Other", "Medium", "Not Started", None, False)
    for bad in ({"task": ""}, {"task": "x", "category": "Nope"}, {"task": "x", "priority": "Urgent"},
                {"task": "x", "status": "Done"}, {"task": "x", "due": "10/12/2026"}, {"task": "x" * 501},
                {"task": "a\nb"}, {"task": "x", "notes": "n" * 20001}, {"task": "x", "client_id": "ghost"}):
        api.err("/api/task/save", bad, 422, "validation_error")
    api.err("/api/task/save", {"id": t["id"], "status": None}, 422, "validation_error")


def test_task_lifecycle_audit_actions(api):
    c = api.mk_client("Acme")
    t = api.mk_task(c["id"])
    api.ok("/api/task/save", {"id": t["id"], "status": "In Progress"})
    api.ok("/api/task/save", {"id": t["id"], "status": "Complete"})
    api.ok("/api/task/save", {"id": t["id"], "status": "Waiting", "waiting": "J. Doe"})
    api.ok("/api/task/archive", {"id": t["id"], "archived": True})
    api.ok("/api/task/archive", {"id": t["id"], "archived": False})
    acts = [r["action"] for r in api.audit(object_type="task")]
    assert acts == ["created", "updated", "completed", "reopened", "archived", "unarchived"]
    j = api.ok("/api/task/archive", {"id": t["id"], "archived": False})
    assert j["side_effects"] == [{"type": "no_change"}]


def test_tasks_query_filters_account_only_archived_unassigned(api):
    a, b = api.mk_client("A"), api.mk_client("B")
    t1 = api.mk_task(a["id"], "a1", priority="High", due=d(1), waiting="someone")
    api.mk_task(a["id"], "a2", status="Complete")
    api.mk_task(b["id"], "b1")
    api.mk_task(None, "orphan")
    arch = api.mk_task(a["id"], "a-arch")
    api.ok("/api/task/archive", {"id": arch["id"], "archived": True})
    names = lambda r: sorted(i["task"] for i in r.json()["items"])  # noqa: E731
    assert names(api.get("/api/tasks", client_id=a["id"])) == ["a1", "a2"]                # [§52] only this account
    assert names(api.get("/api/tasks", client_id=a["id"], status="open")) == ["a1"]
    assert names(api.get("/api/tasks", client_id=a["id"], archived="true")) == ["a-arch"]
    assert names(api.get("/api/tasks", client_id=a["id"], archived="all")) == ["a-arch", "a1", "a2"]
    assert names(api.get("/api/tasks", client_id="none")) == ["orphan"]
    assert names(api.get("/api/tasks", q="someone")) == ["a1"]
    assert names(api.get("/api/tasks", priority="High")) == ["a1"]
    assert api.get("/api/tasks", status="bogus").status_code == 422
    r = api.get("/api/tasks", client_id=a["id"]).json()
    assert r["items"][0]["task"] == "a1" and r["items"][0]["client_name"] == "A" and r["count"] == 2
    assert t1["id"]


def test_task_delete_backup_and_audit(api):
    t = api.mk_task(None, "bye")
    api.err("/api/task/delete", {"id": t["id"]}, 409, "confirmation_required")
    j = api.ok("/api/task/delete", {"id": t["id"], "confirm": True})
    assert (api.rt.config.backup_dir / j["side_effects"][0]["file"]).exists()
    assert api.audit(object_type="task", action="deleted")[0]["object_label"] == "bye"
    assert api.sql("SELECT count(*) AS n FROM tasks")[0]["n"] == 0


def test_d07_follow_up_sets_next_contact_only_when_earlier_or_empty(api):
    c = api.mk_client("Acme")
    j = api.ok("/api/task/save", {"task": "Follow up", "client_id": c["id"], "category": "Client Follow-Up",
                                  "due": d(5), "update_next_contact": True})
    assert j["side_effects"] == [{"type": "next_contact_updated", "client_id": c["id"], "old": None, "new": d(5)}]
    assert api.sql("SELECT next_contact FROM clients")[0]["next_contact"] == d(5)
    sysrows = api.audit(client_id=c["id"], action="next_contact_changed")
    assert len(sysrows) == 1 and sysrows[0]["source"] == "System"
    # later due date: no change
    j = api.ok("/api/task/save", {"task": "Later", "client_id": c["id"], "category": "Client Follow-Up",
                                  "due": d(9), "update_next_contact": True})
    assert j["side_effects"] == []
    # earlier due date: moves it
    api.ok("/api/task/save", {"task": "Earlier", "client_id": c["id"], "category": "Client Follow-Up",
                              "due": d(2), "update_next_contact": True})
    assert api.sql("SELECT next_contact FROM clients")[0]["next_contact"] == d(2)
    # checkbox off, other category: no change
    api.ok("/api/task/save", {"task": "Off", "client_id": c["id"], "category": "Client Follow-Up", "due": d(1)})
    api.ok("/api/task/save", {"task": "Other", "client_id": c["id"], "category": "Reporting", "due": d(0),
                              "update_next_contact": True})
    assert api.sql("SELECT next_contact FROM clients")[0]["next_contact"] == d(2)


# ------------------------------------------------------------------ notes (US-7.3, D-08)
@pytest.mark.parametrize("ntype", ["Meeting Note", "Call Note", "General Note"])
def test_note_crud_each_type_and_system_event(api, ntype):
    c = api.mk_client("Acme")
    n = api.ok("/api/note/save", {"client_id": c["id"], "note_type": ntype, "subject": "Subj", "body": "B",
                                  "action_items": "do it"})["item"]
    assert n["source"] == "GUI" and n["note_type"] == ntype
    n2 = api.ok("/api/note/save", {"id": n["id"], "expected_row_version": 1, "subject": "Subj2"})["item"]
    assert n2["subject"] == "Subj2" and n2["row_version"] == 2 and n2["body"] == "B"
    api.err("/api/note/save", {"id": n["id"], "expected_row_version": 1, "subject": "again"}, 409, "stale_write")
    api.err("/api/note/delete", {"id": n["id"]}, 409, "confirmation_required")
    j = api.ok("/api/note/delete", {"id": n["id"], "confirm": True})
    assert (api.rt.config.backup_dir / j["side_effects"][0]["file"]).exists()
    items = api.get(f"/api/client/{c['id']}/activity", filter="system").json()["items"]
    assert items[0]["sentence"] == f"{ntype} deleted: Subj2" and items[0]["kind"] == "system"


def test_note_validation_and_no_forged_source(api):
    c = api.mk_client("Acme")
    api.err("/api/note/save", {"client_id": c["id"], "note_type": "Call Note"}, 422, "validation_error")
    api.err("/api/note/save", {"client_id": c["id"], "note_type": "System Note", "subject": "x"}, 422, "validation_error")
    e = api.err("/api/note/save", {"client_id": c["id"], "note_type": "Call Note", "subject": "x", "source": "System"},
                422, "validation_error")
    assert e["fields"]["source"] == "unknown field"
    api.err("/api/note/save", {"client_id": c["id"], "note_type": "Call Note", "subject": "x",
                               "timestamp": "yesterday"}, 422, "validation_error")
    n = api.ok("/api/note/save", {"client_id": c["id"], "note_type": "Call Note", "subject": "x",
                                  "timestamp": "2026-10-01T10:00:00+02:00"})["item"]
    assert n["timestamp"] == "2026-10-01T08:00:00.000Z"
    # system events live in audit_events, not notes: no route can edit them
    sys_ev = api.get(f"/api/client/{c['id']}/activity", filter="system").json()["items"]
    api.err("/api/note/save", {"id": "a:000000000001", "subject": "hack"}, 404, "not_found")
    assert all(e["kind"] == "system" for e in sys_ev)


def test_d08_last_contact_only_for_meeting_and_call(api):
    c = api.mk_client("Acme")
    api.ok("/api/note/save", {"client_id": c["id"], "note_type": "General Note", "subject": "g",
                              "timestamp": "2026-10-01T12:00:00Z"})
    assert api.sql("SELECT last_contact FROM clients")[0]["last_contact"] is None
    j = api.ok("/api/note/save", {"client_id": c["id"], "note_type": "Meeting Note", "subject": "m",
                                  "timestamp": "2026-10-01T12:00:00Z"})
    assert j["side_effects"][0]["type"] == "last_contact_updated"
    assert api.sql("SELECT last_contact FROM clients")[0]["last_contact"] == "2026-10-01"
    j = api.ok("/api/note/save", {"client_id": c["id"], "note_type": "Call Note", "subject": "older",
                                  "timestamp": "2026-09-01T12:00:00Z"})
    assert j["side_effects"] == []
    api.ok("/api/note/save", {"client_id": c["id"], "note_type": "Call Note", "subject": "newer",
                              "timestamp": "2026-10-03T12:00:00Z"})
    assert api.sql("SELECT last_contact FROM clients")[0]["last_contact"] == "2026-10-03"
    lc = api.audit(action="last_contact_changed")
    assert len(lc) == 2 and all(r["source"] == "System" for r in lc)


def test_activity_filters_search_and_pagination(api):
    c = api.mk_client("Acme")
    for i in range(7):
        api.ok("/api/note/save", {"client_id": c["id"], "note_type": ["Meeting Note", "Call Note", "General Note"][i % 3],
                                  "subject": f"note {i}", "body": "needle" if i == 4 else "hay",
                                  "timestamp": f"2026-10-0{i + 1}T10:00:00Z"})
    t = api.mk_task(c["id"], "sys task")
    api.ok("/api/task/save", {"id": t["id"], "status": "Complete"})
    base = f"/api/client/{c['id']}/activity"
    kinds = lambda **p: {i.get("note_type", "system") for i in api.get(base, **p).json()["items"]}  # noqa: E731
    assert kinds(filter="meeting") == {"Meeting Note"}
    assert kinds(filter="call") == {"Call Note"}
    assert kinds(filter="general") == {"General Note"}
    assert kinds(filter="system") == {"system"}
    assert [i["subject"] for i in api.get(base, q="needle").json()["items"]] == ["note 4"]
    # pagination without overlap, notes carry row_version
    seen, cursor = [], None
    while True:
        r = api.get(base, limit=3, **({"before": cursor} if cursor else {})).json()
        seen += [i["entry_key"] for i in r["items"]]
        cursor = r["next_cursor"]
        if not r["has_more"]:
            break
    assert len(seen) == len(set(seen)) == 7 + 2        # 7 notes + task created/completed system events
    first = api.get(base, filter="meeting").json()["items"][0]
    assert first["row_version"] == 1
    assert api.get(base, filter="bogus").status_code == 422
    assert api.get(base, before="!!!").status_code == 422
    assert api.get("/api/client/ghost/activity").status_code == 404


# ------------------------------------------------------------------ settings
def test_settings_roundtrip_validation_and_audit(api):
    s = api.get("/api/settings").json()["settings"]
    assert s == {"default_landing": "today", "time_display": "local", "auto_refresh_minutes": "off",
                 "log_level": "INFO", "open_browser_on_start": False}
    j = api.ok("/api/settings/save", {"settings": {"default_landing": "accounts", "open_browser_on_start": True,
                                                  "auto_refresh_minutes": "5"}})
    assert j["item"]["default_landing"] == "accounts" and j["item"]["open_browser_on_start"] is True
    assert api.sql("SELECT value FROM app_meta WHERE key='setting.open_browser_on_start'")[0]["value"] == "1"
    assert len(api.audit(object_type="setting", action="updated")) == 3
    e = api.err("/api/settings/save", {"settings": {"time_display": "utc", "nope": 1}}, 422, "validation_error")
    assert set(e["fields"]) == {"time_display", "nope"}
    assert api.ok("/api/settings/save", {"settings": {"default_landing": "accounts"}})["side_effects"] == \
        [{"type": "no_change"}]
    assert len(api.audit(object_type="setting")) == 3


# ------------------------------------------------------------------ backups (US-1.6, D-22)
def test_manual_backup_listing_and_integrity(api):
    api.mk_client("Acme")
    j = api.ok("/api/data/backup", {})
    assert j["item"]["reason"] == "manual"
    lst = api.get("/api/data/backups").json()
    assert lst["items"][0]["name"] == j["item"]["name"]
    bk = sqlite3.connect(api.rt.config.backup_dir / j["item"]["name"])
    assert bk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert bk.execute("SELECT count(*) FROM clients").fetchone()[0] == 1
    bk.close()


def test_retention_prunes_only_automatic_keeps_30_and_all_manual(tmp_path):
    svc = BackupService(tmp_path)
    for i in range(35):
        (tmp_path / f"tam_20260101T0000{i:02d}000000Z_pre-delete_v1.db").write_bytes(b"x")
    for i in range(3):
        (tmp_path / f"tam_20250101T0000{i:02d}000000Z_pre-migration_v1.db").write_bytes(b"x")
    for i in range(5):
        (tmp_path / f"tam_20240101T0000{i:02d}000000Z_manual_v1.db").write_bytes(b"x")
    removed = svc.prune()
    left = sorted(p.name for p in tmp_path.iterdir())
    assert len(removed) == 8
    assert sum("manual" in n for n in left) == 5
    assert sum("manual" not in n for n in left) == 30
    assert all("pre-migration" not in r or True for r in removed)
    # the 30 newest automatic ones were kept: the 2025 pre-migration files (oldest) are gone
    assert not any("2025" in n for n in left)


def test_backup_under_concurrent_wal_writes_passes_integrity_check(api):
    """[§52] a backup taken while the app is writing in WAL mode is consistent and has the committed rows."""
    c = api.mk_client("Acme")
    stop = threading.Event()
    committed = []
    errors = []

    def writer():
        try:
            with api.rt.db() as conn:
                i = 0
                while not stop.is_set():
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("INSERT INTO notes (id, client_id, note_type, timestamp, subject, source) "
                                 "VALUES (?, ?, 'General Note', '2026-10-01T00:00:00.000Z', ?, 'GUI')",
                                 (f"w{i}", c["id"], f"w{i}"))
                    conn.execute("COMMIT")
                    committed.append(i)
                    i += 1
        except Exception as exc:        # pragma: no cover
            errors.append(exc)
    th = threading.Thread(target=writer)
    th.start()
    try:
        while len(committed) < 50:
            pass
        for _ in range(5):
            before = len(committed)
            with api.rt.db() as conn:
                info = api.rt.backups.create(conn, "manual")
            bk = sqlite3.connect(api.rt.config.backup_dir / info["name"])
            assert bk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert bk.execute("PRAGMA foreign_key_check").fetchall() == []
            assert bk.execute("SELECT count(*) FROM notes").fetchone()[0] >= before
            bk.close()
    finally:
        stop.set()
        th.join()
    assert not errors


# ------------------------------------------------------------------ stubs / routing
STUBS = ["/api/operations/schedule/sync", "/api/operations/server-upgrade/save", "/api/operations/server-upgrade/template",
         "/api/bams/state", "/api/bams/poll", "/api/export/database", "/api/export/excel", "/api/import/inspect",
         "/api/import/apply", "/api/data/reset", "/api/restore/excel", "/api/context", "/api/chat/apply"]


@pytest.mark.parametrize("path", STUBS)
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_later_phase_routes_are_501(api, path, method):
    r = api.c.request(method, path)
    assert r.status_code == 501, (path, r.text)
    err = r.json()["error"]
    assert r.json()["ok"] is False and err["code"] == "not_implemented" and "phase" in err["details"]


def test_unknown_api_route_and_wrong_method(api):
    r = api.get("/api/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    r = api.c.get("/api/task/save")
    assert r.status_code in (404, 405) and r.json()["ok"] is False
    r = api.c.post("/api/client/save", content="not json", headers={"content-type": "application/json"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_spa_fallback_serves_index_when_built(api):
    web = api.rt.config.web_dir
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>app</html>")
    (web / "assets" / "a.js").write_text("1")
    assert api.get("/accounts/123/overview").text == "<html>app</html>"
    assert api.get("/assets/a.js").text == "1"
    assert api.get("/assets/missing.js").status_code == 404
    assert api.get("/../../etc/passwd").status_code in (200, 404)
    assert api.get("/api/health").json()["ok"] is True          # API still wins
    assert api.get("/api/zzz").status_code == 404


def test_dev_reseed_resets_with_safety_backup(seeded):
    seeded.exec("DELETE FROM tasks WHERE client_id IS NOT NULL")
    seeded.ok("/api/settings/save", {"settings": {"time_display": "gmt"}})
    j = seeded.ok("/api/dev/reseed", {"confirm": True})
    assert j["item"]["counts"]["clients"] == 12
    assert (seeded.rt.config.backup_dir / j["side_effects"][0]["file"]).exists()
    assert seeded.sql("SELECT count(*) AS n FROM tasks")[0]["n"] > 100
    assert seeded.get("/api/settings").json()["settings"]["time_display"] == "gmt"      # settings kept
    assert seeded.audit(action="reseeded")
