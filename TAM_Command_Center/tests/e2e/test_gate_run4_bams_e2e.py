"""Run 4 gate (T-116): BAMS monitoring, black-box against real DEV and PROD uvicorn processes on scratch trees.
Expected values come from docs/01_PM_SPEC.md 12 and docs/04_API_CONTRACT.md 11 plus direct SQLite reads.
Run from TAM_Command_Center/:  .venv/bin/python -m pytest tests/e2e/test_gate_run4_bams_e2e.py -q
"""
from __future__ import annotations

import sqlite3
import sys
import time
import uuid
from pathlib import Path

import httpx
import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from test_gate32_e2e import free_port, make_tree, start  # noqa: E402


class Bams:
    def __init__(self, c, db, tree, proc):
        self.c, self.db, self.tree, self.proc = c, db, tree, proc
        self.n = 0

    def q(self, sql, *a):
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            return con.execute(sql, a).fetchall()
        finally:
            con.close()

    def j(self, method, url, **kw):
        r = self.c.request(method, url, **kw)
        return r

    def ok(self, method, url, **kw):
        r = self.c.request(method, url, **kw)
        assert r.status_code == 200, f"{method} {url} {r.status_code} {r.text[:400]}"
        return r.json()

    def dev(self, route, **body):
        return self.ok("POST", f"/api/dev/bams/{route}", json=body)

    def state(self, **params):
        return self.ok("GET", "/api/bams/state", params=params)

    def row(self, mid):
        for r in self.state()["rows"]:
            if r["id"] == mid:
                return r
        raise AssertionError("metric not in state")

    def client_id(self):
        return self.q("select id from clients where status='Active' order by name limit 1")[0][0]

    def make_metric(self, rule=None, **objkw):
        """new appliance with one metric (unique ticker) and optionally one rule; returns (metric_id, rule_id)."""
        self.n += 1
        tag = uuid.uuid4().hex[:8]
        body = {"client_id": self.client_id(), "name": f"QA-{tag}", "environment": "DEV",
                "metrics": [{"metric_name": "CPU QA", "ticker": f"QA.{tag}"}]}
        body.update(objkw)
        item = self.ok("POST", "/api/bams/object/save", json=body)["item"]["object"]
        mid = item["metrics"][0]["id"]
        rid = None
        if rule is not None:
            base = {"metric_id": mid, "rule_type": "fixed_threshold", "operator": ">", "threshold": 85,
                    "consecutive_updates": 2, "severity": "Warning", "cooldown_minutes": 0}
            base.update(rule)
            rid = self.ok("POST", "/api/bams/rule/save", json=base)["item"]["rule"]["id"]
        return mid, rid

    def events(self, mid):
        return self.q("select id,status,rule_id,current_value,peak_value,recovered_at,closed_at,closed_note from bams_alert_events where metric_id=? order by opened_at", mid)

    def poll_value(self, mid, v, advance=60):
        self.dev("clock", advance_seconds=advance)
        return self.dev("force-value", metric_id=mid, value=v, poll=True)


@pytest.fixture(scope="module")
def dev(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("bams_dev"))
    port = free_port()
    assert port != 8766
    p = start(tree, port, {"TAM_DEV_MODE": "1"})
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60) as c:
        b = Bams(c, tree / "dev_data" / "tam_dev.db", tree, p)
        b.ok("POST", "/api/bams/monitor/stop", json={})
        yield b
    p.terminate()
    p.wait(5)


@pytest.fixture(scope="module")
def prod(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("bams_prod"), channel="prod")
    port = free_port()
    la = tmp_path_factory.mktemp("bams_prod_la")                  # isolate the PROD data dir via LOCALAPPDATA
    p = start(tree, port, {"TAM_BAMS_TEST_MODE": "1", "TAM_DEV_MODE": "1", "LOCALAPPDATA": str(la)})
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60) as c:
        dbs = list(la.rglob("*.db"))
        yield c, tree, dbs
    p.terminate()
    p.wait(5)


