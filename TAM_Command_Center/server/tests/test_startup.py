"""T-10: modes, ports, isolation, lock, loopback, CORS/Host/Origin, logging, migration with backup."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from server import constants as C
from server.config import load_config
from server.errors import BackupFailed, StartupRefused
from server.locking import InstanceLock

from .conftest import ROOT, add_route, make_config


# ------------------------------------------------------------------ modes and isolation (US-1.2)
def test_dev_channel_build_refuses_prod_mode_in_process(tmp_path):
    root = tmp_path / "app"
    root.mkdir()
    (root / "VERSION.txt").write_text("channel=dev\n")
    with pytest.raises(StartupRefused, match="refuses to run in PROD mode"):
        load_config({"LOCALAPPDATA": str(tmp_path)}, app_root=root)


def test_dev_channel_build_refuses_prod_mode_real_process(tmp_path):
    """[§52] a DEV-channel build started without TAM_DEV_MODE=1 exits non-zero with a clear message."""
    env = {k: v for k, v in os.environ.items() if k not in ("TAM_DEV_MODE", "TAM_PORT")}
    env["LOCALAPPDATA"] = str(tmp_path)
    p = subprocess.run([sys.executable, "-m", "server"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode != 0
    assert "TAM_DEV_MODE=1" in p.stderr and "refuses to run in PROD mode" in p.stderr
    assert not (tmp_path / "TAM_Command_Center").exists()          # nothing was created for PROD


def test_prod_build_ignores_test_flags_and_has_separate_paths(tmp_path):
    cfg = make_config(tmp_path, prod=True, extra_env={"TAM_DEV_MODE": "1", "TAM_BAMS_TEST_MODE": "1"})
    assert cfg.mode == "PROD" and cfg.channel == "prod" and cfg.port == 8791
    assert any("TAM_DEV_MODE" in n for n in cfg.notes) and any("TAM_BAMS_TEST_MODE" in n for n in cfg.notes)
    assert cfg.db_path.name == "tam_command_center.db" and "dev_data" not in str(cfg.db_path)
    dev = make_config(tmp_path / "other")
    assert dev.db_path.name == "tam_dev.db" and dev.db_path.resolve() != cfg.db_path.resolve()
    assert dev.host == "127.0.0.1" == cfg.host


def test_default_ports(tmp_path):
    env = {"TAM_DEV_MODE": "1", "LOCALAPPDATA": str(tmp_path)}
    root = tmp_path / "a"
    root.mkdir()
    assert load_config(env, app_root=root).port == C.DEV_PORT == 8766
    (root / "VERSION.txt").write_text("channel=prod\n")
    assert load_config({"LOCALAPPDATA": str(tmp_path)}, app_root=root).port == C.PROD_PORT == 8765


def test_bad_port_rejected(tmp_path):
    with pytest.raises(StartupRefused):
        make_config(tmp_path, extra_env={"TAM_PORT": "80"})
    with pytest.raises(StartupRefused):
        make_config(tmp_path, extra_env={"TAM_PORT": "abc"})


def test_dev_routes_absent_in_prod_present_in_dev(build):
    prod = build(prod=True)
    assert prod.post("/api/dev/reseed", {"confirm": True}).status_code == 404
    assert prod.get("/openapi.json").status_code == 404
    assert prod.get("/api/health").json()["mode"] == "PROD"


def test_dev_has_dev_route(api):
    assert api.get("/api/health").json()["mode"] == "DEV"
    api.err("/api/dev/reseed", {}, 409, "confirmation_required")
    assert api.get("/openapi.json").status_code == 200


# ------------------------------------------------------------------ single instance (US-1.3)
def test_second_lock_on_same_db_is_refused_with_pid_and_port(api):
    other = InstanceLock(api.rt.config.lock_path)
    with pytest.raises(StartupRefused) as ei:
        other.acquire(9999)
    msg = str(ei.value)
    assert f"Another TAM Command Center instance (PID {os.getpid()}, port 8791) is using this database." == msg
    assert ei.value.exit_code == 2


def test_lock_released_on_close(build, tmp_path):
    a = build()
    path = a.rt.config.lock_path
    a.rt.close()
    lock = InstanceLock(path)
    lock.acquire(1234)          # now free
    lock.release()


_CHILD = """
import sys
from pathlib import Path
sys.path.insert(0, {root!r})
from server.config import load_config
from server.app import create_app
from server.errors import StartupRefused
env = {{"TAM_DEV_MODE": "1", "TAM_DEV_SEED": "0", "TAM_PORT": {port!r}, "LOCALAPPDATA": {lad!r}}}
cfg = load_config(env, app_root=Path({app!r}))
try:
    app = create_app(cfg)
except StartupRefused as e:
    print(e, file=sys.stderr); sys.exit(e.exit_code)
