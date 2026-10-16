"""Run 6 phase 2 (T-184, T-185): whole-database restore: staging refusals, swap, fault injection, recovery, gate."""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from server import constants as C
from server.portability import dbrestore as DR
from server.runtime import Runtime

DB = "/api/restore/database"


def accounts(api):
    return sorted(r["name"] for r in api.sql("SELECT name FROM clients"))


def copy_bytes(api):
    r = api.get("/api/export/database")
    assert r.status_code == 200
    return r.content


def stage(api, data, name="x.db", status=200):
    r = api.c.post(f"{DB}/inspect", content=data, headers={"X-File-Name": name})
    assert r.status_code == status, r.text
    return r.json()["item"] if status == 200 else r.json()["error"]


def go(api, item, confirm="RESTORE", status=200):
    r = api.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": confirm})
    assert r.status_code == status, r.text
    return r.json()


def mutate(data, tmp_path, sql, params=()):
    """Return a modified copy of a database file (done on a scratch file, never on the live DB)."""
    p = tmp_path / f"m{time.time_ns()}.db"
    p.write_bytes(data)
    c = sqlite3.connect(p)
    c.execute("PRAGMA foreign_keys = OFF")
    c.execute("PRAGMA writable_schema = ON") if "sqlite_master" in sql else None
    c.execute(sql, params)
    c.commit()
    c.execute("PRAGMA journal_mode=DELETE")
    c.close()
    return p.read_bytes()


def live_sha(api):
    with api.rt.db() as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return hashlib.sha256(api.rt.config.db_path.read_bytes()).hexdigest()


def leftovers(api):
    d = api.rt.config.db_path.parent
    return sorted(p.name for p in d.iterdir() if p.name.endswith((".restore-new", ".pre-restore-old")))


@pytest.fixture
def ra(build):
    api = build()
    api.mk_client("Alpha Co")
    api.mk_client("Beta Co")
    return api


# ------------------------------------------------------------------------------------------ happy path
def test_restore_replaces_everything_and_keeps_the_instance_lock(ra):
    snapshot = copy_bytes(ra)
    ra.mk_client("Gamma Co")
    ra.mk_task(ra.sql("SELECT id FROM clients LIMIT 1")[0]["id"], "after copy")
    item = stage(ra, snapshot)
    assert item["file"]["counts"]["accounts"] == 2 and item["current"]["counts"]["accounts"] == 3
    assert "accounts" in item["fewer"] or "tasks" in item["fewer"]
    assert item["confirm_word"] == "RESTORE" and "replaced" in item["warning"] and item["source"]["kind"] == "upload"
    assert ra.get(f"{DB}/{item['restore_id']}").json()["item"]["restore_id"] == item["restore_id"]
    held = ra.rt.lock._fd
    res = go(ra, item)["item"]
    assert res["restored"] and res["backup"]["reason"] == "pre-restore" and res["counts"]["accounts"] == 2
    assert accounts(ra) == ["Alpha Co", "Beta Co"] and ra.rt.lock._fd == held is not None
    ev = ra.audit(action="restored", object_type="backup")
    assert len(ev) == 1 and ev[0]["category"] == "data" and ev[0]["source"] == "System" and ev[0]["object_id"] == res["backup"]["name"]
    assert leftovers(ra) == [] and not (ra.rt.config.data_dir / "restore_tmp").exists() or not list((ra.rt.config.data_dir / "restore_tmp").iterdir())
    assert ra.get("/api/state").status_code == 200 and ra.get("/api/health").json().get("restoring") is None
    go(ra, item, status=410)                                      # second apply with the same id
    assert ra.c.get(f"{DB}/{item['restore_id']}").status_code == 410
    assert ra.mk_client("After Restore")["name"] == "After Restore"          # the app writes normally afterwards


def test_pre_restore_backup_is_never_pruned(ra):
    item = stage(ra, copy_bytes(ra))
    name = go(ra, item)["item"]["backup"]["name"]
    with ra.rt.db() as conn:
        for _ in range(C.AUTO_BACKUP_KEEP + 2):
            ra.rt.backups.create(conn, "pre-delete")
    assert "pre-restore" not in C.AUTO_BACKUP_REASONS
    assert name in {b["name"] for b in ra.rt.backups.list(500)}


