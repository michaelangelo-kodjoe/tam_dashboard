"""TAM_DB_NAME: choose or create a named database; the default stays untouched; per-database lock, backups, staging."""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.config import load_config
from server.errors import StartupRefused
from server.runtime import Runtime
from server.tests.conftest import Api, make_config

BAD = ["", "  ", "a b", "a.b", "a/b", "a\\b", "..", "../x", "x..", "tam.db", "a" * 41, "né", "x;y", "con", "NUL", "Com1",
       "lpt9", "aux", "prn", "C:", "a\x00b", "%LOCALAPPDATA%", "~"]
GOOD = ["tam_fresh", "A-b_9", "x", "a" * 40, "tam_command_center", "Fresh2"]


def cfg(tmp_path, name=None, prod=True, port=8791, seed=False):
    extra = {"TAM_DB_NAME": name} if name is not None else {}
    return make_config(tmp_path, prod=prod, seed=seed, port=port, extra_env=extra)


@pytest.mark.parametrize("name", [b for b in BAD if b.strip()])
def test_invalid_names_are_refused(tmp_path, name):
    with pytest.raises(StartupRefused):
        cfg(tmp_path, name)


def test_blank_name_means_default(tmp_path):
    assert cfg(tmp_path, "  ").db_path.name == "tam_command_center.db"


@pytest.mark.parametrize("name", GOOD)
def test_valid_names_resolve_inside_the_data_folder(tmp_path, name):
    for prod in (True, False):
        if not prod and name == "tam_command_center":
            continue                                                   # DEV may never use the PROD name
        c = cfg(tmp_path, name, prod=prod)
        assert c.db_path.name == f"{name}.db" and c.db_path.parent == c.data_dir and c.db_name == name
    assert cfg(tmp_path, None).db_name == "tam_command_center" and cfg(tmp_path, None, prod=False).db_name == "tam_dev"


def test_dev_refuses_the_production_db_name(tmp_path):
    with pytest.raises(StartupRefused):
        cfg(tmp_path, "tam_command_center", prod=False)


def test_default_keeps_original_folders_named_gets_its_own(tmp_path):
    d, n = cfg(tmp_path), cfg(tmp_path, "tam_fresh")
    assert d.backup_dir.name == "TAM_Backups" and not d.named_db and d.restore_tmp.name == "restore_tmp" and d.log_dir.name == "logs"
    assert n.backup_dir == d.backup_dir / "tam_fresh" and n.log_dir == d.log_dir / "tam_fresh"
    assert n.restore_tmp.name == "restore_tmp_tam_fresh" and n.lock_path.name == "tam_fresh.db.lock"
    assert d.lock_path != n.lock_path


def _client(config):
    app = create_app(config)
    return Api(TestClient(app, base_url=f"http://127.0.0.1:{config.port}", raise_server_exceptions=False), app.state.runtime), app


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_new_name_creates_an_empty_database_and_leaves_the_default_untouched(tmp_path):
    api, app = _client(cfg(tmp_path))
    api.mk_client("Existing Co")
    default = api.rt.config.db_path
    with api.rt.db() as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    before = sha(default)
    api.rt.close()
    api2, app2 = _client(cfg(tmp_path, "tam_fresh"))
    try:
        assert api2.rt.config.db_path.name == "tam_fresh.db" and api2.rt.config.db_path.exists()
        assert api2.sql("SELECT count(*) n FROM clients")[0]["n"] == 0
        assert api2.sql("SELECT value v FROM app_meta WHERE key='db.channel'")[0]["v"] == "prod"
        assert not api2.sql("SELECT 1 FROM app_meta WHERE key LIKE 'db.mock%'")
        api2.mk_client("Fresh Co")
        st = api2.get("/api/state").json()
        assert st["runtime"]["db_name"] == "tam_fresh" and api2.get("/api/health").json()["db_name"] == "tam_fresh"
    finally:
        api2.rt.close()
    assert sha(default) == before                                     # the existing database was not touched
    api3, _ = _client(cfg(tmp_path))                                   # and still holds its own data
    try:
        assert [r["name"] for r in api3.sql("SELECT name FROM clients")] == ["Existing Co"]
        assert api3.get("/api/state").json()["runtime"]["db_name"] == "tam_command_center"
    finally:
        api3.rt.close()


