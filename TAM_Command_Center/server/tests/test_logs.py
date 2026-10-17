"""Application log download and weekly cleanup (contract section 18.4)."""
from __future__ import annotations

import datetime as dt
import io
import logging
import os
import zipfile

import pytest

from server import logsetup as L
from server.tests.conftest import Api, make_config
from server.app import create_app
from fastapi.testclient import TestClient

NOW = dt.datetime(2026, 10, 16, 12, 0, 0)


def touch(p, size=10, age_days=0):
    p.write_bytes(b"x" * size)
    t = (NOW - dt.timedelta(days=age_days)).timestamp()
    os.utime(p, (t, t))
    return p


@pytest.fixture
def lg(build):
    return build()


def logdir(api):
    return api.rt.config.log_dir


# ------------------------------------------------------------------------------------------ download
def test_zip_contains_current_and_rotated_logs_only(lg):
    d = logdir(lg)
    logging.getLogger("tam.test").info("hello-line-123")
    touch(d / "tam_command_center.log.1", 20)
    touch(d / "tam_command_center.log.2", 30)
    (d / "notes.txt").write_text("not a log")
    (d / L.STAMP_NAME).write_text("2026-10-01T00:00:00")
    (d / "sub").mkdir(exist_ok=True)
    (d / "sub" / "tam_command_center.log").write_text("other database")
    (lg.rt.config.db_path.parent / "decoy.db").write_bytes(b"SQLite format 3\x00")
    r = lg.get("/api/logs/download")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip" and r.headers["cache-control"] == "no-store"
    assert r.headers["content-disposition"].startswith('attachment; filename="tam_logs_') and r.headers["content-disposition"].endswith('.zip"')
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.namelist() == ["tam_command_center.log", "tam_command_center.log.1", "tam_command_center.log.2"]
    assert b"hello-line-123" in z.read("tam_command_center.log") and r.headers["x-log-files-omitted"] == "0"
    assert not any(n.endswith((".db", ".txt", ".stamp")) for n in z.namelist())


def test_current_file_download_and_audit_untouched(lg):
    logging.getLogger("tam.test").info("current-marker-77")
    n = lg.sql("SELECT count(*) n FROM audit_events")[0]["n"]
    r = lg.get("/api/logs/download", file="current")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain") and b"current-marker-77" in r.content
    assert r.headers["content-disposition"].startswith('attachment; filename="tam_command_center_')
    assert lg.sql("SELECT count(*) n FROM audit_events")[0]["n"] == n


def test_no_path_parameters_and_bad_values_refused(lg):
    for bad in ("../etc/passwd", "tam_command_center.log.1", "/etc/passwd", "all", ""):
        assert lg.get("/api/logs/download", file=bad).status_code == 422, bad
    assert lg.c.get("/api/logs/download?path=/etc").status_code == 200        # unknown params are ignored, never used


def test_symlinks_and_dirs_are_not_followed(lg, tmp_path):
    d = logdir(lg)
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET")
    try:
        os.symlink(secret, d / "tam_command_center.log.3")
    except OSError:
        pytest.skip("symlinks unavailable")
    (d / "tam_command_center.log.4").mkdir()
    z = zipfile.ZipFile(io.BytesIO(lg.get("/api/logs/download").content))
    assert "tam_command_center.log.3" not in z.namelist() and "tam_command_center.log.4" not in z.namelist()
    assert all(b"TOP SECRET" not in z.read(n) for n in z.namelist())


def test_size_cap_drops_oldest_rotated_but_keeps_current(lg, monkeypatch):
    d = logdir(lg)
    for i in range(1, 4):
        touch(d / f"tam_command_center.log.{i}", 1000)
    monkeypatch.setattr(L, "LOG_FOLDER_CAP", 2500)
    data, omitted = L.build_zip(d, cap=2500)
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert names[0] == "tam_command_center.log" and omitted >= 1 and "tam_command_center.log.3" not in names
    r = lg.get("/api/logs/download")
    assert r.status_code == 200


def test_empty_folder_gives_an_empty_zip(lg):
    for p in logdir(lg).iterdir():
        if p.is_file():
            p.unlink()
    r = lg.get("/api/logs/download")
    assert r.status_code == 200 and zipfile.ZipFile(io.BytesIO(r.content)).namelist() == []
    assert lg.get("/api/logs/download", file="current").content == b""