import uvicorn
uvicorn.run(app, host=cfg.host, port=cfg.port, log_config=None, access_log=False)
"""


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _spawn(tmp_path, port):
    app = tmp_path / "proc_app"
    app.mkdir(exist_ok=True)
    (app / "VERSION.txt").write_text("channel=dev\n")
    code = _CHILD.format(root=str(ROOT), port=str(port), lad=str(tmp_path / "lad"), app=str(app))
    return subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _wait_up(port, proc, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise AssertionError(f"server exited early: {proc.stderr.read()}")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return
        except OSError:
            time.sleep(0.2)
    raise AssertionError("server did not start")


def test_real_servers_loopback_only_and_second_process_blocked(tmp_path):
    """[§52] second process on the same DB fails fast; the server accepts loopback only."""
    import urllib.request
    port = _free_port()
    p1 = _spawn(tmp_path, port)
    try:
        _wait_up(port, p1)
        body = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5).read()
        assert b'"ok":true' in body
        # --- bound to loopback only: connecting through a non-loopback address of this host is refused
        lan = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("192.0.2.1", 9))
            lan = s.getsockname()[0]
            s.close()
        except OSError:
            pass
        if lan and not lan.startswith("127."):
            with pytest.raises(OSError):
                socket.create_connection((lan, port), timeout=2)
        # --- second process, same DB (different port) exits fast naming the holder
        p2 = _spawn(tmp_path, _free_port())
        out, err = p2.communicate(timeout=30)
        assert p2.returncode == 2
        assert f"Another TAM Command Center instance (PID {p1.pid}, port {port}) is using this database." in err
    finally:
        p1.terminate()
        p1.wait(timeout=10)


# ------------------------------------------------------------------ DB open / migration (US-1.4)
def test_fresh_db_wal_fk_schema_version(api):
    with api.rt.db() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == "1"
        assert conn.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()[0] == "dev"
    assert api.get("/api/health").json()["schema_version"] == 1
    mig = api.audit(object_type="schema", action="migrated")
    assert len(mig) == 1 and mig[0]["source"] == "Migration"


def test_restart_is_noop_no_backup_no_audit(build, tmp_path):
    a = build()
    a.rt.close()
    cfg = a.rt.config
    from server.app import create_app
    app2 = create_app(cfg)
    try:
        assert app2.state.runtime.startup_result["applied"] == []
        assert app2.state.runtime.startup_result["backup"] is None
        assert not any(cfg.backup_dir.iterdir())
        with app2.state.runtime.db() as conn:
            assert conn.execute("SELECT count(*) FROM audit_events WHERE action='migrated'").fetchone()[0] == 1
    finally:
        app2.state.runtime.close()


def test_prod_refuses_dev_db_and_dev_refuses_prod_db(tmp_path):
    from server.app import create_app
    dev_cfg = make_config(tmp_path / "x")
    dev_app = create_app(dev_cfg)
    dev_app.state.runtime.close()
    # copy the DEV-stamped DB to where a PROD build would look: PROD must refuse to open it
    prod_cfg = make_config(tmp_path / "y", prod=True)
    prod_cfg.db_path.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite_copy(dev_cfg.db_path, prod_cfg.db_path)
    with pytest.raises(StartupRefused, match="channel"):
        create_app(prod_cfg)
    assert src.exists()


def sqlite_copy(src: Path, dst: Path) -> Path:
    import sqlite3
    a = sqlite3.connect(src)
    b = sqlite3.connect(dst)
    a.backup(b)
    a.close()
    b.close()
    return dst


def test_pre_migration_backup_then_migrate(tmp_path, monkeypatch):
    """An existing v1 DB + a pending migration -> online backup first, then migration, then audit row."""
    from server.app import create_app
    from server.dbkit import migrate
    cfg = make_config(tmp_path)
    create_app(cfg).state.runtime.close()                          # DB at v1
    mdir = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, mdir)
    (mdir / "0002_probe.sql").write_text(
        "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY);\n"
        "INSERT INTO app_meta(key, value) VALUES ('schema_version', '2') "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n")
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", mdir)
    app = create_app(cfg)
    try:
        res = app.state.runtime.startup_result
        assert res["from"] == 1 and res["to"] == 2 and res["applied"] == ["0002_probe.sql"]
        backups = list(cfg.backup_dir.glob("tam_*_pre-migration_v1.db"))
        assert len(backups) == 1 and res["backup"].endswith(backups[0].name)
        import sqlite3
        c = sqlite3.connect(backups[0])
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert c.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == "1"
        c.close()
        with app.state.runtime.db() as conn:
            assert conn.execute("SELECT count(*) FROM audit_events WHERE action='migrated'").fetchone()[0] == 2
    finally:
        app.state.runtime.close()


def test_pre_migration_backup_failure_aborts_migration(tmp_path, monkeypatch):
    from server.app import create_app
    from server.backups import BackupService
    from server.dbkit import migrate
    cfg = make_config(tmp_path)
    create_app(cfg).state.runtime.close()
    mdir = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, mdir)
    (mdir / "0002_probe.sql").write_text(
        "CREATE TABLE probe (id INTEGER PRIMARY KEY);\n"
        "INSERT INTO app_meta(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n")
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", mdir)

    def boom(self, conn, reason):
        raise BackupFailed("disk full")
    monkeypatch.setattr(BackupService, "create", boom)
    with pytest.raises(BackupFailed):
        create_app(cfg)
    import sqlite3
    c = sqlite3.connect(cfg.db_path)
    assert c.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0] == "1"
    assert c.execute("SELECT 1 FROM sqlite_master WHERE name='probe'").fetchone() is None
    c.close()


def test_dev_new_db_is_seeded_prod_is_not(build):
    dev = build(seed=True)
    assert dev.sql("SELECT count(*) AS n FROM clients")[0]["n"] == 12
    prod = build(prod=True)
    assert prod.sql("SELECT count(*) AS n FROM clients")[0]["n"] == 0


# ------------------------------------------------------------------ security headers / host / origin / CORS
def test_host_and_origin_guards(api):
    r = api.c.get("/api/health", headers={"Host": "evil.example.com"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_origin"
    r = api.c.post("/api/data/backup", json={}, headers={"Origin": "http://evil.example.com"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_origin"
    # same-origin and the Vite dev origin are allowed
    assert api.c.post("/api/data/backup", json={}, headers={"Origin": "http://127.0.0.1:8791"}).status_code == 200
    assert api.c.post("/api/data/backup", json={}, headers={"Origin": "http://localhost:5173"}).status_code == 200


def test_cors_only_for_dev_origin_and_not_in_prod(build):
    dev = build()
    r = dev.c.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
    r = dev.c.get("/api/health", headers={"Origin": "http://evil.example.com"})
    assert "access-control-allow-origin" not in r.headers
    prod = build(prod=True)
    r = prod.c.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in r.headers
    assert prod.c.post("/api/data/backup", json={}, headers={"Origin": "http://localhost:5173"}).status_code == 403


def test_nosniff_and_no_store(api):
    r = api.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["cache-control"] == "no-store"


# ------------------------------------------------------------------ logging (US-1.7)
def test_startup_logs_mode_version_db_schema_migration(api):
    text = "\n".join(api.get("/api/logs/recent", limit=200).json()["lines"])
    for needle in ("mode=DEV", "0.1.0-test", "database:", "schema migration result", "'applied': ['0001_initial.sql']"):
        assert needle in text, needle


def test_logs_recent_limit_validation(api):
    assert api.get("/api/logs/recent", limit=0).status_code == 422
    assert api.get("/api/logs/recent", limit=1001).status_code == 422
    assert len(api.get("/api/logs/recent", limit=3).json()["lines"]) <= 3


def _disconnect_errors():
    e1 = BrokenPipeError(32, "Broken pipe")
    e2 = ConnectionResetError(104, "reset")
    e3 = ConnectionAbortedError(103, "aborted")
    e4 = OSError(10054, "forcibly closed")
    e4.winerror = 10054
    e5 = OSError(10053, "aborted")
    e5.winerror = 10053
    return [e1, e2, e3, e4, e5]


def test_disconnect_errors_are_one_debug_line_no_traceback(api):
    import logging
    api.ok("/api/settings/save", {"settings": {"log_level": "DEBUG"}})
    for exc in _disconnect_errors():
        try:
            raise exc
        except OSError:
            logging.getLogger("asyncio").error("Exception in callback", exc_info=True)
    lines = api.get("/api/logs/recent", limit=1000).json()["lines"]
    text = "\n".join(lines)
    assert "Traceback" not in text
    assert "ERROR asyncio" not in text
    conn_lines = [ln for ln in lines if "tam.connection" in ln]
    assert len(conn_lines) == 5 and all(" DEBUG " in ln for ln in conn_lines)


def test_disconnect_in_route_does_not_log_error(api):
    def boom():
        raise ConnectionResetError(104, "Connection reset by peer")
    add_route(api, "/api/_boom", boom)
    r = api.get("/api/_boom")
    assert r.status_code == 499
    lines = api.get("/api/logs/recent", limit=1000).json()["lines"]
    assert not any("Traceback" in ln or " ERROR " in ln for ln in lines)


def test_real_errors_are_still_logged_with_traceback(api):
    def oops():
        raise RuntimeError("kaboom")
    add_route(api, "/api/_oops", oops)
    r = api.get("/api/_oops")
    assert r.status_code == 500 and r.json()["error"]["code"] == "internal"
    assert "kaboom" not in r.text                         # no internals in the response
    text = "\n".join(api.get("/api/logs/recent", limit=1000).json()["lines"])
    assert "ERROR tam.api: unhandled error" in text and "kaboom" in text


def test_log_level_setting_applied(api):
    import logging
    api.ok("/api/settings/save", {"settings": {"log_level": "DEBUG"}})
    assert logging.getLogger().level == logging.DEBUG
    api.ok("/api/settings/save", {"settings": {"log_level": "INFO"}})
    assert logging.getLogger().level == logging.INFO
