"""B-2: persistent metric alert policies (sync_auto_policies), metric catalog, notifier queue, migration 0003."""
from __future__ import annotations

import shutil
import sqlite3
import threading

from server.bams import provider as P
from server.bams import service as BS
from server.bams.notify import Notifier, NotifyResult, WindowsToastNotifier
from server.tests.test_bams_import import R, apply, inspect_ok
from server.tests.test_bams_monitor import T0, FakeNotifier, b, events, setup_metric, tick  # noqa: F401  (b is a fixture)


def add_obj(api, cid, name, metrics):
    return api.ok("/api/bams/object/save", {"client_id": cid, "name": name, "metrics": [
        {"metric_name": m, "ticker": t} for m, t in metrics]})["item"]["object"]


def rules(api):
    return api.sql("SELECT r.*, m.metric_name FROM bams_alert_rules r JOIN bams_metrics m ON m.id = r.metric_id ORDER BY m.metric_name, r.id")


def sync(api):
    with api.rt.db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        res = BS.sync_auto_policies(conn)
        conn.execute("COMMIT")
    return res


def cfg_of(api, cid):
    return next(c for c in api.get("/api/bams/configs").json()["items"] if c["id"] == cid)


def mk_policy(api, **kw):
    body = {"name": "CPU high", "metric_match": "*cpu*", "rule_type": "fixed_threshold", "operator": ">", "threshold": 90,
            "severity": "Warning", "consecutive_updates": 1, "auto_apply": True, **kw}
    return api.ok("/api/bams/configs/save", body)["item"]["config"]


def test_provider_default_field_is_last_price():
    assert P.BlpapiProvider.FIELD == "LAST_PRICE"


def test_auto_apply_policy_creates_adopts_updates_and_disables(b):
    cid = b.mk_client("Pol Co")["id"]
    o1 = add_obj(b, cid, "A1", [("CPU utilisation", "A1.CPU"), ("Memory", "A1.MEM")])
    cfg = mk_policy(b)
    assert cfg["auto_apply"] is True and cfg["matches"] == 1
    assert [(r["metric_name"], r["config_id"], r["threshold"]) for r in rules(b)] == [("CPU utilisation", cfg["id"], 90.0)]
    # a metric saved later is covered immediately (object save syncs); a further sync changes nothing
    add_obj(b, cid, "A2", [("CPU %", "A2.CPU")])
    assert len(rules(b)) == 2
    assert sync(b)["created"] == 0 and sync(b)["updated"] == 0                       # idempotent
    # editing the policy rewrites the managed rules
    b.ok("/api/bams/configs/save", {"id": cfg["id"], "expected_row_version": cfg["row_version"], "threshold": 70})
    assert {r["threshold"] for r in rules(b)} == {70.0}
    # a standalone identical rule is adopted instead of duplicated
    mid = o1["metrics"][1]["id"]
    b.ok("/api/bams/rule/save", {"metric_id": mid, "rule_type": "fixed_threshold", "operator": ">", "threshold": 70,
                                 "severity": "Warning", "consecutive_updates": 1})
    cfg2 = cfg_of(b, cfg["id"])
    b.ok("/api/bams/configs/save", {"id": cfg2["id"], "expected_row_version": cfg2["row_version"], "metric_match": "*"})
    assert sum(1 for r in rules(b) if r["metric_name"] == "Memory") == 1 and len(rules(b)) == 3
    # delete: rules stay (history) but are disabled
    b.err("/api/bams/configs/delete", {"id": cfg["id"]}, 409, "confirmation_required")
    b.ok("/api/bams/configs/delete", {"id": cfg["id"], "confirm": True})
    assert len(rules(b)) == 3
    assert all(r["config_id"] is None for r in rules(b))                              # FK ON DELETE SET NULL
    assert sum(r["enabled"] for r in rules(b)) == 0                                   # history kept, nothing fires