def test_named_database_downloads_only_its_own_folder(tmp_path):
    cfg_a = make_config(tmp_path, prod=True, port=8791)
    app = create_app(cfg_a)
    a = Api(TestClient(app, base_url="http://127.0.0.1:8791", raise_server_exceptions=False), app.state.runtime)
    touch(a.rt.config.log_dir / "tam_command_center.log.1", 5)
    a.rt.close()
    cfg_b = make_config(tmp_path, prod=True, port=8792, extra_env={"TAM_DB_NAME": "tam_fresh"})
    app = create_app(cfg_b)
    b = Api(TestClient(app, base_url="http://127.0.0.1:8792", raise_server_exceptions=False), app.state.runtime)
    try:
        names = zipfile.ZipFile(io.BytesIO(b.get("/api/logs/download").content)).namelist()
        assert "tam_command_center.log.1" not in names and b.rt.config.log_dir.name == "tam_fresh"
    finally:
        b.rt.close()


# ------------------------------------------------------------------------------------------ cleanup
def test_cleanup_deletes_rotated_older_than_seven_days_only(tmp_path):
    cur = touch(tmp_path / "tam_command_center.log", 50, age_days=30)           # old but CURRENT: kept
    new1 = touch(tmp_path / "tam_command_center.log.1", 10, age_days=6)
    old2 = touch(tmp_path / "tam_command_center.log.2", 10, age_days=8)
    old3 = touch(tmp_path / "tam_command_center.log.3", 10, age_days=40)
    other = touch(tmp_path / "audit_export.csv", 10, age_days=90)               # not a log file: untouched
    stamp = touch(tmp_path / L.STAMP_NAME, 5, age_days=90)
    sub = tmp_path / "other_db"
    sub.mkdir()
    sub_log = touch(sub / "tam_command_center.log.1", 10, age_days=90)          # another database's folder: untouched
    res = L.cleanup_logs(tmp_path, NOW)
    assert res["removed"] == 2 and res["kept"] == 2
    assert cur.exists() and new1.exists() and not old2.exists() and not old3.exists()
    assert other.exists() and stamp.exists() and sub_log.exists()


def test_cleanup_cap_deletes_oldest_first_never_current(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "LOG_FOLDER_CAP", 250)
    cur = touch(tmp_path / "tam_command_center.log", 100)
    a = touch(tmp_path / "tam_command_center.log.1", 100, age_days=1)
    b = touch(tmp_path / "tam_command_center.log.2", 100, age_days=3)
    c = touch(tmp_path / "tam_command_center.log.3", 100, age_days=5)
    L.cleanup_logs(tmp_path, NOW)
    assert cur.exists() and a.exists() and not b.exists() and not c.exists()
    monkeypatch.setattr(L, "LOG_FOLDER_CAP", 10)                                  # even an impossible cap keeps the current file
    L.cleanup_logs(tmp_path, NOW)
    assert cur.exists() and not a.exists()


def test_cleanup_logs_one_summary_line(tmp_path, caplog):
    touch(tmp_path / "tam_command_center.log", 10)
    touch(tmp_path / "tam_command_center.log.1", 2048, age_days=10)
    with caplog.at_level(logging.INFO, logger="tam.logs"):
        L.cleanup_logs(tmp_path, NOW)
    msgs = [r.getMessage() for r in caplog.records if r.name == "tam.logs"]
    assert msgs == ["log cleanup: removed 1 files (2 KiB), kept 1"]


def test_huge_current_file_is_rotated_first(lg):
    d = logdir(lg)
    cur = d / "tam_command_center.log"
    with open(cur, "ab") as fh:
        fh.write(b"y" * (L.LOG_ROTATE_BEFORE_CLEANUP + 10))
    L.cleanup_logs(d, NOW + dt.timedelta(seconds=1))
    assert cur.exists() and cur.stat().st_size < L.LOG_ROTATE_BEFORE_CLEANUP        # a fresh current file
    assert (d / "tam_command_center.log.1").exists()


def test_weekly_cadence_with_injected_clock(tmp_path):
    touch(tmp_path / "tam_command_center.log", 10)
    old = touch(tmp_path / "tam_command_center.log.1", 10, age_days=20)
    assert L.weekly_cleanup(tmp_path, NOW)["removed"] == 1 and not old.exists()
    again = touch(tmp_path / "tam_command_center.log.1", 10, age_days=20)
    assert L.weekly_cleanup(tmp_path, NOW + dt.timedelta(days=3)) is None and again.exists()      # not yet a week
    assert L.weekly_cleanup(tmp_path, NOW + dt.timedelta(days=7))["removed"] == 1 and not again.exists()


def test_cleanup_never_touches_the_audit_log(lg):
    lg.mk_client("A")
    n = lg.sql("SELECT count(*) n FROM audit_events")[0]["n"]
    L.weekly_cleanup(logdir(lg), NOW + dt.timedelta(days=400))
    assert lg.sql("SELECT count(*) n FROM audit_events")[0]["n"] == n and n > 0


def test_cleanup_failure_is_swallowed(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "cleanup_logs", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    assert L.weekly_cleanup(tmp_path, NOW) is None