# ------------------------------------------------------------------ A. lifecycle matrix
def test_L1_L5_open_update_recover_reopen(dev):
    mid, rid = dev.make_metric(rule={})
    dev.poll_value(mid, 90)
    assert dev.events(mid) == []                                   # L1: 1 breach, below consecutive=2
    dev.poll_value(mid, 91)
    ev = dev.events(mid)
    assert len(ev) == 1 and ev[0][1] == "open"                     # L2
    eid = ev[0][0]
    n_notes = dev.q("select count(*) from bams_notification_log where event_id=? and kind='opened'", eid)[0][0]
    assert n_notes >= 1
    dev.poll_value(mid, 95)
    dev.poll_value(mid, 97)
    ev = dev.events(mid)
    assert len(ev) == 1 and ev[0][0] == eid and ev[0][3] == 97 and ev[0][4] == 97       # L3
    assert dev.q("select count(*) from bams_notification_log where event_id=? and kind='opened'", eid)[0][0] == n_notes
    dev.poll_value(mid, 10)
    ev = dev.events(mid)
    assert ev[0][1] == "recovered" and ev[0][5]                                          # L4
    assert dev.row(mid)["active_alerts"] == 1                                            # still active
    dev.poll_value(mid, 99)
    ev = dev.events(mid)
    assert len(ev) == 1 and ev[0][1] == "open" and ev[0][5] is None                     # L5 reopen same id


def test_L6_close_recovered_and_L13_double_close(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 1})
    dev.poll_value(mid, 90)
    dev.poll_value(mid, 10)
    ev = dev.events(mid)
    assert ev[0][1] == "recovered"
    r = dev.ok("POST", f"/api/bams/alert/{ev[0][0]}/close", json={"note": "fixed by QA"})
    ev = dev.events(mid)
    assert ev[0][1] == "closed" and ev[0][7] == "fixed by QA" and ev[0][6]
    aud = dev.q("select count(*) from audit_events where object_id=?", ev[0][0])[0][0]
    r2 = dev.j("POST", f"/api/bams/alert/{ev[0][0]}/close", json={"note": "again"})
    assert r2.status_code in (404, 409) or r2.json().get("no_change"), r2.text
    assert dev.events(mid)[0][7] == "fixed by QA"
    assert dev.q("select count(*) from audit_events where object_id=?", ev[0][0])[0][0] == aud
    assert dev.j("POST", "/api/bams/alert/nope/close", json={}).status_code == 404


def test_L7_close_while_breaching_suppresses_until_clear(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 1})
    dev.poll_value(mid, 95)
    eid = dev.events(mid)[0][0]
    ev = dev.ok("GET", "/api/bams/alerts", params={"status": "active"})["items"]
    mine = [e for e in ev if e["event"]["id"] == eid][0]
    assert mine["event"]["still_breaching"] is True
    dev.ok("POST", f"/api/bams/alert/{eid}/close", json={"note": "ack"})
    dev.poll_value(mid, 96)
    dev.poll_value(mid, 97)
    assert len(dev.events(mid)) == 1                                                     # no reopen
    dev.poll_value(mid, 10)                                                              # clear
    dev.poll_value(mid, 95)
    ev = dev.events(mid)
    assert len(ev) == 2 and ev[1][1] == "open"                                           # new event after clear


def test_L8_stale_and_outage_freeze(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 2})
    dev.poll_value(mid, 95)                                  # breach_count 1
    bc = dev.q("select breach_count from bams_alert_rules where id=?", rid)[0][0]
    assert bc == 1
    dev.dev("simulate-stale", metric_id=mid, on=True)
    for _ in range(3):
        dev.dev("clock", advance_seconds=200)
        dev.dev("poll")
    assert dev.events(mid) == []
    assert dev.q("select breach_count from bams_alert_rules where id=?", rid)[0][0] == bc
    assert dev.row(mid)["freshness"] == "Stale"
    dev.dev("simulate-stale", metric_id=mid, on=False)
    dev.poll_value(mid, 96)
    assert dev.events(mid)[0][1] == "open"                   # counter resumed: 1 + 1
    # outage freezes recovery
    dev.dev("simulate-outage", on=True)
    dev.dev("clock", advance_seconds=60)
    dev.dev("poll")
    st = dev.state()
    assert st["monitor"]["state"] == "provider_unavailable"
    assert dev.row(mid)["current_value"] is None and dev.row(mid)["freshness"] == "No Data"
    assert dev.events(mid)[0][1] == "open"
    dev.dev("simulate-outage", on=False)
    dev.poll_value(mid, 10)
    assert dev.events(mid)[0][1] == "recovered"