def test_turning_auto_apply_off_disables_managed_rules(b):
    cid = b.mk_client("Off Co")["id"]
    add_obj(b, cid, "A1", [("CPU utilisation", "A1.CPU")])
    cfg = mk_policy(b)
    assert [r["enabled"] for r in rules(b)] == [1]
    b.ok("/api/bams/configs/save", {"id": cfg["id"], "expected_row_version": cfg["row_version"], "auto_apply": False})
    assert [r["enabled"] for r in rules(b)] == [0]
    assert cfg_of(b, cfg["id"])["auto_apply"] is False


def test_apply_to_all_is_persistent_but_selected_metrics_are_not(b):
    cid = b.mk_client("App Co")["id"]
    o = add_obj(b, cid, "A1", [("CPU utilisation", "A1.CPU"), ("CPU load", "A1.LOAD")])
    cfg = mk_policy(b, auto_apply=False)
    assert cfg["auto_apply"] is False and rules(b) == []
    one = [o["metrics"][0]["id"]]
    pv = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"], "metric_ids": one})["item"]
    assert pv["persistent"] is False
    done = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"], "metric_ids": one, "preview": False, "confirm": True,
                                            "plan_hash": pv["plan_hash"]})["item"]
    assert done["persistent"] is False and done["created"] == 1
    assert cfg_of(b, cfg["id"])["auto_apply"] is False
    pv = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"]})["item"]
    assert pv["persistent"] is True
    done = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"], "preview": False, "confirm": True,
                                            "plan_hash": pv["plan_hash"]})["item"]
    assert done["persistent"] is True and done["created"] + done["adopted_identical"] == 2
    assert cfg_of(b, cfg["id"])["auto_apply"] is True and len(rules(b)) == 2


def test_starters_are_not_auto_applied(b):
    items = b.get("/api/bams/configs").json()["items"]
    assert items and all(c["starter"] and c["auto_apply"] is False for c in items)


def test_metric_catalog(b):
    cid, cid2 = b.mk_client("Cat Co")["id"], b.mk_client("Cat Two")["id"]
    add_obj(b, cid, "A1", [("CPU utilisation", "C1"), ("Memory", "C2")])
    add_obj(b, cid2, "A2", [("cpu UTILISATION", "C3")])
    items = b.get("/api/bams/metrics/catalog").json()["items"]
    assert [i["metric_name"].lower() for i in items] == ["cpu utilisation", "memory"]
    assert items[0] == {"metric_name": items[0]["metric_name"], "metric_count": 2, "appliance_count": 2, "account_count": 2}
    assert b.get("/api/bams/metric/catalog").status_code in (404, 405, 422)            # not shadowed by /metric/{id}


def test_notification_test_route_uses_the_notifier(b):
    r = b.post("/api/bams/notifications/test", {})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True and j["detail"] == "fake" and b.notifier.sent[-1][0].startswith("TAM Command Center")
    assert "dev: not displayed" not in str(j["notifier"]) and "unverified" not in str(j).lower()


class DeferredNotifier(Notifier):
    """Delivers on its own schedule like the Windows queue: the poll must not wait and must log the real result."""
    def __init__(self):
        self.pending = []
        self.shut = 0

    def send(self, title, body):
        return NotifyResult(True, "sync")

    def send_async(self, title, body, callback=None):
        self.pending.append(callback)
        return NotifyResult(True, "queued")

    def shutdown(self):
        self.shut += 1


def test_monitor_logs_the_real_async_result_once_and_shuts_the_notifier_down(build):
    n = DeferredNotifier()
    api = build(app_kw={"utc_base": lambda: T0, "notifier": n})
    cid, o, mid, rid = setup_metric(api, consecutive_updates=1)
    tick(api, mid, 90)
    assert len(n.pending) == 1
    desk = lambda: api.sql("SELECT success AS ok, detail FROM bams_notification_log WHERE channel = 'desktop'")  # noqa: E731
    assert desk() == []                                                              # nothing claimed before delivery
    n.pending[0](NotifyResult(False, "PowerShell exited 1"))
    n.pending[0](NotifyResult(True, "duplicate callback"))
    assert [(r["ok"], r["detail"]) for r in desk()] == [(0, "PowerShell exited 1")]   # real result, deduplicated
    api.rt.bams.shutdown()
    assert n.shut == 1


