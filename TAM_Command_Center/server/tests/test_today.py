"""T-13: /api/today (tiers, first-qualifying-tier-only, D-04/D-05/D-23/D-24), /api/state, infrastructure."""
from __future__ import annotations

import uuid

from .conftest import d

ITEM_KEYS = {"kind", "id", "tier", "tier_label", "client_id", "client_name", "type_label", "title", "status",
             "urgency", "date", "date_kind", "days_delta", "context", "priority", "severity", "server_name"}
TIER_LABELS = {1: "Overdue / Critical", 2: "Due today", 3: "Infrastructure alerts", 4: "Waiting / follow-up",
               5: "Upgrade actions", 6: "Upcoming tasks"}


def _upgrade(api, client_id, server, date, status="Scheduled", validation="Pending", env="PROD", pol="East"):
    api.exec("INSERT INTO server_upgrades (id, client_id, server_name, environment, polarity, scheduled_date,"
             " status, validation_status) VALUES (?,?,?,?,?,?,?,?)",
             (str(uuid.uuid4()), client_id, server, env, pol if env == "PROD" else "DEV", date, status, validation))


def _alert(api, client_id, name="bxa-01", severity="Critical", status="open", opened="2026-10-10T09:00:00.000Z",
           enabled=1):
    oid, mid, eid = (str(uuid.uuid4()) for _ in range(3))
    api.exec("INSERT INTO bams_objects (id, client_id, name, region, enabled) VALUES (?,?,?,?,?)",
             (oid, client_id, name, "East", enabled))
    api.exec("INSERT INTO bams_metrics (id, object_id, metric_name, ticker) VALUES (?,?,?,?)",
             (mid, oid, "CPU", f"T.{mid}"))
    rec = ", recovered_at" if status == "recovered" else ""
    recv = ", '2026-10-10T10:00:00.000Z'" if status == "recovered" else ""
    api.exec(f"INSERT INTO bams_alert_events (id, metric_id, alert_type, severity, status, opened_at, message{rec})"
             f" VALUES (?,?,'stale',?,?,?,'msg'{recv})", (eid, mid, severity, status, opened))
    return eid


def _today(api):
    j = api.get("/api/today").json()
    assert j["ok"] is True
    return j


def _find(items, **kw):
    return [i for i in items if all(i[k] == v for k, v in kw.items())]


# ------------------------------------------------------------------ one test per tier (crafted data)
def test_tier1_overdue_critical_and_ordering(api):
    c = api.mk_client("Acme")
    low = api.mk_task(c["id"], "overdue low", due=d(-1), priority="Low")
    high = api.mk_task(c["id"], "overdue high", due=d(-5), priority="High")
    upcoming = api.mk_task(c["id"], "later", due=d(2))
    _alert(api, c["id"])
    _upgrade(api, c["id"], "srv-late", d(-3), status="In Progress")
    q = _today(api)["queue"]
    t1 = [i for i in q if i["tier"] == 1]
    assert [i["kind"] for i in t1] == ["bams_alert", "task", "task", "server_upgrade"]   # critical alert, tasks by prio, upgrade
    assert [i["title"] for i in t1 if i["kind"] == "task"] == ["overdue high", "overdue low"]
    assert t1[0]["urgency"] == "critical" and t1[0]["severity"] == "Critical" and t1[0]["server_name"] == "bxa-01"
    assert _find(t1, kind="task")[0]["urgency"] == "overdue" and _find(t1, kind="task")[0]["days_delta"] == -5
    # [§52] overdue appears before upcoming
    ids = [i["id"] for i in q]
    assert ids.index(high["id"]) < ids.index(upcoming["id"]) and ids.index(low["id"]) < ids.index(upcoming["id"])
    assert all(i["tier_label"] == TIER_LABELS[i["tier"]] for i in q)


def test_tier2_due_today_sorted_by_priority(api):
    c = api.mk_client("Acme")
    api.mk_task(c["id"], "b low", due=d(0), priority="Low")
    api.mk_task(c["id"], "a high", due=d(0), priority="High")
    api.mk_task(c["id"], "c med", due=d(0), priority="Medium")
    api.mk_task(c["id"], "waiting today", due=d(0), priority="High", status="Waiting", waiting="J")
    t2 = [i for i in _today(api)["queue"] if i["tier"] == 2]
    assert [i["title"] for i in t2] == ["a high", "waiting today", "c med", "b low"]
    assert all(i["urgency"] == "due_today" and i["days_delta"] == 0 for i in t2)