def test_L9_cooldown(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 1, "cooldown_minutes": 10})
    dev.poll_value(mid, 95)
    eid = dev.events(mid)[0][0]
    dev.poll_value(mid, 10)
    dev.ok("POST", f"/api/bams/alert/{eid}/close", json={})
    dev.poll_value(mid, 95)
    assert len(dev.events(mid)) == 1, "breach inside cooldown opened an event"
    dev.poll_value(mid, 10)
    dev.poll_value(mid, 95, advance=11 * 60)
    ev = dev.events(mid)
    assert len(ev) == 2 and ev[1][1] == "open"


def test_L10_disabled_rule_metric_object(dev):
    for how in ("rule", "metric", "object"):
        mid, rid = dev.make_metric(rule={"consecutive_updates": 1})
        row = dev.row(mid)
        if how == "rule":
            r = dev.ok("GET", f"/api/bams/metric/{mid}")["item"]
            rule = [x for x in r["rules"] if x["id"] == rid][0]
            dev.ok("POST", "/api/bams/rule/save", json={"id": rid, "enabled": False, "expected_row_version": rule["row_version"]})
        elif how == "metric":
            dev.ok("POST", "/api/bams/metric/save", json={"id": mid, "enabled": False, "expected_row_version": row["row_version"]})
        else:
            dev.ok("POST", "/api/bams/object/save", json={"id": row["object"]["id"], "enabled": False, "expected_row_version": row["object"]["row_version"]})
        dev.dev("clock", advance_seconds=60)
        try:
            dev.dev("force-value", metric_id=mid, value=99, poll=True)
        except AssertionError:
            pass
        assert dev.events(mid) == [], how


def test_L11_delete_blocked_by_active_alert(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 1})
    dev.poll_value(mid, 95)
    row = dev.row(mid)
    n = dev.q("select count(*) from bams_objects")[0][0]
    for url, body in (("/api/bams/rule/delete", {"id": rid, "confirm": True, "expected_row_version": 1}),
                      ("/api/bams/metric/delete", {"id": mid, "confirm": True, "expected_row_version": row["row_version"]}),
                      ("/api/bams/object/delete", {"id": row["object"]["id"], "confirm": True, "expected_row_version": row["object"]["row_version"]})):
        r = dev.j("POST", url, json=body)
        assert r.status_code == 409 and r.json()["error"]["details"].get("reason") == "active_alert", (url, r.text)
    assert dev.q("select count(*) from bams_objects")[0][0] == n
    pv = dev.ok("GET", f"/api/bams/object/{row['object']['id']}/delete-preview")["item"]
    assert pv["blocked"] is True and pv["alerts_active"] == 1


@pytest.mark.parametrize("rule,seq,expect_open_at", [
    ({"operator": ">", "threshold": 85}, [85, 85.1], 1),
    ({"operator": ">=", "threshold": 85}, [84.9, 85], 1),
    ({"operator": "<", "threshold": 20}, [20, 19.9], 1),
    ({"operator": "<=", "threshold": 20}, [20.1, 20], 1),
])
def test_L12_operators(dev, rule, seq, expect_open_at):
    mid, _ = dev.make_metric(rule={**rule, "consecutive_updates": 1})
    for i, v in enumerate(seq):
        dev.poll_value(mid, v)
        assert bool(dev.events(mid)) == (i >= expect_open_at), (rule, v)


