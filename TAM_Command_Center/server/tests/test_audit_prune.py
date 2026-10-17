"""Audit log retention: every 14 days delete audit entries older than 14 days (schema 2 guard + scheduler)."""
from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from server import auditprune as AP
from server.runtime import Runtime
from server.tests.conftest import Api, make_config

UTC = dt.timezone.utc


def real_now():
    return dt.datetime.now(UTC)


def stamp(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def put(api, days_ago, label="x"):
    api.exec("INSERT INTO audit_events (timestamp, category, object_type, object_id, object_label, action, source)"
             " VALUES (?, 'crm', 'task', 't', ?, 'created', 'GUI')", (stamp(real_now() - dt.timedelta(days=days_ago)), label))


def count(api):
    return api.sql("SELECT count(*) n FROM audit_events")[0]["n"]


def test_first_start_only_sets_the_anchor_and_prunes_nothing(build):
    api = build()
    put(api, 100, "ancient")
    t0 = real_now()
    assert AP.run_scheduled(api.rt, t0) is None
    assert api.sql("SELECT value v FROM app_meta WHERE key = ?", (AP.ANCHOR_KEY,))[0]["v"] == stamp(t0)
    assert api.sql("SELECT 1 FROM audit_events WHERE object_label='ancient'")                      # nothing deleted at first start
    st = api.get("/api/audit").json()["retention"]
    assert st["retention_days"] == 14 and st["last_pruned_at"] is None and st["next_due_at"] == stamp(t0 + dt.timedelta(days=14))


def test_cadence_with_injected_clock_and_exactly_one_audit_event(build):
    api = build()
    t0 = real_now()
    AP.run_scheduled(api.rt, t0)
    put(api, 40, "old1"); put(api, 15, "old2"); put(api, 13, "recent1"); put(api, 1, "recent2")
    before = count(api)
    assert AP.run_scheduled(api.rt, t0 + dt.timedelta(days=13, hours=23)) is None                  # not yet due
    assert count(api) == before
    res = AP.run_scheduled(api.rt, t0 + dt.timedelta(days=14))
    assert res["removed"] >= 2
    labels = {r["object_label"] for r in api.sql("SELECT object_label FROM audit_events")}
    assert {"recent1", "recent2"} <= labels and not ({"old1", "old2"} & labels)
    ev = api.sql("SELECT * FROM audit_events WHERE action='pruned'")
    assert len(ev) == 1 and ev[0]["category"] == "system" and ev[0]["source"] == "System" and ev[0]["object_type"] == "schema"
    assert ev[0]["reason"] == f"pruned {res['removed']} entries older than 14 days"
    assert AP.run_scheduled(api.rt, t0 + dt.timedelta(days=20)) is None                            # next cycle starts at the run
    st = api.get("/api/audit").json()["retention"]
    assert st["last_pruned_at"] == stamp(t0 + dt.timedelta(days=14)) and st["next_due_at"] == stamp(t0 + dt.timedelta(days=28))
    assert api.get("/api/audit/facets").json()["retention"] == st
    assert AP.run_scheduled(api.rt, t0 + dt.timedelta(days=28))["removed"] == 0
    assert len(api.sql("SELECT 1 FROM audit_events WHERE action='pruned'")) == 1                  # nothing removed: no empty event


def test_schedule_survives_a_restart_without_skipping_or_doubling(tmp_path):
    cfg = make_config(tmp_path)
    t0 = real_now()
    rt = Runtime(cfg)
    AP.run_scheduled(rt, t0)
    rt.close()
    rt = Runtime(cfg)                                                  # the app restarted: the anchor is still there
    try:
        assert AP.run_scheduled(rt, t0 + dt.timedelta(days=5)) is None
        with rt.db() as conn:
            conn.execute("INSERT INTO audit_events (timestamp, category, object_type, object_id, action, source) "
                         "VALUES (?, 'crm', 'task', 't', 'created', 'GUI')", (stamp(real_now() - dt.timedelta(days=30)),))
        assert AP.run_scheduled(rt, t0 + dt.timedelta(days=14))["removed"] == 1
    finally:
        rt.close()
    rt = Runtime(cfg)
    try:
        assert AP.run_scheduled(rt, t0 + dt.timedelta(days=15)) is None                            # no double run after restart
        with rt.db() as conn:
            assert AP.status(conn)["last_pruned_at"] == stamp(t0 + dt.timedelta(days=14))
    finally:
        rt.close()


def test_the_schema_guard_blocks_deleting_recent_rows_even_from_the_job(build):
    api = build()
    put(api, 1, "recent")
    with api.rt.db() as conn:
        with pytest.raises(sqlite3.DatabaseError, match="cannot be deleted"):
            conn.execute("DELETE FROM audit_events WHERE object_label = 'recent'")
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            conn.execute("UPDATE audit_events SET reason = 'x'")
    # a clock far in the future never lets the job reach past the real 14-day window
    with api.rt.db() as conn:
        AP.prune(conn, real_now() + dt.timedelta(days=365))
    assert api.sql("SELECT 1 FROM audit_events WHERE object_label='recent'")


def test_failure_is_swallowed_and_retried(build, monkeypatch):
    api = build()
    t0 = real_now()
    AP.run_scheduled(api.rt, t0)
    monkeypatch.setattr(AP, "prune", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    assert AP.run_scheduled(api.rt, t0 + dt.timedelta(days=15)) is None
    monkeypatch.undo()
    assert AP.run_scheduled(api.rt, t0 + dt.timedelta(days=15)) is not None


def test_what_still_reads_audit_after_a_prune(build):
    """Today 'Recently changed' and the done-today ring use the newest rows; old rows are gone from the Audit page only."""
    api = build()
    c = api.mk_client("Acme")
    api.mk_task(c["id"], "fresh task")
    put(api, 90, "ancient")
    t0 = real_now()
    AP.run_scheduled(api.rt, t0)
    AP.run_scheduled(api.rt, t0 + dt.timedelta(days=14))
    today = api.get("/api/today").json()
    assert any(r["object_label"] == "fresh task" for r in today["recent_changes"])
    assert today["progress"]["total"] >= 0
    assert api.get("/api/audit", q="ancient").json()["total"] == 0
    assert api.get("/api/audit", q="fresh").json()["total"] >= 1
