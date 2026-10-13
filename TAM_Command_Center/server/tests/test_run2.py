"""Run 2 (T-62..T-64, PM-AC-1..3): progress on /api/today, /api/accounts/activity-trend, server_tiles."""
from __future__ import annotations

import datetime as dt
import random
import sqlite3
import uuid
from zoneinfo import ZoneInfo

from server import infra
from server.localtime import local_midnight_utc, progress_params, trend_params

from .conftest import d
from .test_today import _alert, _today

NY = ZoneInfo("America/New_York")
TOKYO = ZoneInfo("Asia/Tokyo")
DAY = "2026-10-12"


def _set_day(api, day=DAY, tz=dt.timezone.utc):
    api.rt.clock = lambda: dt.date.fromisoformat(day)
    api.rt.tz = tz


def _task(api, title, *, client_id=None, status="Not Started", due="2026-10-01", archived=0):
    tid = str(uuid.uuid4())
    api.exec("INSERT INTO tasks (id, task, client_id, status, due, archived) VALUES (?,?,?,?,?,?)",
             (tid, title, client_id, status, due, archived))
    return tid


def _event(api, tid, ts, action="completed", client_id=None):
    api.exec("INSERT INTO audit_events (timestamp, category, client_id, object_type, object_id, object_label, action,"
             " source) VALUES (?,?,?,?,?,?,?,?)", (ts, "crm", client_id, "task", tid, "t", action, "GUI"))


def _progress(api):
    j = _today(api)
    assert set(j["progress"]) == {"day", "total", "done", "open", "done_other"}
    return j["progress"]


# ------------------------------------------------------------------ T-62 progress
def test_progress_empty_db_is_zero_and_echoes_day(api):
    _set_day(api)
    assert _progress(api) == {"day": DAY, "total": 0, "done": 0, "open": 0, "done_other": 0}


def test_progress_every_section_10_2_case(api):
    _set_day(api)
    c = api.mk_client("Acme")["id"]
    off = api.mk_client("Dormant", status="Inactive")["id"]
    t = "2026-10-12T09:00:00.000Z"
    done1 = _task(api, "done plan", client_id=c, status="Complete", due="2026-10-10"); _event(api, done1, t)
    twice = _task(api, "completed twice", client_id=c, status="Complete", due=DAY)
    _event(api, twice, "2026-10-12T08:00:00.000Z"); _event(api, twice, "2026-10-12T09:30:00.000Z")
    reopened = _task(api, "reopened", client_id=c, status="In Progress", due=DAY)
    _event(api, reopened, t); _event(api, reopened, "2026-10-12T09:10:00.000Z", "reopened")
    archived = _task(api, "done then archived", client_id=c, status="Complete", due=DAY, archived=1)
    _event(api, archived, t)
    future = _task(api, "done future", client_id=c, status="Complete", due="2026-10-20"); _event(api, future, t)
    nodue = _task(api, "done no due", client_id=c, status="Complete", due=None); _event(api, nodue, t)
    inactive = _task(api, "done on inactive", client_id=off, status="Complete", due=DAY); _event(api, inactive, t)
    yesterday = _task(api, "done yesterday", client_id=c, status="Complete", due=DAY)
    _event(api, yesterday, "2026-10-11T23:59:59.999Z")
    _event(api, str(uuid.uuid4()), t, client_id=c)                       # deleted task: audit row, no task row
    _task(api, "open due today", client_id=c, due=DAY)
    _task(api, "open overdue unassigned", due="2026-09-01")
    _task(api, "open future", client_id=c, due="2026-10-30")
    _task(api, "open archived", client_id=c, due=DAY, archived=1)
    _task(api, "open inactive", client_id=off, due=DAY)
    p = _progress(api)
    assert p == {"day": DAY, "total": 6, "done": 3, "open": 3, "done_other": 2}
    assert p["total"] == p["done"] + p["open"]