def test_reopening_a_name_uses_the_existing_file_and_never_overwrites(tmp_path):
    api, _ = _client(cfg(tmp_path, "keepme"))
    api.mk_client("Kept Co")
    api.rt.close()
    api2, _ = _client(cfg(tmp_path, "keepme"))
    try:
        assert [r["name"] for r in api2.sql("SELECT name FROM clients")] == ["Kept Co"]
    finally:
        api2.rt.close()


def test_each_database_has_its_own_lock_and_ports_conflict_plainly(tmp_path):
    a = Runtime(cfg(tmp_path, "db_a", port=8791))
    try:
        b = Runtime(cfg(tmp_path, "db_b", port=8792))                  # different DB: both can run
        b.close()
        with pytest.raises(StartupRefused) as e:
            Runtime(cfg(tmp_path, "db_a", port=8793))                  # same DB: refused by the instance lock
        assert e.value.exit_code == 2 and "using this database" in str(e.value)
    finally:
        a.close()
    import socket
    from server.__main__ import _check_port
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    busy = cfg(tmp_path, "db_c", port=s.getsockname()[1])
    try:
        with pytest.raises(StartupRefused) as e:
            _check_port(busy)
        assert e.value.exit_code == 5 and "TAM_PORT" in str(e.value) and "db_c" in str(e.value)
    finally:
        s.close()


def test_backups_are_per_database_and_the_default_stays_visible(tmp_path):
    api, _ = _client(cfg(tmp_path))
    with api.rt.db() as conn:
        d1 = api.rt.backups.create(conn, "manual")["name"]
    api.rt.close()
    api2, _ = _client(cfg(tmp_path, "tam_fresh"))
    try:
        with api2.rt.db() as conn:
            n1 = api2.rt.backups.create(conn, "manual")["name"]
        assert [b["name"] for b in api2.rt.backups.list()] == [n1]
        assert api2.rt.config.backup_dir.parent.name == "TAM_Backups"
        assert (api2.rt.config.backup_dir.parent / d1).exists() and d1 not in [b["name"] for b in api2.rt.backups.list()]
        assert api2.get("/api/data/backups").json()["items"][0]["name"] == n1
    finally:
        api2.rt.close()
    api3, _ = _client(cfg(tmp_path))
    try:
        assert [b["name"] for b in api3.rt.backups.list()] == [d1]        # default list unchanged, no sub-folder entries
    finally:
        api3.rt.close()


def test_database_restore_works_for_a_named_database_and_stays_in_its_own_folders(tmp_path):
    api, _ = _client(cfg(tmp_path, "tam_fresh"))
    try:
        api.mk_client("Alpha Co")
        snap = api.get("/api/export/database").content
        api.mk_client("Beta Co")
        r = api.c.post("/api/restore/database/inspect", content=snap, headers={"X-File-Name": "s.db"})
        assert r.status_code == 200, r.text
        item = r.json()["item"]
        assert (api.rt.config.data_dir / "restore_tmp_tam_fresh").is_dir() and not (api.rt.config.data_dir / "restore_tmp").exists()
        api.ok("/api/restore/database/apply", {"restore_id": item["restore_id"], "confirm": "RESTORE"})
        assert [r["name"] for r in api.sql("SELECT name FROM clients")] == ["Alpha Co"]
        assert api.rt.config.db_path.name == "tam_fresh.db"
        assert list(api.rt.config.backup_dir.glob("*pre-restore*"))
        siblings = [p.name for p in api.rt.config.data_dir.iterdir()]
        assert "tam_command_center.db" not in siblings
    finally:
        api.rt.close()


def test_startup_log_names_the_database(tmp_path, caplog):
    import logging
    with caplog.at_level(logging.INFO, logger="tam"):
        rt = Runtime(cfg(tmp_path, "tam_fresh"))
        rt.close()
    assert any("name: tam_fresh" in r.getMessage() and "TAM_DB_NAME" in r.getMessage() for r in caplog.records)