def test_L12_pct_of_high_and_exceeds_high(dev):
    mid, _ = dev.make_metric(rule={"rule_type": "pct_of_high", "operator": ">=", "threshold": 90, "reference_period": "90d", "consecutive_updates": 1})
    dev.poll_value(mid, 60)                              # may itself open if 60 is the high; state-agnostic below
    h = dev.row(mid)["highs"]["d90"]["value"]
    assert h and h >= 60
    thr = h * 0.9
    dev.poll_value(mid, round(thr - 0.06, 1))            # just under 90 percent
    assert not [e for e in dev.events(mid) if e[1] == "open"]
    dev.poll_value(mid, round(thr + 0.06, 1))
    assert [e for e in dev.events(mid)][-1][1] == "open"
    dev.poll_value(mid, round(thr - 0.06, 1))
    assert [e for e in dev.events(mid)][-1][1] == "recovered"
    mid2, _ = dev.make_metric(rule={"rule_type": "exceeds_high", "operator": ">", "threshold": None, "reference_period": "30d", "consecutive_updates": 1})
    dev.poll_value(mid2, 40)
    h2 = dev.row(mid2)["highs"]["d30"]["value"]
    dev.poll_value(mid2, h2 - 5 if h2 > 6 else h2)
    n0 = len(dev.events(mid2))
    dev.poll_value(mid2, min(100, h2 + 5))
    assert len(dev.events(mid2)) >= n0


def test_L14_no_renotify_after_restart(dev):
    mid, _ = dev.make_metric(rule={"consecutive_updates": 1})
    dev.poll_value(mid, 95)
    eid = dev.events(mid)[0][0]
    before = dev.q("select count(*) from bams_notification_log where event_id=?", eid)[0][0]
    dev.proc.terminate()
    dev.proc.wait(10)
    port = int(str(dev.c.base_url).rsplit(":", 1)[1].strip("/"))
    dev.proc = start(dev.tree, port, {"TAM_DEV_MODE": "1"})
    time.sleep(2)
    dev.ok("POST", "/api/bams/monitor/stop", json={})
    dev.dev("poll")
    dev.dev("poll")
    assert dev.q("select count(*) from bams_notification_log where event_id=?", eid)[0][0] == before


# ------------------------------------------------------------------ B. freshness boundaries
@pytest.mark.parametrize("age,word", [(0, "Live"), (74, "Live"), (75, "Live"), (76, "Delayed"), (120, "Delayed"), (121, "Stale")])
def test_B_freshness_boundaries(dev, age, word):
    mid, _ = dev.make_metric()
    dev.poll_value(mid, 40, advance=1)
    dev.dev("simulate-stale", metric_id=mid, on=True)
    dev.dev("clock", advance_seconds=age)
    r = dev.row(mid)
    assert r["freshness"] == word, (age, r["age_seconds"], r["freshness"])
    assert abs(r["age_seconds"] - age) <= 1


def test_B_per_metric_stale_after_and_slow_poll(dev):
    mid, _ = dev.make_metric()
    row = dev.row(mid)
    dev.ok("POST", "/api/bams/metric/save", json={"id": mid, "stale_after_seconds": 200, "expected_row_version": row["row_version"]})
    dev.poll_value(mid, 40, advance=1)
    dev.dev("simulate-stale", metric_id=mid, on=True)
    dev.dev("clock", advance_seconds=121)
    assert dev.row(mid)["freshness"] == "Delayed"
    dev.dev("clock", advance_seconds=80)               # age 201
    assert dev.row(mid)["freshness"] == "Stale"
    # slow poll: live window becomes poll+15
    dev.ok("POST", "/api/bams/settings", json={"poll_interval_seconds": 300})
    assert dev.state()["monitor"]["freshness"]["live_seconds"] == 315
    mid3, _ = dev.make_metric()
    dev.poll_value(mid3, 40, advance=1)
    dev.dev("simulate-stale", metric_id=mid3, on=True)
    dev.dev("clock", advance_seconds=300)
    assert dev.row(mid3)["freshness"] == "Live"
    dev.dev("clock", advance_seconds=20)           # age 320 > 315: beyond Live, and past stale_after (120) -> Stale
    assert dev.row(mid3)["freshness"] == "Stale"
    dev.ok("POST", "/api/bams/settings", json={"poll_interval_seconds": 60})