def test_progress_m_zero_and_n_equals_m(api):
    _set_day(api)
    assert _progress(api)["total"] == 0
    tid = _task(api, "only", status="Complete", due=DAY); _event(api, tid, "2026-10-12T12:00:00.000Z")
    assert _progress(api) == {"day": DAY, "total": 1, "done": 1, "open": 0, "done_other": 0}


def test_progress_midnight_boundary_in_a_non_utc_zone(api):
    _set_day(api, tz=TOKYO)       # local Oct 12 = [Oct 11 15:00Z, Oct 12 15:00Z)
    for name, ts in (("late_yesterday", "2026-10-11T14:59:59.999Z"), ("first", "2026-10-11T15:00:00.000Z"),
                     ("last", "2026-10-12T14:59:59.999Z"), ("tomorrow", "2026-10-12T15:00:00.000Z")):
        _event(api, _task(api, name, status="Complete", due=DAY), ts)
    assert _progress(api)["done"] == 2
    _event(api, _task(api, "utc_only", status="Complete", due=DAY), "2026-10-12T20:00:00.000Z")   # 05:00 Oct 13 Tokyo
    assert _progress(api)["done"] == 2
    _set_day(api, tz=dt.timezone.utc)         # UTC window [Oct 12 00:00Z, Oct 13 00:00Z): a different set
    assert _progress(api)["done"] == 3


def test_progress_dst_23h_and_25h_days(api):
    assert progress_params(dt.date(2026, 3, 8), NY) == {
        "today": "2026-03-08", "day_start_utc": "2026-03-08T05:00:00.000Z", "day_end_utc": "2026-03-09T04:00:00.000Z"}
    assert progress_params(dt.date(2026, 11, 1), NY) == {
        "today": "2026-11-01", "day_start_utc": "2026-11-01T04:00:00.000Z", "day_end_utc": "2026-11-02T05:00:00.000Z"}
    _set_day(api, "2026-03-08", NY)           # 23-hour day
    for name, ts in (("before", "2026-03-08T04:59:59.999Z"), ("first", "2026-03-08T05:00:00.000Z"),
                     ("last", "2026-03-09T03:59:59.999Z"), ("after", "2026-03-09T04:00:00.000Z")):
        _event(api, _task(api, name, status="Complete", due="2026-03-01"), ts)
    assert _progress(api)["done"] == 2
    _set_day(api, "2026-11-01", NY)           # 25-hour day: a naive +24h end would drop the last hour
    for name, ts in (("a", "2026-11-02T04:30:00.000Z"), ("b", "2026-11-01T04:00:00.000Z"),
                     ("c", "2026-11-02T05:00:00.000Z")):
        _event(api, _task(api, name, status="Complete", due="2026-10-01"), ts)
    assert _progress(api)["done"] == 2


def test_progress_property_done_never_exceeds_total(api):
    _set_day(api)
    rnd = random.Random(62)
    c = api.mk_client("P")["id"]
    for i in range(60):
        status = rnd.choice(["Not Started", "In Progress", "Waiting", "Complete"])
        tid = _task(api, f"t{i}", client_id=rnd.choice([c, None]), status=status,
                    due=rnd.choice([None, "2026-10-01", DAY, "2026-10-20"]), archived=rnd.choice([0, 0, 1]))
        if rnd.random() < .6:
            _event(api, tid, rnd.choice(["2026-10-12T09:00:00.000Z", "2026-10-11T09:00:00.000Z"]))
        p = _progress(api)
        assert p["done"] <= p["total"] and p["total"] == p["done"] + p["open"]


def test_progress_does_not_change_queue_and_has_no_replace(seeded):
    before = seeded.get("/api/today").json()
    assert set(before["progress"]) == {"day", "total", "done", "open", "done_other"}
    assert before["progress"]["day"] == before["today"]
    # progress is additive: the other keys and their order are unchanged
    assert list(before)[:6] == ["ok", "today", "queue", "upcoming", "recent_changes", "account_load"]
    assert before["progress"]["total"] == before["progress"]["done"] + before["progress"]["open"]
    assert before["progress"]["done"] > 0


