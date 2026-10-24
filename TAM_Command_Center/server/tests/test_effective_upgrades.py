"""B-6: Overview upgrades_30d mirrors Operations (effective date, status, polarity); everything else is saved-records-only."""
from __future__ import annotations

import datetime as dt

from server.dbkit import load_query, rows_to_dicts
from server.ops.effective import upgrades_30d
from server.tests.test_operations import TODAY, oid, op, q4  # noqa: F401  (op fixture)

SEED_TODAY = dt.date(2026, 10, 23)


def _ops_rows(api, y, q):
    j = api.get("/api/operations", year=y, quarter=q).json()
    return [r for g in j["groups"] for r in g["rows"]], j


def _infra(api, cid):
    return api.get("/api/state").json()["infrastructure"][cid]


def test_seeded_parity_with_operations_next_30_days(seeded):
    seeded.rt.clock = lambda: SEED_TODAY
    today, hi = SEED_TODAY.isoformat(), (SEED_TODAY + dt.timedelta(days=30)).isoformat()
    quarters = seeded.sql("SELECT schedule_year AS y, schedule_quarter AS q FROM quarterly_upgrade_windows")
    expect = set()
    for w in quarters:
        rows, _ = _ops_rows(seeded, w["y"], w["q"])
        for r in rows:
            d = r["date"]["effective"]
            if d and today <= d <= hi and r["status"] not in ("Completed", "Deferred"):
                expect.add((r["object_id"], w["y"], w["q"], d, r["status"], r["polarity"]))
    infra = seeded.get("/api/state").json()["infrastructure"]
    got = {(i["object_id"], i["release"]["year"], i["release"]["quarter"], i["date"], i["status"], i["polarity"])
           for p in infra.values() for i in p["upgrades_30d"]}
    exp2 = set(expect)
    # Operations polarity is East/West/None; DEV appliances are labelled DEV in upgrades_30d
    dev = {r["id"] for r in seeded.sql("SELECT id FROM bams_objects WHERE environment = 'DEV'")}
    exp2 = {(e[0], e[1], e[2], e[3], e[4], "DEV" if e[0] in dev else e[5]) for e in exp2}
    assert got == exp2 and got
    for p in infra.values():
        ds = [(i["date"], i["server_name"].casefold()) for i in p["upgrades_30d"]]
        assert ds == sorted(ds)


def test_seeded_everything_else_is_saved_records_only(seeded):
    seeded.rt.clock = lambda: SEED_TODAY
    today = SEED_TODAY.isoformat()
    s = seeded.get("/api/state").json()
    with seeded.rt.db() as conn:
        q = lambda sql, p=(): [dict(r) for r in conn.execute(sql, p)]       # noqa: E731
        for a in s["accounts"]:
            saved = q("SELECT * FROM server_upgrades WHERE client_id = ? ORDER BY (scheduled_date IS NULL), scheduled_date,"
                      " server_name, id", (a["id"],))
            infra = s["infrastructure"][a["id"]]
            assert [u["id"] for u in infra["server_upgrades"]] == [u["id"] for u in saved]
            assert all("derived" not in u and u["scheduled_date"] == x["scheduled_date"]
                       and u["target_version"] == x["target_version"] for u, x in zip(infra["server_upgrades"], saved))
            live = [u for u in saved if u["scheduled_date"] and u["scheduled_date"] >= today
                    and u["status"] not in ("Completed", "Deferred")]
            assert a["counts"]["upcoming_upgrades"] == len(live)
            assert a["counts"]["next_upgrade"] == (min(u["scheduled_date"] for u in live) if live else None)
            nxt = min(live, key=lambda u: (u["scheduled_date"], u["server_name"], u["id"]), default=None)
            assert infra["next_upgrade"] == ({"date": nxt["scheduled_date"], "server": nxt["server_name"]} if nxt else None)
        base = rows_to_dicts(conn.execute(load_query("today_queue.sql"), {"today": today}))
    t = seeded.get("/api/today").json()
    assert [(i["kind"], i["id"], i["tier"], i["date"]) for i in t["queue"] + t["upcoming"]] == \
           [(r["kind"], r["id"], r["tier"], r["date"]) for r in base]
    assert all("derived" not in i for i in t["queue"] + t["upcoming"])
    assert "not_in_bams" not in seeded.get("/api/operations").json()


def test_reads_do_not_write(seeded):
    seeded.rt.clock = lambda: SEED_TODAY
    tables = ("server_upgrades", "audit_events", "clients")
    before = [seeded.sql(f"SELECT count(*) AS n FROM {t}")[0]["n"] for t in tables]
    seeded.get("/api/state"), seeded.get("/api/today"), seeded.get("/api/operations")
    assert before == [seeded.sql(f"SELECT count(*) AS n FROM {t}")[0]["n"] for t in tables]


def _by(api, cid=None):
    with api.rt.db() as conn:
        return {i["server_name"]: i for i in upgrades_30d(conn, TODAY.isoformat(), cid or api.cid).get(cid or api.cid, [])}


def test_labelling_and_edges(op):
    # today 2026-10-14; window to 2026-11-13. DEV 10-14 (today, inclusive), East 11-13 (+30, inclusive), West 11-14 (+31, out)
    q4(op, dev_upgrade_date="2026-10-14", east_prod_date="2026-11-13", west_prod_date="2026-11-14")
    by = _by(op)
    assert set(by) == {"A-DEV", "A-EAST"}
    assert (by["A-DEV"]["environment"], by["A-DEV"]["polarity"], by["A-DEV"]["status"]) == ("DEV", "DEV", "Planned")
    assert (by["A-EAST"]["environment"], by["A-EAST"]["polarity"], by["A-EAST"]["date"]) == ("PROD", "East", "2026-11-13")
    assert by["A-EAST"]["release"] == {"year": 2026, "quarter": "Q4"}
    infra = _infra(op, op.cid)
    assert {i["server_name"] for i in infra["upgrades_30d"]} == {"A-DEV", "A-EAST"}
    assert infra["server_upgrades"] == [] and infra["next_upgrade"] is None     # saved-only fields unchanged


def test_west_label_override_vs_quarter_and_closed_excluded(op):
    q4(op, dev_upgrade_date="2026-10-01", east_prod_date="2026-10-20", west_prod_date="2026-10-25")
    op.ok("/api/operations/appliance/save", {"object_id": oid(op, "A-WEST"), "year": 2026, "quarter": "Q4",
                                             "status": "Scheduled", "date_override": "2026-11-01"})
    op.ok("/api/operations/appliance/save", {"object_id": oid(op, "A-EAST"), "year": 2026, "quarter": "Q4", "status": "Completed"})
    by = _by(op)
    assert set(by) == {"A-WEST"}                              # DEV past, East Completed, others dateless
    assert (by["A-WEST"]["date"], by["A-WEST"]["status"], by["A-WEST"]["polarity"]) == ("2026-11-01", "Scheduled", "West")
    op.ok("/api/operations/appliance/save", {"object_id": oid(op, "A-WEST"), "year": 2026, "quarter": "Q4", "status": "Deferred",
                                             "expected_row_version": 1})
    assert _by(op) == {}
    srv = _infra(op, op.cid)["server_upgrades"]
    assert {u["server_name"] for u in srv} == {"A-WEST", "A-EAST"}           # saved records only, no derived rows