def test_tier3_alerts_open_before_recovered_warning_before_info(api):
    c = api.mk_client("Acme")
    _alert(api, c["id"], "o-info", "Info", "open")
    _alert(api, c["id"], "o-warn", "Warning", "open")
    _alert(api, c["id"], "rec", "Warning", "recovered")
    _alert(api, c["id"], "disabled", "Warning", "open", enabled=0)       # monitoring off => not actionable
    t3 = [i for i in _today(api)["queue"] if i["tier"] == 3]
    assert [i["server_name"] for i in t3] == ["o-warn", "o-info", "rec"]
    assert [i["urgency"] for i in t3] == ["alert", "alert", "recovered"]


def test_tier4_waiting_and_client_touch(api):
    c = api.mk_client("Acme", next_contact=d(-2))
    api.mk_task(c["id"], "wait null", status="Waiting", waiting="Bob")
    api.mk_task(c["id"], "wait past", status="Waiting", next_update=d(-1), waiting="Al")
    api.mk_task(c["id"], "wait future", status="Waiting", next_update=d(6), waiting="Al")
    t4 = [i for i in _today(api)["queue"] if i["tier"] == 4]
    assert {i["title"] for i in t4} == {"wait null", "wait past", "Next client touch"}
    touch = _find(t4, kind="client_follow_up")[0]
    assert touch["urgency"] == "follow_up" and touch["date_kind"] == "next_contact" and touch["id"] == c["id"]
    assert _find(t4, title="wait past")[0]["context"] == "Waiting: Al"
    assert t4[-1]["title"] == "wait null"                      # NULL dates sort last
    up = _today(api)["upcoming"]
    assert [i["title"] for i in up] == ["wait future"] and up[0]["date_kind"] == "next_update"


def test_tier5_upgrade_actions_incl_d24(api):
    c = api.mk_client("Acme")
    _upgrade(api, c["id"], "in-window", d(14))
    _upgrade(api, c["id"], "validation", d(40), status="Validation Required")
    _upgrade(api, c["id"], "exception-far", d(90), status="Exception")                 # D-24: any date
    _upgrade(api, c["id"], "failed", d(-40), status="Completed", validation="Failed")
    _upgrade(api, c["id"], "done-pending", d(-9), status="Completed", validation="Pending")
    _upgrade(api, c["id"], "done-ok", d(-9), status="Completed", validation="Passed")                 # excluded
    _upgrade(api, c["id"], "deferred-soon", d(3), status="Deferred")                                   # D-24: never queued
    t5 = {i["server_name"]: i for i in _today(api)["queue"] if i["tier"] == 5}
    assert set(t5) == {"in-window", "validation", "exception-far", "failed", "done-pending"}
    assert t5["validation"]["urgency"] == "validation" and t5["in-window"]["urgency"] == "upgrade"
    everywhere = [i["server_name"] for i in _today(api)["queue"] + _today(api)["upcoming"]]
    assert "done-ok" not in everywhere and "deferred-soon" not in everywhere


def test_tier6_and_upcoming_horizon_boundaries(api):
    c = api.mk_client("Acme")
    for off in (3, 4, 14, 15):
        api.mk_task(c["id"], f"t+{off}", due=d(off))
    _upgrade(api, c["id"], "u15", d(15))        # queue tier 5 is T..T+14, so T+15 is Upcoming
    _upgrade(api, c["id"], "u14", d(14))
    _upgrade(api, c["id"], "u30", d(30))
    _upgrade(api, c["id"], "u31", d(31))
    j = _today(api)
    q = {i["title"]: i["tier"] for i in j["queue"]}
    up = {i["title"] for i in j["upcoming"]}
    assert q["t+3"] == 6 and "t+4" in up and "t+14" in up and "t+15" not in up | set(q)
    title = lambda srv: f"{srv} ? → ?"          # upgrade title when versions are unknown  # noqa: E731
    assert q[title("u14")] == 5
    assert {title("u15"), title("u30")} <= up and title("u31") not in up | set(q)
    assert all(i["tier"] is None and i["urgency"] == "upcoming" and i["tier_label"] is None for i in j["upcoming"])
    dates = [i["date"] for i in j["upcoming"]]
    assert dates == sorted(dates)