def test_seed_progress_matches_reference_query_directly(seeded):
    from server.dbkit import load_query
    today = seeded.get("/api/today").json()
    with seeded.rt.db() as conn:
        ref = dict(conn.execute(load_query("day_progress.sql"), progress_params(
            dt.date.fromisoformat(today["today"]))).fetchone())
    assert today["progress"] == ref


def test_local_midnight_helper_converts_each_midnight_separately():
    assert local_midnight_utc(dt.date(2026, 3, 8), NY) == "2026-03-08T05:00:00.000Z"
    assert local_midnight_utc(dt.date(2026, 3, 9), NY) == "2026-03-09T04:00:00.000Z"
    p = trend_params(dt.date(2026, 3, 8), 14, NY)
    assert p["b13"] == "2026-03-08T05:00:00.000Z" and p["b14"] == "2026-03-09T04:00:00.000Z"
    assert p["b0"] == "2026-02-23T05:00:00.000Z" and len([k for k in p if k.startswith("b")]) == 15


# ------------------------------------------------------------------ T-63 activity trend
def _trend(api, **q):
    r = api.get("/api/accounts/activity-trend", **q)
    assert r.status_code == 200, r.text
    return r.json()


def _note(api, cid, ts):
    api.exec("INSERT INTO notes (id, client_id, note_type, timestamp, subject, source) VALUES (?,?,?,?,?,'GUI')",
             (str(uuid.uuid4()), cid, "General Note", ts, "n"))


def test_trend_shape_zeros_and_inactive_excluded(api):
    _set_day(api)
    a = api.mk_client("Active one")["id"]
    off = api.mk_client("Dormant", status="Inactive")["id"]
    j = _trend(api)
    assert j["ok"] is True and j["today"] == DAY and j["days"] == 14
    assert list(j["series"]) == [a] and j["series"][a] == [0] * 14
    # the creation audit rows of the two accounts are not timeline events (client.created is not listed)
    assert set(_trend(api, include_inactive="true")["series"]) == {a, off}


def test_trend_bucket_edges_and_orientation(api):
    _set_day(api, tz=TOKYO)                  # local Oct 12 = [Oct 11 15:00Z, Oct 12 15:00Z)
    c = api.mk_client("Edges")["id"]
    _note(api, c, "2026-10-12T14:59:59.999Z")    # last ms of today -> index 13
    _note(api, c, "2026-10-11T15:00:00.000Z")    # first ms of today -> index 13
    _note(api, c, "2026-10-11T14:59:59.999Z")    # last ms of yesterday -> index 12
    _note(api, c, "2026-10-12T15:00:00.000Z")    # tomorrow: outside
    _note(api, c, "2026-09-28T15:00:00.000Z")    # first ms of day 0 (Sep 29 local) -> index 0
    _note(api, c, "2026-09-28T14:59:59.999Z")    # before the 14-day range: outside
    s = _trend(api)["series"][c]
    assert len(s) == 14 and s[13] == 2 and s[12] == 1 and s[0] == 1 and sum(s) == 4


def test_trend_counts_system_events_and_alerts_and_deleted_notes(api):
    _set_day(api)
    c = api.mk_client("Mix")["id"]
    _note(api, c, "2026-10-12T10:00:00.000Z")
    tid = _task(api, "t", client_id=c)
    _event(api, tid, "2026-10-12T11:00:00.000Z", "completed", client_id=c)
    _event(api, tid, "2026-10-11T11:00:00.000Z", "updated", client_id=c)      # not a listed action: ignored
    api.exec("INSERT INTO audit_events (timestamp, category, client_id, object_type, object_id, object_label, action,"
             " source) VALUES ('2026-10-10T08:00:00.000Z','crm',?,'note','x','Gone','deleted','GUI')", (c,))
    _alert(api, c, opened="2026-10-12T12:00:00.000Z")
    s = _trend(api)["series"][c]
    assert s[13] == 3 and s[11] == 1 and s[12] == 0 and sum(s) == 4


