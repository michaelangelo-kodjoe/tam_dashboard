"""Run 4 (T-102..T-109): provider, monitor, lifecycle, read/write routes, notifications, DEV routes."""
from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from server.bams import lifecycle as L
from server.bams import provider as P
from server.bams.notify import NotifyResult, Notifier, toast_text

T0 = dt.datetime(2026, 10, 14, 12, 0, 0, tzinfo=dt.timezone.utc)


class FailingNotifier(Notifier):
    def __init__(self):
        self.calls = 0

    def send(self, title, body):
        self.calls += 1
        raise RuntimeError("boom")        # even a misbehaving notifier must not break a poll


class FakeNotifier(Notifier):
    def __init__(self):
        self.sent = []

    def send(self, title, body):
        self.sent.append((title, body))
        return NotifyResult(True, "fake")


@pytest.fixture
def b(build):
    """DEV app with a fixed clock (moves only when advanced) and a fake notifier."""
    n = FakeNotifier()
    api = build(app_kw={"utc_base": lambda: T0, "notifier": n})
    api.notifier = n
    return api


def post(api, path, body=None, status=200):
    return api.ok(path, body or {}, status=status)


def setup_metric(api, name="Acme Capital", obj="BPOD-01", metric="CPU utilisation %", ticker="BPOD1 CPU", **rule):
    cid = api.mk_client(name)["id"]
    o = api.ok("/api/bams/object/save", {"client_id": cid, "name": obj, "metrics": [
        {"metric_name": metric, "ticker": ticker}]})["item"]["object"]
    mid = o["metrics"][0]["id"]
    r = {"metric_id": mid, "rule_type": "fixed_threshold", "operator": ">", "threshold": 85, "consecutive_updates": 2,
         "severity": "Warning"}
    r.update(rule)
    rid = api.ok("/api/bams/rule/save", r)["item"]["rule"]["id"]
    return cid, o, mid, rid


def tick(api, mid, value, secs=60):
    post(api, "/api/dev/bams/clock", {"advance_seconds": secs})
    return post(api, "/api/dev/bams/force-value", {"metric_id": mid, "value": value})["item"]


def events(api):
    return api.sql("SELECT * FROM bams_alert_events ORDER BY opened_at, id")