def test_each_object_in_exactly_one_place(api):
    c = api.mk_client("Acme", next_contact=d(-1))
    api.mk_task(c["id"], "overdue waiting", due=d(-1), status="Waiting", waiting="x", next_update=d(-1))
    api.mk_task(c["id"], "today waiting", due=d(0), status="Waiting", waiting="x")
    j = _today(api)
    keys = [(i["kind"], i["id"]) for i in j["queue"] + j["upcoming"]]
    assert len(keys) == len(set(keys))
    tiers = {i["title"]: i["tier"] for i in j["queue"]}
    assert tiers["overdue waiting"] == 1 and tiers["today waiting"] == 2          # first qualifying tier wins


def test_excluded_objects(api):
    a = api.mk_client("Active")
    ina = api.mk_client("Inactive Co", status="Inactive")
    api.mk_task(a["id"], "done", due=d(-3), status="Complete")
    arch = api.mk_task(a["id"], "archived", due=d(-3))
    api.ok("/api/task/archive", {"id": arch["id"], "archived": True})
    api.mk_task(ina["id"], "inactive acct task", due=d(-3))
    _alert(api, ina["id"], "x")
    _upgrade(api, ina["id"], "inactive-srv", d(2))
    api.mk_task(None, "unassigned overdue", due=d(-2))
    j = _today(api)
    assert [i["title"] for i in j["queue"]] == ["unassigned overdue"]
    assert j["queue"][0]["client_id"] is None and j["queue"][0]["client_name"] is None


def test_d23_follow_up_task_suppresses_account_touch(api):
    c = api.mk_client("Acme", next_contact=d(-1))
    api.mk_task(c["id"], "Follow up", category="Client Follow-Up", due=d(-1))
    q = _today(api)["queue"]
    assert [i["kind"] for i in q] == ["task"] and q[0]["context"] == "Next Client Touch"
    # different dates -> both appear
    api.ok("/api/client/save", {"id": c["id"], "next_contact": d(-4)})
    assert sorted(i["kind"] for i in _today(api)["queue"]) == ["client_follow_up", "task"]
    # a completed follow-up task no longer suppresses
    api.ok("/api/client/save", {"id": c["id"], "next_contact": d(-1)})
    t = api.sql("SELECT id FROM tasks")[0]["id"]
    api.ok("/api/task/save", {"id": t, "status": "Complete"})
    assert [i["kind"] for i in _today(api)["queue"]] == ["client_follow_up"]


def test_d23_also_applies_to_upcoming_panel(api):
    c = api.mk_client("Acme", next_contact=d(7))
    api.mk_task(c["id"], "Follow up", category="Client Follow-Up", due=d(7))
    up = _today(api)["upcoming"]
    assert [i["kind"] for i in up] == ["task"] and up[0]["context"] == "Next Client Touch"


def test_recent_changes_and_account_load(api):
    names = [f"Co{i:02d}" for i in range(10)]
    cs = [api.mk_client(n) for n in names]
    for i, c in enumerate(cs):
        for _ in range(i):
            api.mk_task(c["id"], "t", due=d(-1))
    j = _today(api)
    load = j["account_load"]
    assert len(load) == 8 and [r["client_name"] for r in load[:3]] == ["Co09", "Co08", "Co07"]
    assert load[0]["overdue"] == 9 and set(load[0]) == {"client_id", "client_name", "open_tasks", "overdue",
                                                         "waiting", "active_alerts", "next_contact"}
    rc = j["recent_changes"]
    assert len(rc) == 20 and rc[0]["sentence"].startswith("Task created: t")
    assert rc[0]["client_name"] and rc == sorted(rc, key=lambda r: (r["ts"], r["entry_key"]), reverse=True)
    api.ok("/api/settings/save", {"settings": {"time_display": "gmt"}})          # settings never appear
    assert all(r["object_type"] != "setting" for r in _today(api)["recent_changes"])


# ------------------------------------------------------------------ seeded DB: every tier populated
def test_seeded_every_tier_has_items_and_shape(seeded):
    j = _today(seeded)
    by_tier = {}
    for i in j["queue"]:
        assert set(i) == ITEM_KEYS
        by_tier.setdefault(i["tier"], []).append(i)
    assert sorted(by_tier) == [1, 2, 3, 4, 5, 6]
    for t, items in by_tier.items():
        assert len(items) >= 2, (t, len(items))
    assert j["upcoming"] and all(set(i) == ITEM_KEYS for i in j["upcoming"])
    tiers_in_order = [i["tier"] for i in j["queue"]]
    assert tiers_in_order == sorted(tiers_in_order)
    # [§52] active BAMS alert appears as an actionable item; near-term upgrade appears
    assert any(i["kind"] == "bams_alert" and i["tier"] in (1, 3) for i in j["queue"])
    assert any(i["kind"] == "server_upgrade" and i["tier"] == 5 and 0 <= i["days_delta"] <= 14 for i in j["queue"])
    keys = [(i["kind"], i["id"]) for i in j["queue"] + j["upcoming"]]
    assert len(keys) == len(set(keys))
    assert len(j["recent_changes"]) == 20 and len(j["account_load"]) == 8