def test_trend_matches_activity_timeline_counts(seeded):
    j = _trend(seeded)
    today = dt.date.fromisoformat(j["today"])
    local_tz = None
    lo = local_midnight_utc(today - dt.timedelta(days=13), local_tz)
    hi = local_midnight_utc(today + dt.timedelta(days=1), local_tz)
    some = 0
    for cid, series in j["series"].items():
        assert len(series) == 14 and all(isinstance(n, int) and n >= 0 for n in series)
        total, cursor = 0, None
        while True:
            page = seeded.get(f"/api/client/{cid}/activity", filter="all", limit=100,
                              **({"before": cursor} if cursor else {})).json()
            total += sum(1 for e in page["items"] if lo <= e["ts"] < hi)
            cursor = page["next_cursor"]
            if not page["has_more"]:
                break
        assert sum(series) == total
        some += total
    assert some > 0


def test_trend_validation_and_headers(api):
    assert api.get("/api/accounts/activity-trend", days=7).status_code == 422
    r = api.get("/api/accounts/activity-trend", days=7)
    assert r.json()["error"]["code"] == "validation_error" and "days" in r.json()["error"]["fields"]
    assert api.get("/api/accounts/activity-trend", days="x").status_code == 422
    r = api.get("/api/accounts/activity-trend", days=14)
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert api.post("/api/accounts/activity-trend", {}).status_code == 405


# ------------------------------------------------------------------ T-64 server tiles
def _obj(api, cid, name, env="PROD", enabled=1, metrics=("CPU",)):
    oid = str(uuid.uuid4())
    api.exec("INSERT INTO bams_objects (id, client_id, name, region, environment, enabled) VALUES (?,?,?,?,?,?)",
             (oid, cid, name, "East", env, enabled))
    ids = {}
    for m in metrics:
        mid = str(uuid.uuid4())
        api.exec("INSERT INTO bams_metrics (id, object_id, metric_name, ticker) VALUES (?,?,?,?)",
                 (mid, oid, m, f"T.{mid}"))
        ids[m] = mid
    return oid, ids


def _open_alert(api, mid, severity, opened="2026-10-10T09:00:00.000Z"):
    api.exec("INSERT INTO bams_alert_events (id, metric_id, alert_type, severity, status, opened_at, message)"
             " VALUES (?,?,'stale',?,'open',?,'msg')", (str(uuid.uuid4()), mid, severity, opened))


def _samples(api, mid, count, step_min, *, end_hours_ago=0.0, base=10.0):
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    for i in range(count):
        at = now - dt.timedelta(hours=end_hours_ago) - dt.timedelta(minutes=step_min * (count - 1 - i))
        api.exec("INSERT INTO bams_metric_samples (metric_id, sampled_at, value) VALUES (?,?,?)",
                 (mid, infra._fmt(at), base + i))


def _upg(api, cid, server, status="Scheduled", date="2026-10-24", cur="7.1.4", tgt="7.2.0", env="PROD", year=None, q=None):
    api.exec("INSERT INTO server_upgrades (id, client_id, server_name, environment, polarity, schedule_year,"
             " schedule_quarter, current_version, target_version, scheduled_date, status, validation_status)"
             " VALUES (?,?,?,?,?,?,?,?,?,?,?,'Pending')",
             (str(uuid.uuid4()), cid, server, env, "East" if env == "PROD" else "DEV", year, q, cur, tgt, date, status))


def _tiles(api, cid):
    j = api.get(f"/api/client/{cid}/infrastructure").json()
    assert j["ok"] is True and isinstance(j["servers"], int)         # frozen count unchanged
    return {t["name"]: t for t in j["server_tiles"]}, j