def test_undo_round_trip_through_the_pre_restore_backup(ra):
    s0 = copy_bytes(ra)
    ra.mk_client("Gamma Co")                                       # state S1 has 3 accounts
    name = go(ra, stage(ra, s0))["item"]["backup"]["name"]
    assert accounts(ra) == ["Alpha Co", "Beta Co"]
    item = ra.post(f"{DB}/from-backup", {"name": name}).json()["item"]
    assert item["source"] == {"kind": "backup", "name": name}
    go(ra, item)
    assert accounts(ra) == ["Alpha Co", "Beta Co", "Gamma Co"]
    assert len(ra.audit(action="restored", object_type="backup")) >= 1


def test_from_backup_validates_name(ra):
    for bad in ("../../etc/passwd", "nope.db", "tam_x.db", ""):
        r = ra.post(f"{DB}/from-backup", {"name": bad})
        assert r.status_code in (404, 422), (bad, r.text)
    with ra.rt.db() as conn:
        n = ra.rt.backups.create(conn, "manual")["name"]
    assert ra.post(f"{DB}/from-backup", {"name": n}).status_code == 200


def test_cancel_and_expiry(ra):
    item = stage(ra, copy_bytes(ra))
    staged = list((ra.rt.config.data_dir / "restore_tmp").iterdir())
    assert len(staged) == 1
    assert ra.post(f"{DB}/{item['restore_id']}/cancel").json()["item"] == {"cancelled": True}
    assert not list((ra.rt.config.data_dir / "restore_tmp").iterdir())
    assert ra.get(f"{DB}/{item['restore_id']}").status_code == 410
    assert ra.post(f"{DB}/{item['restore_id']}/cancel").json()["item"] == {"cancelled": False}
    item = stage(ra, copy_bytes(ra))
    real = DR._now
    DR._now = lambda: real() + DR.SESSION_TTL + 5
    try:
        assert ra.get(f"{DB}/{item['restore_id']}").status_code == 410
    finally:
        DR._now = real
    assert not list((ra.rt.config.data_dir / "restore_tmp").iterdir())
    one = stage(ra, copy_bytes(ra))
    two = stage(ra, copy_bytes(ra))                                 # one staged session at a time
    assert ra.get(f"{DB}/{one['restore_id']}").status_code == 410 and ra.get(f"{DB}/{two['restore_id']}").status_code == 200


def test_wrong_confirmation_is_refused_server_side(ra):
    item = stage(ra, copy_bytes(ra))
    for word in ("restore", "RESTORE ", "", "YES"):
        r = ra.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": word})
        assert r.status_code == 409 and r.json()["error"]["code"] == "confirm_mismatch"
    assert ra.get(f"{DB}/{item['restore_id']}").status_code == 200 and not ra.audit(action="restored")


# ------------------------------------------------------------------------------------------ refusals
def refusal(api, data, code, status=422):
    d = api.rt.config.data_dir / "restore_tmp"
    before = len(list(d.glob("*"))) if d.exists() else 0
    err = stage(api, data, status=status)
    assert err["code"] == code, err
    assert (len(list(d.glob("*"))) if d.exists() else 0) == before          # a refused file never stays on disk
    return err