def test_seeded_state_bundle(seeded):
    s = seeded.get("/api/state").json()
    assert s["ok"] and len(s["accounts"]) == 12 and s["runtime"]["mode"] == "DEV"
    assert {a["status"] for a in s["accounts"]} == {"Active", "Inactive"}
    assert all("counts" in a and "row_version" in a for a in s["accounts"])
    assert s["tasks"] and all(t["archived"] is False for t in s["tasks"])
    assert any(t["client_id"] is None for t in s["tasks"])                          # unassigned tasks included
    assert len(s["infrastructure"]) == 12
    assert all("metrics" not in o for inf in s["infrastructure"].values() for o in inf["bams_objects"])
    prim = {}
    for c in s["contacts"]:
        prim[c["client_id"]] = prim.get(c["client_id"], 0) + int(c["is_primary"])
    assert max(prim.values()) == 1                                                   # never more than one primary
    assert len(prim) < 12 or 0 in prim.values()                                       # an account with none exists
    assert s["settings"]["default_landing"] == "today"
    # no archived tasks, no activity bundled
    assert "activity" not in s and "notes" not in s
    assert s["accounts"] == sorted(s["accounts"], key=lambda a: (-a["counts"]["overdue"], -a["counts"]["open_tasks"], a["name"]))


def test_seeded_infrastructure_endpoint(seeded):
    s = seeded.get("/api/state").json()
    cid = next(c for c, inf in s["infrastructure"].items() if inf["bams_objects"] and inf["server_upgrades"])
    inf = seeded.get(f"/api/client/{cid}/infrastructure").json()
    assert inf["ok"] and inf["client_id"] == cid
    obj = inf["bams_objects"][0]
    assert obj["metrics"] and {"freshness", "current_value", "last_received"} <= set(obj["metrics"][0])
    assert obj["worst_status"] in {"Stale", "No Data", "Delayed", "Live", "Disabled"}
    assert inf["server_upgrades"][0]["server_name"]
    acct = next(a for a in s["accounts"] if a["id"] == cid)
    assert inf["active_alerts"] == acct["counts"]["active_alerts"]
    assert inf["servers"] == acct["counts"]["servers"]
    assert sum(inf["environment_summary"][k] for k in ("PROD", "DEV", "unknown")) == inf["servers"]
    assert seeded.get("/api/client/ghost/infrastructure").status_code == 404


def test_seeded_frozen_mock_clock_keeps_freshness_states(seeded):
    states = set()
    for cid in [a["id"] for a in seeded.get("/api/state").json()["accounts"]]:
        for o in seeded.get(f"/api/client/{cid}/infrastructure").json()["bams_objects"]:
            states |= {m["freshness"] for m in o["metrics"]}
    assert {"Live", "Delayed", "Stale", "No Data", "Disabled"} <= states


def test_seeded_activity_pages_and_filters(seeded):
    s = seeded.get("/api/state").json()
    cid = max(s["accounts"], key=lambda a: a["counts"]["open_tasks"])["id"]
    base = f"/api/client/{cid}/activity"
    seen, cursor, pages = [], None, 0
    while True:
        r = seeded.get(base, limit=10, **({"before": cursor} if cursor else {})).json()
        seen += [i["entry_key"] for i in r["items"]]
        pages += 1
        cursor = r["next_cursor"]
        if not r["has_more"]:
            break
    assert pages > 1 and len(seen) == len(set(seen))
    for flt, want in (("meeting", "Meeting Note"), ("call", "Call Note"), ("general", "General Note")):
        items = seeded.get(base, filter=flt, limit=100).json()["items"]
        assert items and {i["note_type"] for i in items} == {want}
    sysi = seeded.get(base, filter="system", limit=100).json()["items"]
    assert sysi and all(i["kind"] == "system" and i["sentence"] for i in sysi)
    assert seeded.get(base, limit=101).status_code == 422