# ------------------------------------------------------------------ T-102 provider
def test_prod_never_constructs_simulator(build, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("simulator constructed in PROD")
    monkeypatch.setattr(P.SimulatedProvider, "__init__", boom)
    api = build(prod=True)
    assert isinstance(api.rt.bams.provider, P.BlpapiProvider)
    s = api.get("/api/bams/state").json()
    assert s["banner"]["code"] == "provider_unavailable"
    pv = s["provider"]
    assert (pv["mode"], pv["kind"], pv["available"], pv["simulated"]) == ("PROD", "blpapi", False, False), pv
    assert pv["message"] and ("not installed" in pv["message"] or "not reachable" in pv["message"]), pv
    assert s["monitor"]["state"] == "provider_unavailable"
    assert api.post("/api/bams/monitor/start").json()["item"]["monitor"]["state"] == "provider_unavailable"


def test_simulator_refuses_non_dev_mode():
    with pytest.raises(RuntimeError):
        P.SimulatedProvider("PROD")
    assert isinstance(P.select_provider("PROD"), P.BlpapiProvider)


def test_prod_rows_have_no_numbers_even_with_stored_values(build):
    api = build(prod=True)
    cid = api.mk_client("P")["id"]
    api.ok("/api/bams/object/save", {"client_id": cid, "name": "X", "metrics": [{"metric_name": "CPU", "ticker": "T1"}]})
    api.exec("UPDATE bams_metrics SET current_value = 55, last_source_update = '2026-10-14T11:59:59.000Z',"
             " last_received = '2026-10-14T11:59:59.000Z'")
    rows = api.get("/api/bams/state").json()["rows"]
    assert rows[0]["current_value"] is None and rows[0]["freshness"] == "No Data" and rows[0]["simulated"] is False
    inf = api.get(f"/api/client/{cid}/infrastructure").json()["bams_objects"][0]
    assert inf["worst_status"] == "No Data" and inf["metrics"][0]["current_value"] is None


def test_prod_dev_routes_absent(build):
    api = build(prod=True)
    for path in ("force-value", "simulate-stale", "simulate-outage", "poll", "clock", "reset"):
        r = api.post("/api/dev/bams/" + path, {})
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_simulator_is_deterministic_and_percent_bounded():
    a, c = P.SimulatedProvider("DEV", 1), P.SimulatedProvider("DEV", 1)
    for h in range(0, 500, 7):
        t = T0 + dt.timedelta(hours=h)
        assert a.value_at("X", t) == c.value_at("X", t)
        assert 0 <= a.value_at("X", t) <= 100


# ------------------------------------------------------------------ T-104 lifecycle (pure)
RULE = {"rule_type": "fixed_threshold", "operator": ">", "threshold": 85.0, "reference_period": None,
        "consecutive_updates": 2, "severity": "Warning", "cooldown_minutes": 10, "breach_count": 0,
        "suppress_until_clear": 0}


def test_lifecycle_paths():
    now = T0
    no_h = {"high_30": None, "high_60": None, "high_90": None}
    d = L.step(RULE, 90, no_h, None, None, now)
    assert (d.action, d.breach_count) == ("none", 1)
    d = L.step({**RULE, "breach_count": 1}, 90, no_h, None, None, now)
    assert d.action == "open"
    # cooldown since last close blocks, then allows
    r2 = {**RULE, "breach_count": 5}
    assert L.step(r2, 90, no_h, None, now - dt.timedelta(minutes=5), now).action == "none"
    assert L.step(r2, 90, no_h, None, now - dt.timedelta(minutes=11), now).action == "open"
    # suppressed until clear
    assert L.step({**r2, "suppress_until_clear": 1}, 90, no_h, None, None, now).action == "none"
    d = L.step({**r2, "suppress_until_clear": 1}, 50, no_h, None, None, now)
    assert (d.suppress, d.breach_count) == (False, 0)
    # active open: breach retriggers, clear recovers; recovered stays recovered on clear, reopens on breach
    assert L.step(r2, 90, no_h, {"status": "open"}, None, now).action == "retrigger"
    assert L.step(r2, 50, no_h, {"status": "open"}, None, now).action == "recover"
    assert L.step(r2, 50, no_h, {"status": "recovered"}, None, now).action == "none"
    assert L.step(r2, 90, no_h, {"status": "recovered"}, None, now).action == "retrigger"
    # unknown high: nothing changes
    ex = {**RULE, "rule_type": "exceeds_high", "reference_period": "30d", "threshold": None}
    assert L.step(ex, 99, no_h, None, None, now).action == "none"
    assert L.step({**ex, "consecutive_updates": 1}, 99, {**no_h, "high_30": 90}, None, None, now).action == "open"
    pct = {**RULE, "rule_type": "pct_of_high", "reference_period": "90d", "threshold": 90.0, "consecutive_updates": 1}
    assert L.breaches(pct, 81.0, {"high_90": 90.0}) is False and L.breaches(pct, 81.1, {"high_90": 90.0}) is True


def test_freshness_bands_and_live_floor():
    assert L.live_seconds(60) == 75 and L.live_seconds(300) == 315
    assert L.freshness(75, True, 75, 120) == "Live" and L.freshness(76, True, 75, 120) == "Delayed"
    assert L.freshness(121, True, 75, 120) == "Stale" and L.freshness(None, False, 75, 120) == "No Data"
    assert L.freshness(1, True, 75, 120, available=False) == "No Data"


def test_preview_sentences():
    h = {"high_90": 1755.0}
    assert L.preview_for({**RULE, "consecutive_updates": 3}, "CPU utilisation %", h) == \
        "Alerts when CPU utilisation % > 85 for 3 updates (Warning)"
    pct = {**RULE, "rule_type": "pct_of_high", "reference_period": "90d", "threshold": 90.0, "severity": "Critical"}
    assert L.preview_for(pct, "Active sessions", h) == \
        "Alerts when Active sessions > 90% of the 90-day high (1,755) for 2 updates (Critical)"
    ex = {**RULE, "rule_type": "exceeds_high", "reference_period": "90d", "threshold": None, "consecutive_updates": 1,
          "severity": "Critical"}
    assert L.preview_for(ex, "Active sessions", h) == \
        "Alerts when Active sessions exceeds the 90-day high (1,755) for 1 update (Critical)"
    assert "(" not in L.preview_for(ex, "Active sessions", {}).split("high")[1].split("for")[0]


# ------------------------------------------------------------------ T-103 monitor
def test_provider_calls_independent_of_ui_refresh(b):
    setup_metric(b)
    prov = b.rt.bams.provider
    for _ in range(12):
        assert b.get("/api/bams/state").status_code == 200
        b.get("/api/state")
    assert prov.calls == 0
    for _ in range(3):
        post(b, "/api/dev/bams/poll")
    assert prov.calls == 3


def test_full_lifecycle_notifications_and_suppression(b):
    cid, o, mid, rid = setup_metric(b)
    tick(b, mid, 90)
    assert events(b) == [] and b.sql("SELECT breach_count FROM bams_alert_rules")[0]["breach_count"] == 1
    tick(b, mid, 91)
    ev = events(b)
    assert len(ev) == 1 and ev[0]["status"] == "open" and ev[0]["rule_id"] == rid and ev[0]["trigger_value"] == 91
    log = {(r["kind"], r["channel"]): r for r in b.sql("SELECT * FROM bams_notification_log")}
    assert set(log) == {("opened", "in_app"), ("opened", "desktop")} and log[("opened", "desktop")]["success"] == 1
    assert b.notifier.sent == [("BAMS alert opened (Warning)", "Open TAM Command Center for details.")]   # privacy on
    tick(b, mid, 50)
    assert events(b)[0]["status"] == "recovered" and events(b)[0]["recovered_at"]
    assert ("recovered", "in_app") in {(r["kind"], r["channel"]) for r in b.sql("SELECT * FROM bams_notification_log")}
    assert len(b.notifier.sent) == 1                     # desktop recovered is opt-in
    tick(b, mid, 92)                                     # back to open, same event, no second 'opened'
    ev = events(b)
    assert len(ev) == 1 and ev[0]["status"] == "open" and ev[0]["recovered_at"] is None and ev[0]["peak_value"] == 92
    assert len(b.notifier.sent) == 1
    # close while still breaching -> suppressed until clear
    close = b.ok(f"/api/bams/alert/{ev[0]['id']}/close", {"note": "known", "expected_row_version": ev[0]["row_version"]})
    assert close["item"]["suppressed_until_clear"] is True and close["item"]["event"]["status"] == "closed"
    assert b.sql("SELECT suppress_until_clear FROM bams_alert_rules")[0]["suppress_until_clear"] == 1
    tick(b, mid, 95)
    tick(b, mid, 96)
    assert len(events(b)) == 1
    tick(b, mid, 50)                                     # clears the suppression
    assert b.sql("SELECT suppress_until_clear FROM bams_alert_rules")[0]["suppress_until_clear"] == 0
    tick(b, mid, 90)
    tick(b, mid, 90)
    assert [e["status"] for e in events(b)] == ["closed", "open"]
    a = b.audit(object_type="bams_alert_event")
    assert a and a[0]["action"] == "closed" and a[0]["category"] == "bams" and a[0]["reason"] == "known"
    again = b.err(f"/api/bams/alert/{ev[0]['id']}/close", {}, 409, "conflict")
    assert again["details"]["reason"] == "already_closed"


def test_cooldown_after_close(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1, cooldown_minutes=10)
    tick(b, mid, 90)
    eid = events(b)[0]["id"]
    tick(b, mid, 50)
    b.ok(f"/api/bams/alert/{eid}/close", {})
    tick(b, mid, 90, secs=60)                                 # within 10 minutes of the close
    assert len(events(b)) == 1
    tick(b, mid, 90, secs=600)
    assert len(events(b)) == 2


def test_stale_and_outage_freeze_evaluation(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    assert events(b)[0]["status"] == "open"
    post(b, "/api/dev/bams/simulate-stale", {"metric_id": mid, "on": True})
    post(b, "/api/dev/bams/clock", {"advance_seconds": 300})
    post(b, "/api/dev/bams/poll")
    row = b.get("/api/bams/state").json()["rows"][0]
    assert row["freshness"] == "Stale" and events(b)[0]["status"] == "open"
    post(b, "/api/dev/bams/simulate-stale", {"metric_id": mid, "on": False})
    post(b, "/api/dev/bams/simulate-outage", {"on": True})
    s = b.get("/api/bams/state").json()
    assert s["banner"]["text"] == "Simulated outage (DEV)" and s["rows"][0]["current_value"] is None
    assert s["rows"][0]["freshness"] == "No Data" and s["monitor"]["state"] == "provider_unavailable"
    before = b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"]
    post(b, "/api/dev/bams/poll")
    assert b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"] == before
    assert events(b)[0]["status"] == "open"
    # a human can still close during a frozen monitor
    b.ok(f"/api/bams/alert/{events(b)[0]['id']}/close", {})


def test_exceeds_high_uses_prior_high_and_highs_track(b):
    cid, o, mid, rid = setup_metric(b, rule_type="exceeds_high", threshold=None, reference_period="30d",
                                    consecutive_updates=1)
    post(b, "/api/dev/bams/poll")                       # backfills 90 days, computes highs
    row = b.get("/api/bams/state").json()["rows"][0]
    h30 = row["highs"]["d30"]["value"]
    assert h30 is not None and row["highs"]["d90"]["value"] >= h30
    n = b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"]
    assert 520 <= n <= 560                              # ~90 days, 4-hourly, plus the poll sample
    tick(b, mid, min(100, h30 + 0.5) if h30 < 99.5 else 100)
    ev = events(b)
    assert len(ev) == 1 and ev[0]["alert_type"] == "exceeds_high"
    new = b.get("/api/bams/state").json()["rows"][0]["highs"]["d30"]
    assert new["value"] >= h30


def test_pruning_and_daily_recompute(b):
    cid, o, mid, rid = setup_metric(b)
    post(b, "/api/dev/bams/poll")
    b.exec("INSERT INTO bams_metric_samples (metric_id, sampled_at, source_update, value) VALUES (?, '2026-05-01T00:00:00.000Z', NULL, 1)", (mid,))
    post(b, "/api/dev/bams/clock", {"advance_seconds": 86400})
    post(b, "/api/dev/bams/poll")
    assert b.sql("SELECT count(*) AS n FROM bams_metric_samples WHERE sampled_at < '2026-07-01'")[0]["n"] == 0


def test_monitor_start_stop_idempotent_and_audited(b):
    r1 = post(b, "/api/bams/monitor/start")["item"]["monitor"]
    assert r1["state"] == "running" and r1["desired_running"] is True
    n = len(b.audit(category="bams"))
    post(b, "/api/bams/monitor/start")
    assert len(b.audit(category="bams")) == n
    r2 = post(b, "/api/bams/monitor/stop")["item"]["monitor"]
    assert r2["state"] == "stopped" and r2["desired_running"] is False
    assert b.get("/api/bams/monitor").json()["monitor"]["state"] == "stopped"


def test_notifier_failure_never_breaks_poll(build):
    n = FailingNotifier()
    api = build(app_kw={"utc_base": lambda: T0, "notifier": n})
    cid, o, mid, rid = setup_metric(api, consecutive_updates=1)
    tick(api, mid, 90)
    assert events(api)[0]["status"] == "open" and n.calls == 1
    assert api.sql("SELECT count(*) AS n FROM bams_notification_log WHERE channel='desktop'")[0]["n"] == 0


def test_toast_privacy_text():
    assert toast_text("opened", "Critical", True, "CPU", "Acme / X", 91.4) == \
        ("BAMS alert opened (Critical)", "Open TAM Command Center for details.")
    t, body = toast_text("opened", "Critical", False, "CPU", "Acme / X", 91.4)
    assert "CPU" in t and "Acme / X" in body and "91.4" in body


def test_privacy_off_and_settings(b):
    s = post(b, "/api/bams/settings", {"privacy_mode": False, "notify_recovered": True})["item"]
    assert s["privacy_mode"] is False and s["notify_recovered"] is True and s["poll_interval_seconds"] == 60
    assert b.audit(object_type="setting", action="updated")
    b.err("/api/bams/settings", {"poll_interval_seconds": 10}, 422, "validation_error")
    b.err("/api/bams/settings", {"bogus": 1}, 422, "validation_error")
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    tick(b, mid, 10)
    assert "Acme Capital" in b.notifier.sent[0][1] and len(b.notifier.sent) == 2


def test_new_metric_picked_up_without_restart(b):
    cid, o, mid, rid = setup_metric(b)
    post(b, "/api/dev/bams/poll")
    m = b.ok("/api/bams/metric/save", {"object_id": o["id"], "metric_name": "Mem %", "ticker": "BPOD1 MEM"})["item"]["metric"]
    row = [r for r in b.get("/api/bams/state").json()["rows"] if r["id"] == m["id"]][0]
    assert row["freshness"] == "No Data"
    post(b, "/api/dev/bams/clock", {"advance_seconds": 60})
    post(b, "/api/dev/bams/poll")
    row = [r for r in b.get("/api/bams/state").json()["rows"] if r["id"] == m["id"]][0]
    assert row["current_value"] is not None and row["freshness"] == "Live" and row["simulated"] is True


# ------------------------------------------------------------------ T-105 reads
def test_state_filters_sort_and_counts_match_infrastructure(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    cid2 = b.mk_client("Zeta Fund")["id"]
    o2 = b.ok("/api/bams/object/save", {"client_id": cid2, "name": "ZPOD", "location": "London", "metrics": [
        {"metric_name": "Disk %", "ticker": "Z DISK"}]})["item"]["object"]
    s = b.get("/api/bams/state").json()
    assert s["summary"]["active_alerts"] == 1 and s["summary"]["total"] == 2 and s["summary"]["live"] == 1
    assert s["summary"]["no_data"] == 1 and s["rows"][0]["display_status"] == "open"
    assert s["view_counts"] == {"all": 2, "active_alerts": 1, "delayed_stale": 0, "live": 1, "no_data": 1}
    inf = b.get(f"/api/client/{cid}/infrastructure").json()
    assert inf["active_alerts"] == s["summary"]["active_alerts"]
    assert b.get("/api/state").json()["infrastructure"][cid]["active_alerts"] == 1
    assert len(b.get("/api/bams/state", view="active_alerts").json()["rows"]) == 1
    assert len(b.get("/api/bams/state", account=f"{cid},{cid2}").json()["rows"]) == 2
    assert [r["object"]["name"] for r in b.get("/api/bams/state", location="LONDON").json()["rows"]] == ["ZPOD"]
    assert len(b.get("/api/bams/state", q="z disk").json()["rows"]) == 1
    assert len(b.get("/api/bams/state", status="open").json()["rows"]) == 1
    rows = b.get("/api/bams/state", sort="current", dir="desc").json()["rows"]
    assert rows[0]["current_value"] == 90 and rows[1]["current_value"] is None      # nulls last
    assert "spark" not in b.get("/api/bams/state", spark=0).json()["rows"][0]
    assert isinstance(b.get("/api/bams/state").json()["rows"][0]["spark"], list)
    for bad in ({"view": "x"}, {"sort": "x"}, {"status": "x"}, {"dir": "x"}):
        assert b.get("/api/bams/state", **bad).status_code == 422
    b.ok("/api/bams/object/save", {"id": o2["id"], "enabled": False, "expected_row_version": o2["row_version"]})
    assert b.get("/api/bams/state").json()["summary"]["total"] == 1
    assert b.get("/api/bams/state", include_disabled="true").json()["summary"]["total"] == 1
    assert len(b.get("/api/bams/state", include_disabled="true").json()["rows"]) == 2


def test_detail_trend_and_alert_lists(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    for _ in range(3):
        post(b, "/api/dev/bams/poll")
    tick(b, mid, 90)
    d = b.get(f"/api/bams/metric/{mid}").json()["item"]
    assert d["rules"][0]["preview"] == "Alerts when CPU utilisation % > 85 for 1 update (Warning)"
    assert d["alerts"][0]["still_breaching"] is True and d["alerts"][0]["rule_summary"] == "> 85 for 1 update"
    t = b.get(f"/api/bams/metric/{mid}/trend", range="90d").json()["item"]
    assert 0 < len(t["points"]) <= 500 and t["text"]["count"] >= 500 and t["rule_lines"][0]["value"] == 85
    assert t["downsampled"] is True and {r["id"] for r in t["reference_lines"]} == {"high_30", "high_60", "high_90"}
    t24 = b.get(f"/api/bams/metric/{mid}/trend", range="24h").json()["item"]
    assert t24["downsampled"] is False and t24["text"]["last"] == 90
    assert b.get(f"/api/bams/metric/{mid}/trend", range="5y").status_code == 422
    assert b.get("/api/bams/metric/nope").status_code == 404
    al = b.get("/api/bams/alerts").json()
    assert al["counts"]["active"] == 1 and al["items"][0]["freshness"] == "Live"
    assert b.get("/api/bams/alerts", status="closed").json()["items"] == []
    post(b, "/api/dev/bams/outage" if False else "/api/dev/bams/simulate-outage", {"on": True})
    tt = b.get(f"/api/bams/metric/{mid}/trend").json()["item"]
    assert tt["points"] == [] and tt["text"]["count"] == 0


# ------------------------------------------------------------------ T-106 writes
def test_object_rules_and_conflicts(api):
    cid = api.mk_client("A")["id"]
    cid2 = api.mk_client("B")["id"]
    base = {"client_id": cid, "name": "BPOD-01", "metrics": [{"metric_name": "CPU", "ticker": "TK1"}]}
    o = api.ok("/api/bams/object/save", base)["item"]["object"]
    e = api.err("/api/bams/object/save", {**base, "name": "bpod-01", "metrics": [{"metric_name": "CPU", "ticker": "TK2"}]}, 409, "conflict")
    assert "name" in e["fields"]
    e = api.err("/api/bams/object/save", {"client_id": cid, "name": "OTHER", "metrics": [{"metric_name": "X", "ticker": "tk1"}]}, 409, "conflict")
    assert "metrics[0].ticker" in e["fields"] and e["details"]["owner"]["object_name"] == "BPOD-01"
    assert api.sql("SELECT count(*) AS n FROM bams_objects")[0]["n"] == 1          # nothing partially written
    e = api.err("/api/bams/object/save", {"client_id": cid, "name": "O2", "metrics": [
        {"metric_name": "A", "ticker": "R1"}, {"metric_name": "B", "ticker": "r1"}]}, 409, "conflict")
    assert set(e["fields"]) == {"metrics[0].ticker", "metrics[1].ticker"}
    api.ok("/api/bams/object/save", {"client_id": cid2, "name": "BPOD-01", "metrics": [{"metric_name": "CPU", "ticker": "TK9"}]})
    api.err("/api/bams/object/save", {"client_id": cid, "name": "N", "metrics": []}, 422, "validation_error")
    api.err("/api/bams/object/save", {"client_id": "nope", "name": "N", "metrics": [{"metric_name": "a", "ticker": "b"}]}, 422, "validation_error")
    api.err("/api/bams/object/save", {"id": o["id"], "expected_row_version": 99, "region": "EU"}, 409, "stale_write")
    ok = api.ok("/api/bams/object/save", {"id": o["id"], "expected_row_version": o["row_version"], "region": "EU"})
    assert ok["item"]["object"]["region"] == "EU"
    assert api.ok("/api/bams/object/save", {"id": o["id"], "region": "EU"})["side_effects"] == [{"type": "no_change"}]
    api.err("/api/bams/object/save", {"id": o["id"], "client_id": cid2}, 422, "validation_error")
    assert api.audit(object_type="bams_object", action="created") and api.audit(object_type="bams_metric", action="created")
    mid = o["metrics"][0]["id"]
    r = api.err("/api/bams/rule/save", {"metric_id": mid, "rule_type": "fixed_threshold"}, 422, "validation_error")
    assert r["fields"]["threshold"] == "Threshold is required for a threshold rule."
    r = api.err("/api/bams/rule/save", {"metric_id": mid, "rule_type": "fixed_threshold", "threshold": 1,
                                        "consecutive_updates": 0}, 422, "validation_error")
    assert r["fields"]["consecutive_updates"] == "Consecutive updates must be 1 or more."
    api.err("/api/bams/rule/save", {"metric_id": mid, "rule_type": "exceeds_high", "reference_period": "30d", "operator": "<"}, 422, "validation_error")
    api.err("/api/bams/rule/save", {"metric_id": mid, "rule_type": "pct_of_high", "threshold": 0, "reference_period": "30d"}, 422, "validation_error")
    rule = api.ok("/api/bams/rule/save", {"metric_id": mid, "rule_type": "pct_of_high", "threshold": 90, "reference_period": "90d"})["item"]["rule"]
    up = api.ok("/api/bams/rule/save", {"id": rule["id"], "expected_row_version": rule["row_version"], "severity": "Critical"})["item"]["rule"]
    assert up["severity"] == "Critical" and up["row_version"] == rule["row_version"] + 1
    api.err("/api/bams/rule/delete", {"id": rule["id"]}, 409, "confirmation_required")
    api.ok("/api/bams/rule/delete", {"id": rule["id"], "confirm": True})
    assert len(api.audit(object_type="bams_alert_rule")) == 3


def test_metric_ticker_change_clears_reading_keeps_history(b):
    cid, o, mid, rid = setup_metric(b)
    post(b, "/api/dev/bams/poll")
    n = b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"]
    m = b.sql("SELECT row_version FROM bams_metrics")[0]
    b.ok("/api/bams/metric/save", {"id": mid, "ticker": "NEW TICKER", "expected_row_version": m["row_version"]})
    r = b.sql("SELECT current_value, last_source_update, high_30 FROM bams_metrics")[0]
    assert r["current_value"] is None and r["last_source_update"] is None and r["high_30"] is not None
    assert b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"] == n


def test_delete_blocked_confirm_backup_cascade(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    pv = b.get(f"/api/bams/object/{o['id']}/delete-preview").json()["item"]
    assert pv["blocked"] and pv["alerts_active"] == 1 and pv["metrics"] == 1 and pv["samples"] > 0
    e = b.err("/api/bams/object/delete", {"id": o["id"], "confirm": True}, 409, "conflict")
    assert e["details"]["reason"] == "active_alert"
    assert b.sql("SELECT count(*) AS n FROM bams_objects")[0]["n"] == 1 and not list(b.rt.config.backup_dir.glob("*pre-delete*"))
    b.err("/api/bams/metric/delete", {"id": mid, "confirm": True}, 409, "conflict")
    b.ok(f"/api/bams/alert/{events(b)[0]['id']}/close", {})
    e = b.err("/api/bams/object/delete", {"id": o["id"]}, 409, "confirmation_required")
    assert e["details"]["blocked"] is False
    ok = b.ok("/api/bams/object/delete", {"id": o["id"], "confirm": True})
    assert ok["item"]["deleted"]["samples"] > 0 and ok["side_effects"][0]["type"] == "backup_created"
    assert b.sql("SELECT (SELECT count(*) FROM bams_metrics) a, (SELECT count(*) FROM bams_metric_samples) s,"
                 " (SELECT count(*) FROM bams_alert_events) e")[0] == {"a": 0, "s": 0, "e": 0}
    assert b.audit(object_type="bams_object", action="deleted")


def test_rule_delete_blocked_while_alert_active_then_keeps_summary(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    e = b.err("/api/bams/rule/delete", {"id": rid, "confirm": True}, 409, "conflict")
    assert e["details"]["reason"] == "active_alert" and b.sql("SELECT count(*) AS n FROM bams_alert_rules")[0]["n"] == 1
    b.ok(f"/api/bams/alert/{events(b)[0]['id']}/close", {})
    b.ok("/api/bams/rule/delete", {"id": rid, "confirm": True})
    ev = events(b)[0]
    assert ev["rule_id"] is None and ev["status"] == "closed"
    item = b.get("/api/bams/alerts", status="closed").json()["items"][0]["event"]
    assert item["rule_summary"] == "> 85" and item["still_breaching"] is False


def test_configs_starters_apply_preview_hash(b):
    names = {c["name"] for c in b.get("/api/bams/configs").json()["items"]}
    assert len(names) == 2 and all(c["starter"] for c in b.get("/api/bams/configs").json()["items"])
    cid, o, mid, rid = setup_metric(b, metric="CPU utilisation %")
    cfg = b.ok("/api/bams/configs/save", {"name": "CPU 85", "metric_match": "*cpu*", "rule_type": "fixed_threshold",
                                          "threshold": 85, "severity": "Warning", "consecutive_updates": 2})["item"]["config"]
    assert cfg["matches"] == 1 and cfg["preview"] == "Alerts when a matching metric > 85 for 2 updates (Warning)"
    b.err("/api/bams/configs/save", {"name": "cpu 85", "metric_match": "*", "rule_type": "fixed_threshold", "threshold": 1}, 409, "conflict")
    pv = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"]})["item"]
    assert pv["would_create"] == 0 and pv["skipped_identical"] == 1            # identical to the existing rule
    cfg2 = b.ok("/api/bams/configs/save", {"id": cfg["id"], "threshold": 80, "expected_row_version": cfg["row_version"]})["item"]["config"]
    pv = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"]})["item"]
    assert pv["would_create"] == 1 and b.sql("SELECT count(*) AS n FROM bams_alert_rules")[0]["n"] == 1
    b.err("/api/bams/configs/apply", {"config_id": cfg["id"], "preview": False}, 409, "confirmation_required")
    b.err("/api/bams/configs/apply", {"config_id": cfg["id"], "preview": False, "confirm": True}, 422, "validation_error")
    b.err("/api/bams/configs/apply", {"config_id": cfg["id"], "preview": False, "confirm": True, "plan_hash": "sha256:x"}, 409, "preview_stale")
    b.err("/api/bams/configs/apply", {"config_id": cfg["id"], "metric_ids": ["nope"]}, 422, "validation_error")
    done = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"], "preview": False, "confirm": True, "plan_hash": pv["plan_hash"]})["item"]
    assert done["created"] == 1 and len(done["rule_ids"]) == 1
    again = b.ok("/api/bams/configs/apply", {"config_id": cfg["id"]})["item"]
    assert again["would_create"] == 0 and again["skipped_identical"] == 1
    assert b.audit(object_type="bams_alert_rule", action="created")[-1]["reason"] == "Persistent alert policy"
    b.ok("/api/bams/configs/delete", {"id": cfg2["config"]["id"] if "config" in cfg2 else cfg["id"], "confirm": True})


def test_notifications_read_watermark(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    tick(b, mid, 10)
    n = b.get("/api/bams/notifications").json()
    assert n["unread_count"] == 2 and n["items"][0]["kind"] == "recovered" and n["items"][1]["unread"] is True
    assert n["items"][1]["title"] == "Warning opened: CPU utilisation %"
    assert n["items"][1]["detail"].startswith("Acme Capital / BPOD-01")
    r = b.ok("/api/bams/notifications/read", {"through_id": n["items"][1]["id"]})
    assert r["item"]["unread_count"] == 1
    assert len(b.get("/api/bams/notifications", unread_only="true").json()["items"]) == 1
    b.err("/api/bams/notifications/read", {"through_id": 1, "all": True}, 422, "validation_error")
    b.err("/api/bams/notifications/read", {}, 422, "validation_error")
    assert b.ok("/api/bams/notifications/read", {"all": True})["item"]["unread_count"] == 0
    assert len(b.sql("SELECT * FROM bams_notification_log WHERE channel='in_app'")) == 2     # never deleted


def test_notification_log_once_per_event_kind_channel(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    eid = events(b)[0]["id"]
    from server.bams import repo
    with b.rt.db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        assert repo.log_notification(conn, eid, "opened", "in_app", "2026-10-14T12:00:00.000Z", True, None) is False
        conn.execute("COMMIT")


# ------------------------------------------------------------------ T-108 DEV routes
def test_dev_reset_and_clock(b):
    cid, o, mid, rid = setup_metric(b, consecutive_updates=1)
    tick(b, mid, 90)
    b.err("/api/dev/bams/reset", {}, 409, "confirmation_required")
    j = post(b, "/api/dev/bams/reset", {"confirm": True})
    assert j["side_effects"][0]["reason"] == "pre-delete"
    assert events(b) == [] and b.sql("SELECT count(*) AS n FROM bams_notification_log")[0]["n"] == 0
    assert b.sql("SELECT count(*) AS n FROM bams_objects")[0]["n"] == 1 and b.sql("SELECT count(*) AS n FROM bams_alert_rules")[0]["n"] == 1
    assert b.sql("SELECT count(*) AS n FROM bams_metric_samples")[0]["n"] >= 500
    c = post(b, "/api/dev/bams/clock", {"set": "2026-12-01T00:00:00Z"})["item"]["server_time"]
    assert c == "2026-12-01T00:00:00.000Z"
    assert post(b, "/api/dev/bams/clock", {"reset": True})["item"]["server_time"] == "2026-10-14T12:00:00.000Z"
    b.err("/api/dev/bams/clock", {"reset": True, "advance_seconds": 1}, 422, "validation_error")
    assert b.get("/api/bams/state").json()["server_time"] == "2026-10-14T12:00:00.000Z"


def test_monitor_thread_polls_and_stops(build):
    import time
    api = build(app_kw={"monitor_thread": True})
    cid, o, mid, rid = setup_metric(api)
    assert api.rt.bams.provider.calls == 0
    api.ok("/api/bams/monitor/start", {})                    # starts the real loop thread
    for _ in range(100):
        if api.rt.bams.provider.calls:
            break
        time.sleep(0.05)
    assert api.rt.bams.provider.calls >= 1 and api.rt.bams._thread.is_alive()
    api.ok("/api/bams/monitor/stop", {})
    assert api.rt.bams._thread is None and api.rt.bams.state() == "stopped"
    calls = api.rt.bams.provider.calls
    time.sleep(0.2)
    assert api.rt.bams.provider.calls == calls


def _status_counts(api, percent_only=False):
    """percent_only skips the seeded Mbps "NET" metrics: the DEV simulator only produces percentages (0..100), so it cannot
    hold or clear alerts whose levels sit at hundreds of Mbps (QA-W1-2)."""
    where = " WHERE m.ticker NOT LIKE '%.NET'" if percent_only else ""
    return {r["status"]: r["n"] for r in api.sql(
        "SELECT e.status, count(*) AS n FROM bams_alert_events e JOIN bams_metrics m ON m.id = e.metric_id" + where
        + " GROUP BY e.status")}


def test_qa_e5_3_seeded_alert_mix_survives_polls(build):
    """QA-E5-3: first and later DEV polls keep seeded open alerts open and recovered ones recovered."""
    # QA-W1-2: align the seed with the pinned BAMS clock. The seed anchors "now" to the real instant when the app
    # date is the real today, which put seeded events after the pinned T0 clock; a fixed app date seeds at 12:00Z = T0.
    api = build(seed=True, app_kw={"utc_base": lambda: T0, "notifier": FakeNotifier(),
                                   "clock": lambda: T0.date()})
    before = _status_counts(api, percent_only=True)
    assert before.get("open", 0) >= 6 and before.get("recovered", 0) >= 2
    for _ in range(4):
        post(api, "/api/dev/bams/clock", {"advance_seconds": 60})
        post(api, "/api/dev/bams/poll")
        assert _status_counts(api, percent_only=True) == before, api.sql("SELECT e.alert_type, r.operator||r.threshold||coalesce(r.reference_period,'') AS rl, e.current_value AS cv, m.high_30 AS h30, m.high_90 AS h90, m.ticker FROM bams_alert_events e LEFT JOIN bams_alert_rules r ON r.id=e.rule_id JOIN bams_metrics m ON m.id=e.metric_id WHERE e.status='recovered'")
    # dev routes still force changes: force a seeded open rule alert to recover, then stale another
    ev = api.sql("SELECT e.metric_id, e.id FROM bams_alert_events e WHERE e.status='open' AND e.rule_id IS NOT NULL LIMIT 1")[0]
    post(api, "/api/dev/bams/clock", {"advance_seconds": 60})
    post(api, "/api/dev/bams/force-value", {"metric_id": ev["metric_id"], "value": 1})
    row = api.sql("SELECT status FROM bams_alert_events WHERE id = ?", (ev["id"],))[0]
    assert row["status"] == "recovered"
    mid = api.sql("SELECT metric_id FROM bams_alert_events WHERE status='open' AND rule_id IS NOT NULL LIMIT 1")[0]["metric_id"]
    post(api, "/api/dev/bams/simulate-stale", {"metric_id": mid, "on": True})
    post(api, "/api/dev/bams/clock", {"advance_seconds": 600})
    post(api, "/api/dev/bams/poll")
    assert api.sql("SELECT status FROM bams_alert_events WHERE metric_id = ? AND rule_id IS NOT NULL AND status<>'closed'", (mid,))[0]["status"] == "open"


# ------------------------------------------------------------------ B-2: set-based spark parity
def _legacy_spark(conn, metric_id, now):
    """The pre-0.2.0 implementation: 24 queries per metric (kept here as the reference oracle)."""
    from server.bams.clock import fmt
    out = []
    for i in range(23, -1, -1):
        hi = now - dt.timedelta(hours=i)
        r = conn.execute("SELECT value FROM bams_metric_samples WHERE metric_id = :m AND sampled_at <= :hi"
                         " AND sampled_at >= :lo ORDER BY sampled_at DESC LIMIT 1",
                         {"m": metric_id, "hi": fmt(hi), "lo": fmt(hi - dt.timedelta(hours=1))}).fetchone()
        if r:
            out.append(r[0])
    return out


def test_spark_many_matches_legacy_per_bucket_queries(b):
    import random
    from server.bams import reads
    from server.bams.clock import fmt
    mids = [setup_metric(b, name=f"Co{i}", obj=f"B{i}", ticker=f"T{i}")[2] for i in range(3)]
    now = T0
    rnd = random.Random(7)
    with b.rt.db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for n, mid in enumerate(mids):
            # n=0: dense (every 7 min), n=1: sparse with gaps and samples exactly on bucket boundaries, n=2: none
            if n == 0:
                times = [now - dt.timedelta(minutes=7 * k) for k in range(0, 24 * 9)]
            elif n == 1:
                times = [now - dt.timedelta(hours=h) for h in (0, 1, 5, 5.5, 13, 23.5, 24, 30)]
            else:
                times = []
            for t in times:
                conn.execute("INSERT INTO bams_metric_samples (metric_id, sampled_at, value) VALUES (?, ?, ?)",
                             (mid, fmt(t), round(rnd.uniform(0, 100), 1)))
        conn.execute("COMMIT")
        new = reads.spark_many(conn, mids, now)
        for mid in mids:
            assert new[mid] == _legacy_spark(conn, mid, now) == reads.spark(conn, mid, now)
        assert new[mids[0]] and new[mids[1]] and new[mids[2]] == []
        assert reads.spark_many(conn, [], now) == {}


def test_spark_many_chunks_large_metric_lists(b):
    """More metrics than one statement's bound-parameter budget: results stay keyed and ordered per metric."""
    from server.bams import reads
    mid = setup_metric(b)[2]
    with b.rt.db() as conn:
        ids = [f"ghost-{i}" for i in range(700)] + [mid]
        out = reads.spark_many(conn, ids, T0)
    assert len(out) == 701 and out[mid] == [] and all(v == [] for v in out.values())


# ------------------------------------------------------------------ B-3: trend zoom window (from/to)
def _seed_samples(api, mid, times):
    from server.bams.clock import fmt
    with api.rt.db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for k, t in enumerate(times):
            conn.execute("INSERT INTO bams_metric_samples (metric_id, sampled_at, value) VALUES (?, ?, ?)", (mid, fmt(t), float(k)))
        conn.execute("COMMIT")


def test_trend_zoom_window(b):
    from server.bams.clock import fmt
    mid = setup_metric(b)[2]
    url = f"/api/bams/metric/{mid}/trend"
    now = T0
    _seed_samples(b, mid, [now - dt.timedelta(minutes=m) for m in range(0, 120)])        # 1/min for 2h
    w = dict(**{"from": fmt(now - dt.timedelta(minutes=30)), "to": fmt(now - dt.timedelta(minutes=20))})
    it = b.get(url, **w).json()["item"]
    assert it["range"] == "custom" and it["from"] == w["from"] and it["to"] == w["to"] and it["downsampled"] is False
    assert len(it["points"]) == 11 and it["points"][0]["t"] == w["to"][:0] + fmt(now - dt.timedelta(minutes=30))
    assert it["text"]["count"] == 11 and it["sample_interval_seconds"] == 60
    # range-based behaviour unchanged when from/to are absent
    assert b.get(url, range="24h").json()["item"]["range"] == "24h"
    # empty window
    e = b.get(url, **{"from": fmt(now - dt.timedelta(days=3)), "to": fmt(now - dt.timedelta(days=2))}).json()["item"]
    assert e["points"] == [] and e["text"]["count"] == 0
    # errors
    bad = lambda **q: b.get(url, **q)  # noqa: E731
    assert bad(**{"from": w["to"], "to": w["from"]}).status_code == 422
    assert bad(**{"from": w["from"], "to": w["from"]}).status_code == 422
    assert bad(**{"from": w["from"]}).status_code == 422
    assert bad(**{"to": w["to"]}).status_code == 422
    assert bad(**{"from": "nope", "to": w["to"]}).json()["error"]["code"] == "validation_error"
    assert bad(**{"from": fmt(now - dt.timedelta(days=8)), "to": fmt(now)}).status_code == 422          # > 7 days
    old = now - dt.timedelta(days=101)
    r = bad(**{"from": fmt(old), "to": fmt(old + dt.timedelta(hours=1))})
    assert r.status_code == 422 and "from" in r.json()["error"]["fields"]                              # outside retention
    assert bad(**{"from": fmt(now + dt.timedelta(hours=1)), "to": fmt(now + dt.timedelta(hours=2))}).status_code == 422
    assert b.get(f"/api/bams/metric/ghost/trend", **w).status_code == 404


def test_trend_zoom_downsamples_over_the_cap_keeping_first_and_last(b):
    from server.bams.clock import fmt
    mid = setup_metric(b)[2]
    start = T0 - dt.timedelta(hours=2)
    _seed_samples(b, mid, [start + dt.timedelta(seconds=2 * k) for k in range(3000)])                # 3000 samples in 100 min
    it = b.get(f"/api/bams/metric/{mid}/trend", **{"from": fmt(start), "to": fmt(T0)}).json()["item"]
    assert it["downsampled"] is True and len(it["points"]) == 2000 and it["text"]["count"] == 3000
    assert it["points"][0]["t"] == fmt(start) and it["points"][-1]["t"] == fmt(start + dt.timedelta(seconds=2 * 2999))
    ts = [p["t"] for p in it["points"]]
    assert ts == sorted(set(ts))
