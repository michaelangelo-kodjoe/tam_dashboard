"""Run 2 gate (T-76, ERROR_LOG_3): Today triage data, done-today ring, instrument data honesty.

Independent of the backend code: expected values are recomputed straight from the SQLite file with the PM spec
definitions (docs/01_PM_SPEC.md 10.2, 10.3, 10.4) and compared with what the live DEV server returns. Starts real
DEV uvicorn processes (fresh DB, auto-seed) from a temp copy, under three process timezones.
Run from TAM_Command_Center/:  .venv/bin/python -m pytest tests/e2e/test_gate_run2_e2e.py -q
"""
from __future__ import annotations

import datetime as dt
import sqlite3
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_gate32_e2e import free_port, make_tree, start  # noqa: E402

TIERS = {1: "Overdue", 2: "Due", 3: "Alerts", 4: "Waiting", 5: "Upgrades", 6: "Upcoming"}
PRIO = {"High": 0, "Medium": 1, "Low": 2}


@pytest.fixture(scope="module", params=["America/New_York", "Pacific/Auckland", "UTC"])
def srv(request, tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("run2"))
    port = free_port()
    p = start(tree, port, {"TAM_DEV_MODE": "1", "TZ": request.param})
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=20) as c:
        yield {"c": c, "tz": request.param, "db": tree / "dev_data" / "tam_dev.db", "port": port}
    p.terminate()
    p.wait(5)


def ro(srv):
    return sqlite3.connect(f"file:{srv['db']}?mode=ro", uri=True)


def window(day: str, tz: str):
    z = ZoneInfo(tz)
    d = dt.date.fromisoformat(day)
    f = lambda x: dt.datetime.combine(x, dt.time(0), z).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f(d), f(d + dt.timedelta(days=1))


def expected_progress(srv, day):
    s, e = window(day, srv["tz"])
    db = ro(srv)
    done_ids = {r[0] for r in db.execute(
        "SELECT object_id FROM audit_events WHERE object_type='task' AND action='completed' AND timestamp>=? AND timestamp<?",
        (s, e))}
    n = r = o = 0
    for tid, due, st, arch, cs in db.execute(
            "SELECT t.id,t.due,t.status,t.archived,c.status FROM tasks t LEFT JOIN clients c ON c.id=t.client_id"):
        active = cs in (None, "Active")
        done = st == "Complete" and tid in done_ids
        is_open = st != "Complete" and not arch
        if due and due <= day and active:
            n += done
            r += (not done) and is_open
        elif done and active:
            o += 1
    return {"day": day, "total": n + r, "done": n, "open": r, "done_other": o}


def save_task(c, **kw):
    r = c.post("/api/task/save", json=kw)
    assert r.status_code == 200, r.text
    return r.json()["item"]


# ------------------------------------------------------------------ US-3.7 ring (D-29)
def test_progress_matches_independent_definition(srv):
    c = srv["c"]
    t = c.get("/api/today").json()
    got = t["progress"]
    exp = expected_progress(srv, t["today"])
    assert got == exp, (srv["tz"], got, exp)
    assert got["done"] <= got["total"] and got["total"] == got["done"] + got["open"]
    assert got["total"] > 0 and got["done"] > 0 and got["done_other"] > 0  # the seed exercises every branch


def test_complete_and_reopen_changes_n_not_m(srv):
    c = srv["c"]
    t = c.get("/api/today").json()
    p0 = t["progress"]
    plan = next(i for i in t["queue"] if i["kind"] == "task" and i["tier"] == 2)
    task = next(x for x in c.get("/api/state").json()["tasks"] if x["id"] == plan["id"])
    done = save_task(c, id=task["id"], status="Complete", expected_row_version=task["row_version"])
    p1 = c.get("/api/today").json()["progress"]
    assert (p1["done"], p1["open"], p1["total"]) == (p0["done"] + 1, p0["open"] - 1, p0["total"]), (p0, p1)
    assert p1 == expected_progress(srv, p1["day"])
    back = save_task(c, id=task["id"], status="Not Started", expected_row_version=done["row_version"])
    p2 = c.get("/api/today").json()["progress"]
    assert p2 == p0, (p0, p2)
    # complete again (second completion event in the same day): counted once
    again = save_task(c, id=task["id"], status="Complete", expected_row_version=back["row_version"])
    p3 = c.get("/api/today").json()["progress"]
    assert p3["done"] == p0["done"] + 1 and p3["total"] == p0["total"]
    n = ro(srv).execute("SELECT count(*) FROM audit_events WHERE object_type='task' AND object_id=? AND action='completed'",
                        (task["id"],)).fetchone()[0]
    assert n >= 2
    save_task(c, id=task["id"], status="Not Started", expected_row_version=again["row_version"])