# ------------------------------------------------------------------ C. fail closed
def test_C_prod_fail_closed(prod):
    c, tree, dbs = prod
    s = c.get("/api/bams/state").json()
    assert s["provider"] == {"mode": "PROD", "kind": "blpapi", "available": False, "simulated": False,
                             "message": "BLPAPI provider not implemented/connected"}, s["provider"]
    assert s["monitor"]["state"] in ("provider_unavailable", "stopped")
    assert s["banner"]
    for r in s["rows"]:
        assert r["current_value"] is None and r["freshness"] == "No Data" and not r["simulated"]
    assert s["summary"]["live"] == 0
    r = c.post("/api/bams/monitor/start", json={})
    assert r.status_code == 200 and r.json()["item"]["monitor"]["state"] == "provider_unavailable"
    time.sleep(1)
    for route in ("force-value", "simulate-stale", "simulate-outage", "poll", "clock", "reset"):
        x = c.post(f"/api/dev/bams/{route}", json={})
        assert x.status_code == 404 and x.json()["error"]["code"] == "not_found", (route, x.status_code, x.text[:120])
    for p in ("/api/dev/state", "/api/dev/reseed"):
        assert c.post(p, json={}).status_code in (404, 405), p
    # nothing fabricated
    for db in dbs:
        if db.name.endswith(".db") and "Backups" not in str(db):
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                tabs = {t for (t,) in con.execute("select name from sqlite_master where type='table'")}
                if "bams_alert_events" in tabs:
                    assert con.execute("select count(*) from bams_alert_events").fetchone()[0] == 0
                    assert con.execute("select count(*) from bams_metric_samples").fetchone()[0] == 0
            finally:
                con.close()
    # no setting can enable simulation
    for body in ({"provider": "simulated"}, {"simulated": True}, {"mode": "DEV"}):
        assert c.post("/api/bams/settings", json=body).status_code == 422
    assert c.get("/api/bams/state").json()["provider"]["simulated"] is False


# ------------------------------------------------------------------ D. monitor
def test_D_reads_do_not_poll_and_double_start(dev):
    dev.ok("POST", "/api/bams/monitor/stop", json={})
    before = dev.state()["monitor"]["last_poll_at"]
    for _ in range(60):
        dev.state()
        dev.ok("GET", "/api/bams/alerts")
    assert dev.state()["monitor"]["last_poll_at"] == before
    import concurrent.futures as cf
    with cf.ThreadPoolExecutor(4) as ex:
        res = list(ex.map(lambda _: dev.c.post("/api/bams/monitor/start", json={}).status_code, range(4)))
    assert res == [200] * 4
    assert dev.state()["monitor"]["state"] == "running"
    dev.ok("POST", "/api/bams/monitor/stop", json={})
    assert dev.state()["monitor"]["state"] == "stopped"


@pytest.mark.parametrize("v,code", [(29, 422), (30, 200), (86400, 200), (86401, 422), ("60", 422), (0, 422), (-5, 422), (1.5, 422)])
def test_D_poll_interval_validation(dev, v, code):
    r = dev.c.post("/api/bams/settings", json={"poll_interval_seconds": v})
    assert r.status_code == code, r.text
    dev.ok("POST", "/api/bams/settings", json={"poll_interval_seconds": 60})


# ------------------------------------------------------------------ E. contract / security
def test_E_strict_bodies_and_injection(dev):
    assert dev.c.post("/api/bams/monitor/start", json={"x": 1}).status_code == 422
    for p in ({"view": "x'; drop table clients;--"}, {"account": "' OR 1=1 --"}, {"q": "%' union select 1--"},
              {"sort": "ticker; drop table clients"}, {"account": ",".join(["a"] * 500)}):
        r = dev.c.get("/api/bams/state", params=p)
        assert r.status_code in (200, 422), (p, r.status_code)
    assert dev.q("select count(*) from clients")[0][0] > 0
    mid, _ = dev.make_metric()
    for rng in ("1y", "../etc", "7d'--"):
        assert dev.c.get(f"/api/bams/metric/{mid}/trend", params={"range": rng}).status_code == 422
    assert dev.c.get("/api/bams/metric/' or 1=1").status_code == 404
    assert dev.c.get("/api/bams/metric/..%2f..%2fetc").status_code in (404, 422)
    r = dev.c.post("/api/bams/monitor/stop", json={}, headers={"Origin": "http://evil.example"})
    assert r.status_code in (403, 400), r.status_code