def test_tile_shape_cpu_fallback_and_window(api):
    c = api.mk_client("Tiles")["id"]
    _, ids = _obj(api, c, "srv-a", metrics=("Disk", "CPU Load"))
    _samples(api, ids["CPU Load"], 24, 60)
    _samples(api, ids["Disk"], 5, 60)
    tiles, j = _tiles(api, c)
    t = tiles["srv-a"]
    assert set(t) == {"name", "environment", "version", "alert_severity", "spark"}
    assert t["alert_severity"] is None and t["environment"] == "PROD"
    sp = t["spark"]
    assert sp["metric"] == "CPU Load" and len(sp["points"]) == 24 and sp["window_hours"] in (23, 24)
    assert sp["points"] == sorted(sp["points"]) and all(len(p) == 2 for p in sp["points"])
    assert "server_tiles" not in api.get("/api/state").json()["infrastructure"][c]
    assert j["servers"] == 1


def test_tile_alert_metric_wins_over_cpu_and_severity_ranking(api):
    c = api.mk_client("Alerts")["id"]
    _, ids = _obj(api, c, "srv-b", metrics=("CPU", "Disk", "Memory"))
    for m in ids.values():
        _samples(api, m, 6, 60)
    _open_alert(api, ids["Memory"], "Warning", "2026-10-09T09:00:00.000Z")
    _open_alert(api, ids["Disk"], "Critical", "2026-10-11T09:00:00.000Z")
    t = _tiles(api, c)[0]["srv-b"]
    assert t["alert_severity"] == "Critical" and t["spark"]["metric"] == "Disk"


def test_tile_severity_tie_breaks_on_earliest_opened(api):
    c = api.mk_client("Tie")["id"]
    _, ids = _obj(api, c, "srv-t", metrics=("Disk", "Memory"))
    for m in ids.values():
        _samples(api, m, 3, 60)
    _open_alert(api, ids["Disk"], "Warning", "2026-10-11T09:00:00.000Z")
    _open_alert(api, ids["Memory"], "Warning", "2026-10-09T09:00:00.000Z")
    assert _tiles(api, c)[0]["srv-t"]["spark"]["metric"] == "Memory"


def test_tile_without_samples_or_metric_has_null_spark(api):
    c = api.mk_client("Null")["id"]
    _, ids = _obj(api, c, "no-samples", metrics=("CPU",))
    _obj(api, c, "no-cpu", metrics=("Disk",))
    _upg(api, c, "upgrade-only")
    _, ids2 = _obj(api, c, "stale-only", metrics=("CPU",))
    _samples(api, ids2["CPU"], 5, 60, end_hours_ago=24 * 9)       # all older than 7 days
    tiles, _ = _tiles(api, c)
    assert set(tiles) == {"no-samples", "no-cpu", "upgrade-only", "stale-only"}
    assert all(t["spark"] is None for t in tiles.values())
    assert tiles["upgrade-only"]["version"] == "7.1.4" and tiles["upgrade-only"]["environment"] == "PROD"


def test_tile_alert_metric_without_samples_is_null_not_cpu(api):
    c = api.mk_client("Strict")["id"]
    _, ids = _obj(api, c, "srv-s", metrics=("CPU", "Disk"))
    _samples(api, ids["CPU"], 5, 60)
    _open_alert(api, ids["Disk"], "Critical")
    t = _tiles(api, c)[0]["srv-s"]
    assert t["alert_severity"] == "Critical" and t["spark"] is None


def test_tile_points_never_exceed_28_and_keep_bucket_maximum(api):
    c = api.mk_client("Many")["id"]
    _, ids = _obj(api, c, "srv-m", metrics=("CPU",))
    _samples(api, ids["CPU"], 500, 20)                 # ~6.9 days of 20-minute samples
    sp = _tiles(api, c)[0]["srv-m"]["spark"]
    assert 1 < len(sp["points"]) <= 28 and sp["window_hours"] <= 168
    assert sp["points"][-1][1] == 10.0 + 499            # the global maximum is kept (last bucket)
    assert sp["points"] == sorted(sp["points"], key=lambda p: p[0])
    # a spike inside a bucket survives downsampling
    api.exec("UPDATE bams_metric_samples SET value = 999 WHERE id = (SELECT id FROM bams_metric_samples"
             " WHERE metric_id = ? ORDER BY sampled_at LIMIT 1 OFFSET 250)", (ids["CPU"],))
    assert max(p[1] for p in _tiles(api, c)[0]["srv-m"]["spark"]["points"]) == 999