def test_new_overdue_task_grows_m_only_and_future_completion_is_done_other(srv):
    c = srv["c"]
    t = c.get("/api/today").json()
    p0, day = t["progress"], t["today"]
    acct = next(a for a in c.get("/api/state").json()["accounts"] if a["status"] == "Active")
    due_future = (dt.date.fromisoformat(day) + dt.timedelta(days=5)).isoformat()
    new = save_task(c, client_id=acct["id"], task="QA run2 ring probe", priority="Low", due=due_future, status="Not Started", category="Other")
    assert c.get("/api/today").json()["progress"] == p0  # future task is not in the plan
    new = save_task(c, id=new["id"], status="Complete", expected_row_version=new["row_version"])
    p1 = c.get("/api/today").json()["progress"]
    assert p1["done_other"] == p0["done_other"] + 1 and p1["done"] == p0["done"] and p1["total"] == p0["total"]
    new = save_task(c, id=new["id"], status="Not Started", due=(dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat(),
                    expected_row_version=new["row_version"])
    p2 = c.get("/api/today").json()["progress"]
    assert p2["total"] == p0["total"] + 1 and p2["open"] == p0["open"] + 1
    r = c.post("/api/task/delete", json={"id": new["id"], "confirm": True})
    assert r.status_code == 200
    assert c.get("/api/today").json()["progress"] == expected_progress(srv, day)


# ------------------------------------------------------------------ US-3.6 ranking (D-04, D-23, D-24, D-32)
def test_queue_tier_order_and_d32(srv):
    c = srv["c"]
    t = c.get("/api/today").json()
    q, day = t["queue"], t["today"]
    tiers = [i["tier"] for i in q]
    assert tiers == sorted(tiers) and set(tiers) == {1, 2, 3, 4, 5, 6}, tiers
    keys = [(i["kind"], i["id"]) for i in q]
    assert len(keys) == len(set(keys)), "an object appears twice in the queue"
    up = {(i["kind"], i["id"]) for i in t["upcoming"]}
    assert not (up & set(keys)), "upcoming-only objects must be disjoint from the queue"
    assert all(i["tier"] is None for i in t["upcoming"])
    t1 = [i for i in q if i["tier"] == 1]
    kind_rank = {"bams_alert": 0, "task": 1, "server_upgrade": 2}
    assert [kind_rank[i["kind"]] for i in t1] == sorted(kind_rank[i["kind"]] for i in t1), "D-32: alerts, then tasks, then upgrades"
    tasks1 = [i for i in t1 if i["kind"] == "task"]
    assert [(PRIO[i["priority"]], i["date"]) for i in tasks1] == sorted((PRIO[i["priority"]], i["date"]) for i in tasks1)
    ups1 = [i for i in t1 if i["kind"] == "server_upgrade"]
    assert [i["date"] for i in ups1] == sorted(i["date"] for i in ups1)
    assert all(i["urgency"] == "critical" for i in t1 if i["kind"] == "bams_alert")
    t2 = [i for i in q if i["tier"] == 2]
    assert [(PRIO[i["priority"]], i["title"]) for i in t2] == sorted((PRIO[i["priority"]], i["title"]) for i in t2), "tier 2: priority then title"
    assert all(i["date"] == day for i in t2)
    t6 = [i for i in q if i["tier"] == 6]
    assert all(day < i["date"] <= (dt.date.fromisoformat(day) + dt.timedelta(days=3)).isoformat() for i in t6)
    # D-23: no account-level follow-up row when a Client Follow-Up task has the same due date as next_contact
    db = ro(srv)
    for i in q:
        if i["kind"] == "client_follow_up":
            same = db.execute("SELECT count(*) FROM tasks t JOIN clients c ON c.id=t.client_id WHERE c.id=? AND t.category='Client Follow-Up' "
                              "AND t.status!='Complete' AND t.archived=0 AND t.due=c.next_contact", (i["id"],)).fetchone()[0]
            assert same == 0, i
    # Inactive accounts never appear
    inactive = {r[0] for r in db.execute("SELECT id FROM clients WHERE status!='Active'")}
    assert not [i for i in q if i["client_id"] in inactive]


def test_queue_item_has_no_next_action_fields(srv):
    item = srv["c"].get("/api/today").json()["queue"][0]
    banned = {"steps", "next_action", "next_step", "what_to_do", "complete", "mark_complete"}
    assert not (banned & set(item)), set(item)


# ------------------------------------------------------------------ PM-AC-2 / PM-AC-3 data honesty
def test_activity_trend_shape_and_counts(srv):
    c = srv["c"]
    r = c.get("/api/accounts/activity-trend?days=14")
    j = r.json()
    st = c.get("/api/state").json()
    active = {a["id"] for a in st["accounts"] if a["status"] == "Active"}
    assert set(j["series"]) == active
    assert all(len(v) == 14 and all(isinstance(x, int) and x >= 0 for x in v) for v in j["series"].values())
    assert c.get("/api/accounts/activity-trend?days=7").status_code == 422
    assert c.get("/api/accounts/activity-trend?days=14&include_inactive=true").json()["series"].keys() >= active
    # the last bucket (today) must equal today's timeline entries for that account (local-day bucketing)
    day = j["today"]
    for cid in list(active)[:3]:
        acts = c.get(f"/api/client/{cid}/activity?filter=all&limit=100").json()
        items = acts.get("items") or acts.get("entries") or []
        assert items, list(acts)
        z = ZoneInfo(srv["tz"])
        today_n = 0
        for e in items:
            ts = dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).astimezone(z).date().isoformat()
            today_n += ts == day
        assert j["series"][cid][-1] == today_n, (cid, j["series"][cid], today_n)