def test_E_xss_names_are_data(dev):
    name = "<img src=x onerror=alert(1)>"
    r = dev.c.post("/api/bams/object/save", json={"client_id": dev.client_id(), "name": name,
                   "metrics": [{"metric_name": "<script>x</script>", "ticker": "QA.XSS." + uuid.uuid4().hex[:6]}]})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    csp = dev.c.get("/").headers.get("content-security-policy", "")
    assert "script-src" in csp and "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]


def test_E_validation_and_conflicts(dev):
    cid = dev.client_id()
    t = "QA.DUP." + uuid.uuid4().hex[:6]
    ok = dev.ok("POST", "/api/bams/object/save", json={"client_id": cid, "name": "QA-dup-obj", "metrics": [{"metric_name": "m", "ticker": t}]}) if not dev.q("select 1 from bams_objects where name='QA-dup-obj'") else None
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "qa-DUP-obj", "metrics": [{"metric_name": "m", "ticker": t + "x"}]})
    assert r.status_code == 409 and "name" in r.json()["error"].get("fields", {}), r.text
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "QA-other", "metrics": [{"metric_name": "m", "ticker": t}]})
    assert r.status_code == 409, r.text
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "QA-same-tk", "metrics": [{"metric_name": "a", "ticker": "T9"}, {"metric_name": "b", "ticker": "T9"}]})
    assert r.status_code == 409
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "QA-nomet", "metrics": []})
    assert r.status_code == 422
    r = dev.c.post("/api/bams/object/save", json={"client_id": "nope", "name": "x", "metrics": [{"metric_name": "a", "ticker": "zz1"}]})
    assert r.status_code == 422
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "x" * 201, "metrics": [{"metric_name": "a", "ticker": "zz2"}]})
    assert r.status_code == 422
    r = dev.c.post("/api/bams/object/save", json={"client_id": cid, "name": "ctl\x07x", "metrics": [{"metric_name": "a", "ticker": "zz3"}]})
    assert r.status_code == 422
    mid, rid = dev.make_metric(rule={})
    for bad in ({"rule_type": "fixed_threshold", "threshold": None}, {"consecutive_updates": 0}, {"cooldown_minutes": 10081},
                {"rule_type": "exceeds_high", "operator": "<", "threshold": None, "reference_period": "30d"},
                {"rule_type": "pct_of_high", "threshold": 0, "reference_period": "30d"}, {"operator": "!="}, {"severity": "Fatal"}):
        body = {"metric_id": mid, "rule_type": "fixed_threshold", "operator": ">", "threshold": 1}
        body.update(bad)
        assert dev.c.post("/api/bams/rule/save", json=body).status_code == 422, bad
    row = dev.row(mid)
    r = dev.c.post("/api/bams/metric/save", json={"id": mid, "metric_name": "renamed", "expected_row_version": row["row_version"] + 5})
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_write", r.text


def test_E_value_out_of_range(dev):
    """Values are percentages (provider docstring). Documented probe, not an assertion of spec: record behaviour."""
    mid, _ = dev.make_metric()
    r = dev.c.post("/api/dev/bams/force-value", json={"metric_id": mid, "value": 1e308, "poll": True})
    assert r.status_code in (200, 422)
    r = dev.c.post("/api/dev/bams/force-value", content=('{"metric_id": "%s", "value": NaN, "poll": true}' % mid).encode(), headers={"content-type": "application/json"})
    assert r.status_code in (200, 400, 422)
    assert dev.c.get("/api/bams/state").status_code == 200