def test_monitor_poll_runs_policy_sync(b):
    cid = b.mk_client("Poll Co")["id"]
    add_obj(b, cid, "A1", [("CPU utilisation", "A1.CPU")])
    mk_policy(b)
    add_obj(b, cid, "A2", [("CPU %", "A2.CPU")])
    assert len(rules(b)) == 2
    b.exec("DELETE FROM bams_alert_rules WHERE config_id IS NOT NULL")                # e.g. a metric created by some other write path
    assert rules(b) == []
    b.rt.bams.poll_once()
    assert len(rules(b)) == 2


def test_bulk_import_attaches_policies_to_new_metrics(build):
    api = build(app_kw={"utc_base": lambda: T0})
    api.cid = api.mk_client("Acme Capital")["id"]
    mk_policy(api, metric_match="*cpu*")
    item = inspect_ok(api, [R(appliance="N1", metric="CPU %", ticker="N1.CPU"), R(appliance="N1", metric="Memory", ticker="N1.MEM")])
    res = apply(api, item)["item"]
    assert res["policy_sync"]["created"] == 1 and [r["metric_name"] for r in rules(api)] == ["CPU %"]


# ------------------------------------------------------------------ Windows notifier (test capture mode, no PowerShell)
def test_windows_notifier_queue_clipping_and_shutdown(monkeypatch):
    monkeypatch.setenv("TAM_BAMS_TEST_NOTIFY", "1")
    n = WindowsToastNotifier()
    try:
        assert n.info()["mode"] == "test capture"
        got = []
        done = threading.Event()
        r = n.send_async("T" * 500, "B" * 900, lambda res: (got.append(res), done.set()))
        assert r.ok and done.wait(5) and got[0].ok
        assert n.send_sync("t", "b").ok
        assert n.send("t", "b").ok
    finally:
        n.shutdown()
        n.shutdown()                                                                  # idempotent
    assert not n._worker.is_alive()


# ------------------------------------------------------------------ migration 0003
def test_migration_0003_upgrades_a_v2_database_and_keeps_rows(tmp_path):
    from db import migrate
    mdir = tmp_path / "m"
    mdir.mkdir()
    for f in ("0001_initial.sql", "0002_audit_prune.sql"):
        shutil.copy(migrate.MIGRATIONS_DIR / f, mdir)
    orig = migrate.MIGRATIONS_DIR
    db = tmp_path / "t.db"
    conn = migrate.connect(db)
    try:
        migrate.MIGRATIONS_DIR = mdir
        migrate.migrate(conn, channel=None)
        assert migrate.current_version(conn) == 2
        conn.execute("INSERT INTO bams_alert_configs (id, name, metric_match, rule_type, operator, threshold, severity)"
                     " VALUES ('c1', 'Old', '*', 'fixed_threshold', '>', 80, 'Warning')")
    finally:
        migrate.MIGRATIONS_DIR = orig
    res = migrate.migrate(conn, backup_hook=lambda c, why: None, channel=None)
    assert res["from"] == 2 and res["to"] == 3 and res["applied"] == ["0003_bams_persistent_metric_alerts.sql"]
    row = conn.execute("SELECT auto_apply FROM bams_alert_configs WHERE id = 'c1'").fetchone()
    assert row[0] == 0
    cols = {r[1] for r in conn.execute("PRAGMA table_info(bams_alert_rules)")}
    assert "config_id" in cols
    assert migrate.migrate(conn, channel=None)["applied"] == []                       # re-run is a no-op
    conn.close()