def test_tile_window_is_seven_days_and_old_rows_are_not_read(api):
    c = api.mk_client("Window")["id"]
    _, ids = _obj(api, c, "srv-w", metrics=("CPU",))
    _samples(api, ids["CPU"], 40, 24 * 60, base=1.0)                  # 40 daily samples, oldest 39 days ago
    with api.rt.db() as conn:
        seen = []
        conn.set_trace_callback(seen.append)
        out = infra.build_infrastructure(conn, "dev", client_id=c, server_tiles=True)[c]
    sp = out["server_tiles"][0]["spark"]
    assert sp["window_hours"] in (144, 145) and len(sp["points"]) == 7     # oldest sample inside the 7 days, not 40 rows
    sample_sql = [s for s in seen if "FROM bams_metric_samples" in s]
    assert sample_sql and all("metric_id" in s and "sampled_at >=" in s for s in sample_sql)
    assert not any("FROM bams_metric_samples" in s and "WHERE" not in s for s in seen)


def test_tile_environment_version_rules(api):
    c = api.mk_client("Versions")["id"]
    _upg(api, c, "v-open", status="Scheduled", date="2026-11-10", cur="7.0", tgt="7.1")
    _upg(api, c, "v-open", status="Scheduled", date="2026-10-20", cur="6.9", tgt="7.0")      # earliest open wins
    _upg(api, c, "v-done", status="Completed", date="2026-06-01", cur="7.0", tgt="7.1")
    _upg(api, c, "v-done", status="Completed", date="2026-09-01", cur="7.1", tgt="7.2")      # latest completed target
    _upg(api, c, "v-deferred", status="Deferred", date="2026-09-01", cur="1.0", tgt="2.0")   # neither open nor completed
    _obj(api, c, "Lower-Case", env="DEV", metrics=())
    _upg(api, c, "LOWER-case", status="Scheduled", env="PROD")                               # same server, other spelling
    tiles, j = _tiles(api, c)
    assert tiles["v-open"]["version"] == "6.9" and tiles["v-done"]["version"] == "7.2"
    assert tiles["v-deferred"]["version"] is None
    assert list(tiles).count("Lower-Case") == 1 and "LOWER-case" not in tiles       # distinct names, case-insensitive
    assert tiles["Lower-Case"]["environment"] == "PROD"                               # upgrade env precedence (QA-1-15)
    assert len(tiles) == j["servers"] == 4
    assert [t["name"] for t in j["server_tiles"]] == sorted(tiles, key=str.casefold)


def test_tile_disabled_object_has_no_alert_or_spark(api):
    c = api.mk_client("Off")["id"]
    _, ids = _obj(api, c, "srv-off", enabled=0, metrics=("CPU",))
    _samples(api, ids["CPU"], 5, 60)
    _open_alert(api, ids["CPU"], "Critical")
    t = _tiles(api, c)[0]["srv-off"]
    assert t["alert_severity"] is None and t["spark"] is None


def test_tiles_on_seed_and_state_unchanged(seeded):
    state = seeded.get("/api/state").json()
    seen_spark = seen_null = 0
    for cid in state["infrastructure"]:
        j = seeded.get(f"/api/client/{cid}/infrastructure").json()
        assert len(j["server_tiles"]) == j["servers"]
        for t in j["server_tiles"]:
            if t["spark"]:
                seen_spark += 1
                assert 1 <= len(t["spark"]["points"]) <= 28 and 1 <= t["spark"]["window_hours"] <= 168
            else:
                seen_null += 1
    assert seen_spark > 0 and seen_null > 0
    assert all("server_tiles" not in v for v in state["infrastructure"].values())