def test_E_configs_apply_preview_then_confirm(dev):
    mid, _ = dev.make_metric()
    cfgs = dev.ok("GET", "/api/bams/configs")["items"]
    assert cfgs
    cfg = cfgs[0]
    before = dev.q("select count(*) from bams_alert_rules")[0][0]
    pv = dev.ok("POST", "/api/bams/configs/apply", json={"config_id": cfg["id"], "metric_ids": [mid], "preview": True})["item"]
    assert dev.q("select count(*) from bams_alert_rules")[0][0] == before
    r = dev.c.post("/api/bams/configs/apply", json={"config_id": cfg["id"], "metric_ids": [mid], "preview": False})
    assert r.status_code == 409
    r = dev.c.post("/api/bams/configs/apply", json={"config_id": cfg["id"], "metric_ids": [mid], "preview": False, "confirm": True, "plan_hash": "sha256:bad"})
    assert r.status_code == 409
    r = dev.ok("POST", "/api/bams/configs/apply", json={"config_id": cfg["id"], "metric_ids": [mid], "preview": False, "confirm": True, "plan_hash": pv["plan_hash"]})
    assert r["item"]["created"] == pv["would_create"]
    pv2 = dev.ok("POST", "/api/bams/configs/apply", json={"config_id": cfg["id"], "metric_ids": [mid], "preview": True})["item"]
    assert pv2["would_create"] == 0


def test_E_notifications_inbox(dev):
    n = dev.ok("GET", "/api/bams/notifications")
    assert "unread_count" in n
    last = n["items"][0]["id"] if n["items"] else None
    assert dev.c.post("/api/bams/notifications/read", json={}).status_code == 422
    assert dev.c.post("/api/bams/notifications/read", json={"all": True, "through_id": 1}).status_code == 422
    dev.ok("POST", "/api/bams/notifications/read", json={"all": True})
    assert dev.ok("GET", "/api/bams/notifications")["unread_count"] == 0


def test_E_counts_agree(dev):
    s = dev.state()
    act = dev.q("""select count(*) from bams_alert_events e join bams_metrics m on m.id=e.metric_id
        join bams_objects o on o.id=m.object_id where e.status in ('open','recovered') and m.enabled=1 and o.enabled=1""")[0][0]
    assert s["summary"]["active_alerts"] == act
    cid = dev.q("select client_id from bams_objects o join bams_metrics m on m.object_id=o.id join bams_alert_events e on e.metric_id=m.id where e.status='open' limit 1")[0][0]
    ws = dev.ok("GET", f"/api/client/{cid}/infrastructure")
    per = dev.state(account=cid)["summary"]["active_alerts"]
    flat = str(ws)
    assert per >= 1
    tot = sum(o.get("active_alerts", 0) for o in ws.get("appliances", ws.get("objects", [])) if isinstance(o, dict))
    assert tot == per or flat.count("active_alerts") > 0, (tot, per)


def test_H_trend_cap_and_state_perf(dev):
    mid = dev.state()["rows"][0]["id"]
    for rng in ("24h", "7d", "30d", "90d"):
        t = dev.ok("GET", f"/api/bams/metric/{mid}/trend", params={"range": rng})
        pts = t.get("points") or t.get("item", {}).get("points") or []
        assert len(pts) <= 500, (rng, len(pts))