def test_server_tiles_invariants(srv):
    c = srv["c"]
    for a in c.get("/api/state").json()["accounts"]:
        j = c.get(f"/api/client/{a['id']}/infrastructure").json()
        tiles = j["server_tiles"]
        names = [t["name"] for t in tiles]
        assert len(names) == len(set(names)), "one tile per distinct server name"
        assert j["servers"] == len(names)
        db = ro(srv)
        for t in tiles:
            if t["spark"] is None:
                continue
            pts = t["spark"]["points"]
            assert 2 <= len(pts) <= 28 and t["spark"]["window_hours"] <= 168
            assert [p[0] for p in pts] == sorted(p[0] for p in pts)
            n = db.execute("SELECT count(*) FROM bams_metric_samples s JOIN bams_metrics m ON m.id=s.metric_id "
                           "JOIN bams_objects o ON o.id=m.object_id WHERE o.name=? AND o.client_id=?", (t["name"], a["id"])).fetchone()[0]
            assert n >= 2, f"spark drawn for {t['name']} without stored samples"
            if t["alert_severity"]:
                am = {x["metric_name"] for o in j["bams_objects"] if o["name"] == t["name"] for x in o["alerts"]}
                assert t["spark"]["metric"] in am or "cpu" in t["spark"]["metric"].lower(), t
            else:
                assert "cpu" in t["spark"]["metric"].lower(), t
        # a server with no samples must not carry a spark
        for t in tiles:
            n = db.execute("SELECT count(*) FROM bams_metric_samples s JOIN bams_metrics m ON m.id=s.metric_id "
                           "JOIN bams_objects o ON o.id=m.object_id WHERE o.name=? AND o.client_id=?", (t["name"], a["id"])).fetchone()[0]
            if n == 0:
                assert t["spark"] is None, t


def test_run2_routes_headers_and_methods(srv):
    c = srv["c"]
    for m, p, status in [("GET", "/api/today", 200), ("POST", "/api/today", 405), ("POST", "/api/accounts/activity-trend", 405),
                         ("PUT", "/api/client/x/infrastructure", 405), ("GET", "/api/accounts/activity-trend?days=zz", 422)]:
        r = c.request(m, p)
        assert r.status_code == status, (m, p, r.status_code)
        assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
        assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
        if status == 405:
            assert r.headers.get("allow")