def test_refusal_codes(ra, build, tmp_path, monkeypatch):
    good = copy_bytes(ra)
    refusal(ra, b"just some text, not a database at all", "not_sqlite")
    refusal(ra, b"", "not_sqlite")
    refusal(ra, b"SQLite format 3\x00" + b"\x00" * 200, "integrity_failed")                 # header only
    refusal(ra, good[: len(good) // 2], "integrity_failed")                                 # truncated
    refusal(ra, mutate(good, tmp_path, "INSERT INTO contacts (id, client_id, name) VALUES ('o1','ghost','Orphan')"),
            "integrity_failed")                                                              # FK violation
    refusal(ra, mutate(good, tmp_path, "UPDATE app_meta SET value='999' WHERE key='schema_version'"), "schema_newer")
    refusal(ra, mutate(good, tmp_path, "UPDATE app_meta SET value='prod' WHERE key='db.channel'"), "channel_mismatch")
    refusal(ra, mutate(good, tmp_path, "DELETE FROM app_meta WHERE key='db.channel'"), "no_channel_stamp")
    refusal(ra, mutate(good, tmp_path, "CREATE TRIGGER evil AFTER INSERT ON clients BEGIN DELETE FROM tasks; END"), "integrity_failed")
    other = tmp_path / "other.db"
    c = sqlite3.connect(other)
    c.execute("CREATE TABLE t(a)")
    c.commit()
    c.close()
    refusal(ra, other.read_bytes(), "not_sqlite")                                            # a SQLite file, not ours
    monkeypatch.setattr(DR, "MAX_DB_BYTES", 1000)
    refusal(ra, good, "too_large", status=413)
    monkeypatch.undo()
    monkeypatch.setattr(DR.shutil, "disk_usage", lambda p: shutil._ntuple_diskusage(10 * len(good), 0, 2 * len(good)))
    err = refusal(ra, good, "no_space")
    assert err["details"]["needed_bytes"] == 3 * len(good)
    monkeypatch.undo()
    # DEV database into the PROD app, and a mock-seeded one
    prod = build(prod=True)
    err = refusal(prod, good, "channel_mismatch")
    assert "production" in err["message"]
    assert accounts(ra) == ["Alpha Co", "Beta Co"]


def test_prod_database_into_dev_is_refused(build):
    dev = build()
    prod = build(prod=True)
    err = stage(dev, copy_bytes(prod), status=422)
    assert err["code"] == "channel_mismatch"


def test_inspect_leaves_the_live_database_untouched(ra, tmp_path):
    good = copy_bytes(ra)
    before = (live_sha(ra), accounts(ra), ra.sql("SELECT count(*) n FROM audit_events")[0]["n"], len(ra.rt.backups.list()))
    stage(ra, good)
    refusal(ra, b"garbage", "not_sqlite")
    ra.post(f"{DB}/from-backup", {"name": "missing.db"})
    after = (live_sha(ra), accounts(ra), ra.sql("SELECT count(*) n FROM audit_events")[0]["n"], len(ra.rt.backups.list()))
    assert before == after and leftovers(ra) == []


def test_older_schema_is_migrated_on_the_staged_copy_only(ra, tmp_path, monkeypatch):
    good = copy_bytes(ra)
    mig = tmp_path / "0002_test.sql"
    mig.write_text("CREATE TABLE zz_new (id INTEGER);\nUPDATE app_meta SET value='2' WHERE key='schema_version';\n")
    real = DR.migrate.discover
    monkeypatch.setattr(DR.migrate, "discover", lambda: real() + [(2, mig)])
    item = stage(ra, good)
    assert item["file"]["will_upgrade_from"] == 1 and item["file"]["schema_version"] == 2
    assert item["current"]["schema_version"] == 1
    assert not ra.sql("SELECT name FROM sqlite_master WHERE name='zz_new'")             # live DB not migrated
    go(ra, item)
    assert ra.sql("SELECT name FROM sqlite_master WHERE name='zz_new'")
    bad = tmp_path / "0002_bad.sql"
    bad.write_text("CREATE TABLE broken (;\n")
    monkeypatch.setattr(DR.migrate, "discover", lambda: real() + [(2, bad)])
    err = stage(ra, good, status=422)
    assert err["code"] == "migration_failed" and "nothing was changed" in err["message"]


# ------------------------------------------------------------------------------------------ fault injection
STEPS = ["after_gate", "after_backup", "before_checkpoint", "after_checkpoint", "after_copy", "after_rename_old",
         "before_replace", "after_replace", "after_verify"]


@pytest.mark.parametrize("step", STEPS)
def test_failure_at_each_step_leaves_the_original_and_the_app_serving(ra, step):
    snapshot = copy_bytes(ra)
    ra.mk_client("Gamma Co")
    original = accounts(ra)
    ra.rt.bams.activate()
    item = stage(ra, snapshot)

    def boom(*a):
        raise RuntimeError("injected at " + step)
    DR.HOOKS[step] = boom
    try:
        r = ra.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": "RESTORE"})
    finally:
        DR.HOOKS.clear()
    assert r.status_code == 500 and r.json()["error"]["code"] == "restore_failed", r.text
    d = r.json()["error"]["details"]
    assert d["state"] == "unchanged" and "not changed" in r.json()["error"]["message"]
    assert accounts(ra) == original and leftovers(ra) == []
    assert ra.get("/api/state").status_code == 200 and not ra.rt.gate.restoring and ra.rt.bams.active
    assert ra.rt.lock._fd is not None
    assert not ra.audit(action="restored", object_type="backup")
    go(ra, item)                                                    # the same staged session can be retried
    assert accounts(ra) == ["Alpha Co", "Beta Co"]


def test_failure_after_swap_with_missing_original_falls_back_to_the_safety_backup(ra):
    snapshot = copy_bytes(ra)
    ra.mk_client("Gamma Co")
    item = stage(ra, snapshot)
    live = ra.rt.config.db_path

    def lose_old(rt):
        live.with_name(live.name + ".pre-restore-old").unlink()
        raise RuntimeError("after the swap, original gone")
    DR.HOOKS["after_replace"] = lose_old
    try:
        r = ra.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": "RESTORE"})
    finally:
        DR.HOOKS.clear()
    err = r.json()["error"]
    assert r.status_code == 500 and err["details"]["state"] == "safety_backup" and err["details"]["backup"] in err["message"]
    assert accounts(ra) == ["Alpha Co", "Beta Co", "Gamma Co"] and leftovers(ra) == []
    assert ra.get("/api/state").status_code == 200


def test_windows_style_replace_retries(ra, monkeypatch):
    item = stage(ra, copy_bytes(ra))
    real = os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        if str(src).endswith(".restore-new") and Path(dst) == ra.rt.config.db_path and calls["n"] < 2:
            calls["n"] += 1
            raise PermissionError("file in use")
        return real(src, dst)
    monkeypatch.setattr(os, "replace", flaky)
    monkeypatch.setattr(DR, "_sleep", lambda s: None)
    go(ra, item)
    assert calls["n"] == 2 and accounts(ra) == ["Alpha Co", "Beta Co"]


def test_persistent_replace_failure_rolls_back(ra, monkeypatch):
    ra.mk_client("Gamma Co")
    item = stage(ra, copy_bytes(ra))
    real = os.replace
    tries = {"n": 0}

    def locked(src, dst):
        if str(src).endswith(".restore-new") and Path(dst) == ra.rt.config.db_path:
            tries["n"] += 1
            raise PermissionError("locked by another process")
        return real(src, dst)
    monkeypatch.setattr(os, "replace", locked)
    monkeypatch.setattr(DR, "_sleep", lambda s: None)
    r = ra.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": "RESTORE"})
    assert r.status_code == 500 and r.json()["error"]["details"]["state"] == "unchanged"
    assert tries["n"] == DR.REPLACE_TRIES and accounts(ra) == ["Alpha Co", "Beta Co", "Gamma Co"] and leftovers(ra) == []


# ------------------------------------------------------------------------------------------ startup recovery
def test_startup_recovery_after_a_crash_between_rename_and_replace(ra):
    ra.mk_client("Survivor Co")
    cfg = ra.rt.config
    live = cfg.db_path
    ra.rt.close()                                                   # the process "dies"
    old, new = live.with_name(live.name + ".pre-restore-old"), live.with_name(live.name + ".restore-new")
    os.replace(live, old)                                           # crash point: live renamed away, new not in place
    new.write_bytes(b"half written")
    (cfg.data_dir / "restore_tmp").mkdir(exist_ok=True)
    (cfg.data_dir / "restore_tmp" / "x.db").write_bytes(b"staged")
    rt2 = Runtime(cfg)
    try:
        with rt2.db() as conn:
            names = sorted(r[0] for r in conn.execute("SELECT name FROM clients"))
        assert "Survivor Co" in names and not old.exists() and not new.exists()
        assert not (cfg.data_dir / "restore_tmp").exists()
    finally:
        rt2.close()


def test_startup_recovery_cases(ra):
    cfg = ra.rt.config
    live = cfg.db_path
    ra.rt.close()
    old = live.with_name(live.name + ".pre-restore-old")
    shutil.copy(live, old)                                          # healthy live + leftover old: old is deleted
    DR.startup_recovery(cfg)
    assert live.exists() and not old.exists()
    good = live.read_bytes()
    old.write_bytes(good)
    live.write_bytes(b"SQLite format 3\x00" + b"\xff" * 4096)       # damaged live + intact old: old is put back
    DR.startup_recovery(cfg)
    assert DR.db_ok(live) and not old.exists()


# ------------------------------------------------------------------------------------------ gate
def test_gate_rejects_requests_while_restoring_but_health_answers(ra):
    item = stage(ra, copy_bytes(ra))
    seen = {}

    def probe(rt, name=None):
        r = ra.c.get("/api/state")
        seen["state"] = (r.status_code, r.json()["error"]["code"], r.headers.get("retry-after"))
        seen["post"] = ra.c.post("/api/client/save", json={"name": "Nope Co"}).status_code
        seen["health"] = ra.c.get("/api/health").json()
        seen["bams_active"] = rt.bams.active
        seen["static"] = ra.c.get("/").status_code
    DR.HOOKS["after_backup"] = probe
    try:
        go(ra, item)
    finally:
        DR.HOOKS.clear()
    assert seen["state"] == (503, "restoring", "2") and seen["post"] == 503
    assert seen["health"]["restoring"] is True and seen["bams_active"] is False and seen["static"] != 503
    assert ra.get("/api/state").status_code == 200 and not ra.sql("SELECT 1 FROM clients WHERE name='Nope Co'")


def test_apply_waits_for_in_flight_requests_then_proceeds(ra):
    item = stage(ra, copy_bytes(ra))
    assert ra.rt.gate.enter(False)                                  # a request is "in flight"
    t = threading.Timer(0.4, lambda: ra.rt.gate.leave(False))
    t.start()
    t0 = time.monotonic()
    go(ra, item)
    t.join()
    assert time.monotonic() - t0 >= 0.3 and accounts(ra) == ["Alpha Co", "Beta Co"]


def test_apply_gives_up_when_requests_never_drain(ra, monkeypatch):
    item = stage(ra, copy_bytes(ra))
    ra.mk_client("Gamma Co")
    monkeypatch.setattr(DR, "DRAIN_SECONDS", 0.4)
    assert ra.rt.gate.enter(False)
    try:
        r = ra.post(f"{DB}/apply", {"restore_id": item["restore_id"], "confirm": "RESTORE"})
    finally:
        ra.rt.gate.leave(False)
    assert r.status_code == 500 and r.json()["error"]["details"]["state"] == "unchanged"
    assert not ra.rt.gate.restoring and "Gamma Co" in accounts(ra)
    assert ra.get("/api/state").status_code == 200


def test_restore_with_concurrent_writers_keeps_the_database_sound(ra):
    item = stage(ra, copy_bytes(ra))
    stop = threading.Event()
    codes = []

    def writer():
        i = 0
        while not stop.is_set():
            i += 1
            codes.append(ra.c.post("/api/client/save", json={"name": f"W{i}", "duplicates_confirmed": True}).status_code)
    th = threading.Thread(target=writer)
    th.start()
    time.sleep(0.15)
    go(ra, item)
    time.sleep(0.15)
    stop.set()
    th.join()
    assert set(codes) <= {200, 503} and 503 in codes or set(codes) <= {200, 503}
    with ra.rt.db() as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    assert {"Alpha Co", "Beta Co"} <= set(accounts(ra)) and leftovers(ra) == []


def test_from_backup_writes_nothing_beside_the_backup(ra):
    """QA-7-1"""
    with ra.rt.db() as conn:
        name = ra.rt.backups.create(conn, "manual")["name"]
    d = ra.rt.backups.backup_dir
    before = sorted(p.name for p in d.iterdir())
    sha = hashlib.sha256((d / name).read_bytes()).hexdigest()
    item = ra.post(f"{DB}/from-backup", {"name": name}).json()["item"]
    assert sorted(p.name for p in d.iterdir()) == before and hashlib.sha256((d / name).read_bytes()).hexdigest() == sha
    go(ra, item)
    assert sorted(p.name for p in d.iterdir() if "-wal" in p.name or "-shm" in p.name) == []
    assert not [n for n in before if n.endswith(("-wal", "-shm"))]