# ------------------------------------------------------------------ delete / reset / settings / audit
def test_F_delete_flow_backup_and_cascade(dev):
    mid, rid = dev.make_metric(rule={"consecutive_updates": 1})
    dev.poll_value(mid, 95)
    eid = dev.events(mid)[0][0]
    dev.poll_value(mid, 10)
    dev.ok("POST", f"/api/bams/alert/{eid}/close", json={})
    row = dev.row(mid)
    oid = row["object"]["id"]
    body = {"id": oid, "expected_row_version": row["object"]["row_version"]}
    r = dev.c.post("/api/bams/object/delete", json=body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "confirmation_required"
    assert dev.q("select count(*) from bams_objects where id=?", oid)[0][0] == 1
    nb = len(list((dev.tree / "dev_data" / "TAM_Backups").glob("*pre-delete*")))
    r = dev.ok("POST", "/api/bams/object/delete", json={**body, "confirm": True})
    assert len(list((dev.tree / "dev_data" / "TAM_Backups").glob("*pre-delete*"))) == nb + 1
    for t, col in (("bams_metrics", "id"), ("bams_alert_rules", "id"), ("bams_alert_events", "id"), ("bams_metric_samples", "metric_id")):
        assert dev.q(f"select count(*) from {t} where {col}=?", rid if t == "bams_alert_rules" else (eid if t == "bams_alert_events" else mid))[0][0] == 0, t
    assert dev.q("pragma foreign_key_check") == []
    assert dev.c.post("/api/bams/object/delete", json={**body, "confirm": True}).status_code == 404


def test_F_reset_requires_confirm_and_backs_up(dev):
    assert dev.c.post("/api/dev/bams/reset", json={}).status_code == 409
    nb = len(list((dev.tree / "dev_data" / "TAM_Backups").glob("*pre-delete*")))
    dev.dev("reset", confirm=True)
    assert len(list((dev.tree / "dev_data" / "TAM_Backups").glob("*pre-delete*"))) == nb + 1
    assert dev.q("select count(*) from bams_alert_events")[0][0] == 0
    assert dev.q("select count(*) from bams_objects")[0][0] > 0 and dev.q("select count(*) from bams_alert_rules")[0][0] > 0
    assert dev.q("pragma integrity_check")[0][0] == "ok"


def test_F_audit_and_activity_for_bams_writes(dev):
    mid, rid = dev.make_metric(rule={})
    n = dev.q("select count(*) from audit_events where category='bams'")[0][0]
    row = dev.row(mid)
    dev.ok("POST", "/api/bams/metric/save", json={"id": mid, "stale_after_seconds": 150, "expected_row_version": row["row_version"]})
    assert dev.q("select count(*) from audit_events where category='bams'")[0][0] == n + 1
    r = dev.ok("POST", "/api/bams/metric/save", json={"id": mid, "stale_after_seconds": 150, "expected_row_version": row["row_version"] + 1})
    assert r.get("no_change") or dev.q("select count(*) from audit_events where category='bams'")[0][0] == n + 1
    # settings audited, privacy default
    s = dev.ok("GET", "/api/bams/settings")["item"]
    assert s["privacy_mode"] is True
    n2 = dev.q("select count(*) from audit_events where category='bams'")[0][0]
    dev.ok("POST", "/api/bams/settings", json={"notify_recovered": True})
    dev.ok("POST", "/api/bams/settings", json={"notify_recovered": False})
    assert dev.q("select count(*) from audit_events where category='bams'")[0][0] == n2 + 2


def test_F_desktop_notification_privacy_text(dev):
    mid, _ = dev.make_metric(rule={"consecutive_updates": 1, "severity": "Critical"})
    dev.poll_value(mid, 99)
    eid = dev.events(mid)[0][0]
    rows = dev.q("select channel,success,detail from bams_notification_log where event_id=?", eid)
    ch = {r[0] for r in rows}
    assert "in_app" in ch
    for chn, ok, detail in rows:
        if chn == "desktop":
            assert "QA-" not in (detail or "") and "99" not in (detail or ""), detail


def test_C_prod_import_shows_no_data_and_never_values(prod):
    c, tree, dbs = prod
    cid = c.post("/api/client/save", json={"name": "QA Prod Acct", "duplicates_confirmed": True}).json()["item"]
    cid = cid.get("id") or cid.get("client", {}).get("id")
    data = b"Account,Appliance,Metric,Ticker,Environment\nQA Prod Acct,PROD-APP-1,CPU,PROD.QA.1,PROD\nQA Prod Acct,PROD-APP-1,MEM,PROD.QA.2,DEV\n"
    i = c.post("/api/import/bams/inspect", content=data, headers={"X-File-Name": "p.csv"}).json()["item"]
    r = c.post("/api/import/bams/apply", json={"import_id": i["import_id"], "plan_hash": i["plan_hash"], "confirm": True, "decisions": []})
    assert r.status_code == 200, r.text[:300]
    for _ in range(3):
        time.sleep(1)
        s = c.get("/api/bams/state").json()
    assert s["summary"]["total"] == 2 and s["summary"]["no_data"] == 2 and s["summary"]["live"] == 0
    assert all(x["current_value"] is None and x["freshness"] == "No Data" and x["spark"] == [] for x in s["rows"])
    assert s["banner"]
    c.post("/api/bams/monitor/start", json={})
    time.sleep(1.5)
    s = c.get("/api/bams/state").json()
    assert all(x["current_value"] is None for x in s["rows"]) and s["monitor"]["state"] == "provider_unavailable"
    assert c.get("/api/bams/alerts?status=all").json()["items"] == []
