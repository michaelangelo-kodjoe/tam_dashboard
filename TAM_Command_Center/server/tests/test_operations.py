"""Run 5 (T-165, T-167, T-168): Operations API, derivation, set-version, import polarity additions."""
from __future__ import annotations

import datetime as dt

import pytest

from server.importer import bams_reader
from server.ops import derive as D
from server.tests.test_bams_import import HEAD, R, apply, inspect_ok, mk_obj, up

TODAY = dt.date(2026, 10, 14)


@pytest.fixture
def op(build):
    api = build()
    api.rt.clock = lambda: TODAY
    api.cid = api.mk_client("Acme Capital")["id"]
    api.cid2 = api.mk_client("Beta Fund")["id"]
    mk_obj(api, "A-EAST", [("CPU", "O.E")], region="east", environment="PROD")
    mk_obj(api, "A-WEST", [("CPU", "O.W")], region="West", environment="PROD")
    mk_obj(api, "A-DEV", [("CPU", "O.D")], environment="DEV")
    mk_obj(api, "A-NOPOL", [("CPU", "O.N")], region="Europe", environment="PROD")
    mk_obj(api, "A-NOENV", [("CPU", "O.X")], region="East")
    mk_obj(api, "B-WEST", [("CPU", "O.BW")], cid=api.cid2, region="West", environment="PROD")
    return api


def q4(api, **kw):
    body = {"year": 2026, "quarter": "Q4", "apics_version": "4.78.0", "dev_upgrade_date": "2026-10-10",
            "east_prod_date": "2026-11-07", "west_prod_date": "2026-11-14", **kw}
    return api.ok("/api/operations/quarter/save", body)["item"]


def oid(api, name):
    return api.sql("SELECT id FROM bams_objects WHERE name = ?", (name,))[0]["id"]


def rows(api, **params):
    j = api.get("/api/operations", **params).json()
    return j, {r["appliance"]: r for g in j["groups"] for r in g["rows"]}


def save(api, name, **kw):
    return api.post("/api/operations/appliance/save", {"object_id": oid(api, name), "year": 2026, "quarter": "Q4", **kw})


# ---------------------------------------------------------------- reads / derivation
def test_empty_states(build):
    api = build()
    j = api.get("/api/operations").json()
    assert j["empty"] == "no_quarters" and j["quarters"] == [] and j["selected"] is None
    api.mk_client("X")
    q4(api)
    assert api.get("/api/operations").json()["empty"] == "no_appliances"


def test_derivation_three_windows_and_not_set_reasons(op):
    q4(op)
    j, r = rows(op)
    assert j["appliance_total"] == 6 and j["summary"]["total"] == 6          # US-15.1: every bams_objects row
    assert r["A-EAST"]["date"]["effective"] == "2026-11-07" and r["A-EAST"]["date"]["source"] == "quarter"
    assert r["A-WEST"]["date"]["effective"] == "2026-11-14"
    assert r["A-DEV"]["date"]["effective"] == "2026-10-10"
    assert r["A-NOPOL"]["date"]["reason"] == "Set East or West" and r["A-NOPOL"]["can_record"] is False
    assert r["A-NOENV"]["date"]["reason"].startswith("Set Environment")
    q4(op, east_prod_date=None, expected_row_version=1)
    _, r = rows(op)
    assert r["A-EAST"]["date"]["effective"] is None and r["A-EAST"]["date"]["reason"] == "No PROD East date in 2026 Q4"


def test_quarter_version_applies_automatically_and_override_wins(op):
    q4(op)                                              # no per-appliance step needed
    _, r = rows(op)
    assert all(x["version"]["effective"] == "4.78.0" and x["version"]["source"] == "quarter" for x in r.values())
    assert save(op, "A-EAST", target_version="4.80.1").status_code == 200
    # editing the quarter version moves every appliance that follows it, never the overridden one
    q4(op, apics_version="4.79.0", expected_row_version=1)
    _, r = rows(op)
    assert r["A-WEST"]["version"]["effective"] == "4.79.0"
    assert r["A-EAST"]["version"] == {"effective": "4.80.1", "source": "appliance", "own": "4.80.1", "quarter_default": "4.79.0"}
    # blank override follows the quarter again
    assert save(op, "A-EAST", target_version=None).status_code == 200
    _, r = rows(op)
    assert r["A-EAST"]["version"]["effective"] == "4.79.0" and r["A-EAST"]["version"]["own"] is None
    # no write touched the appliances when only the quarter changed
    assert op.sql("SELECT count(*) n FROM server_upgrades WHERE target_version IS NOT NULL")[0]["n"] == 0


def test_default_quarter_rule():
    qs = [{"schedule_year": 2026, "schedule_quarter": q, "dev_upgrade_date": d, "east_prod_date": None, "west_prod_date": None}
          for q, d in (("Q1", "2026-02-01"), ("Q3", "2026-09-01"), ("Q4", "2026-12-01"))]
    assert D.default_quarter(qs, "2026-10-14")["schedule_quarter"] == "Q4"
    assert D.default_quarter(qs, "2026-09-01")["schedule_quarter"] == "Q3"      # on-or-after
    assert D.default_quarter(qs, "2027-01-01")["schedule_quarter"] == "Q4"      # all past -> latest
    assert D.default_quarter([], "2026-01-01") is None


def test_overdue_boundary_and_closed_statuses(op):
    q4(op, dev_upgrade_date="2026-10-13", east_prod_date="2026-10-14")
    _, r = rows(op)
    assert r["A-DEV"]["overdue"] is True and r["A-EAST"]["overdue"] is False       # yesterday yes, today no
    assert save(op, "A-DEV", status="Completed").status_code == 200
    _, r = rows(op)
    assert r["A-DEV"]["overdue"] is False
    assert save(op, "A-DEV", status="Deferred").status_code == 200 and rows(op)[1]["A-DEV"]["overdue"] is False
    assert save(op, "A-DEV", status="In Progress").status_code == 200 and rows(op)[1]["A-DEV"]["overdue"] is True


def test_grouping_summary_filters_and_order(op):
    q4(op)
    save(op, "A-WEST", status="Scheduled")
    save(op, "A-EAST", date_override="2026-10-01")
    j, _ = rows(op)
    assert [g["client_name"] for g in j["groups"]] == ["Acme Capital", "Beta Fund"]
    g = j["groups"][0]
    assert g["count"] == 5 and g["summary"]["by_status"]["Scheduled"] == 1 and g["summary"]["total"] == 5
    assert [x["appliance"] for x in g["rows"]][0] == "A-EAST"            # earliest date first; empty dates last
    assert [x["date"]["effective"] for x in g["rows"]][-2:] == [None, None]
    assert sum(x["summary"]["total"] for x in j["groups"]) == j["summary"]["total"] == 6
    j2, r2 = rows(op, status="Scheduled")
    assert list(r2) == ["A-WEST"] and j2["summary"]["total"] == 1 and j2["appliance_total"] == 6
    assert set(rows(op, environment="DEV")[1]) == {"A-DEV"}
    assert set(rows(op, polarity="unset")[1]) == {"A-NOPOL", "A-DEV"}
    assert set(rows(op, q="beta")[1]) == {"B-WEST"}
    assert op.get("/api/operations", status="Bogus").status_code == 422
    assert op.get("/api/operations", year=2026).status_code == 422


# ---------------------------------------------------------------- quarters
def test_quarter_crud_conflicts_and_audit(op):
    item = q4(op)
    assert item["label"] == "2026 Q4" and item["row_version"] == 1
    op.err("/api/operations/quarter/save", {"year": 2026, "quarter": "Q4"}, 409, "conflict")
    op.err("/api/operations/quarter/save", {"year": 2026, "quarter": "Q5"}, 422, "validation_error")
    op.err("/api/operations/quarter/save", {"year": 2026, "quarter": "Q1", "dev_upgrade_date": "2026-02-30"}, 422, "validation_error")
    op.err("/api/operations/quarter/save", {"year": 2026, "quarter": "Q4", "apics_version": "x" * 51,
                                            "expected_row_version": 1}, 422, "validation_error")
    up2 = q4(op, apics_version="4.9", expected_row_version=1)
    assert up2["row_version"] == 2
    op.err("/api/operations/quarter/save", {"year": 2026, "quarter": "Q4", "expected_row_version": 1}, 409, "stale_write")
    op.err("/api/operations/quarter/save", {"year": 2030, "quarter": "Q1", "expected_row_version": 1}, 404, "not_found")
    assert [a["action"] for a in op.audit(object_type="quarterly_upgrade_window")] == ["created", "updated"]
    assert op.audit(object_type="quarterly_upgrade_window")[0]["category"] == "operations"
    assert op.sql("SELECT source_sync_method m FROM quarterly_upgrade_windows")[0]["m"] == "manual"


def test_quarter_delete_blocked_then_confirmed_with_backup(op):
    q4(op)
    save(op, "A-DEV", status="Scheduled")
    save(op, "A-WEST", status="Scheduled")
    e = op.err("/api/operations/quarter/delete", {"year": 2026, "quarter": "Q4", "confirm": True}, 409, "conflict")
    assert e["message"] == "2 appliances have a status in this quarter"
    for n in ("A-DEV", "A-WEST"):
        op.ok("/api/operations/appliance/reset", {"object_id": oid(op, n), "year": 2026, "quarter": "Q4", "confirm": True})
    op.err("/api/operations/quarter/delete", {"year": 2026, "quarter": "Q4"}, 409, "confirmation_required")
    j = op.ok("/api/operations/quarter/delete", {"year": 2026, "quarter": "Q4", "confirm": True})
    assert any(s["type"] == "backup_created" for s in j["side_effects"])
    assert op.sql("SELECT count(*) n FROM quarterly_upgrade_windows")[0]["n"] == 0
    assert op.audit(object_type="quarterly_upgrade_window")[-1]["action"] == "deleted"


# ---------------------------------------------------------------- appliance save / reset
def test_appliance_save_create_update_conflict_and_validation(op):
    q4(op)
    r = save(op, "A-WEST", status="Awaiting Client", notes="n1", date_override="2026-11-20")
    assert r.status_code == 200
    it = r.json()["item"]
    assert it["status"] == "Awaiting Client" and it["date"]["source"] == "override" and it["record_row_version"] == 1
    rec = op.sql("SELECT * FROM server_upgrades")[0]
    assert (rec["environment"], rec["polarity"], rec["schedule_quarter"]) == ("PROD", "West", "Q4")
    r2 = save(op, "A-WEST", status="Scheduled", expected_row_version=1).json()["item"]
    assert r2["record_row_version"] == 2 and r2["notes"] == "n1"          # omitted fields untouched
    assert save(op, "A-WEST", status="Completed", expected_row_version=1).json()["error"]["code"] == "stale_write"
    assert op.sql("SELECT status s FROM server_upgrades")[0]["s"] == "Scheduled"
    assert save(op, "A-WEST", status="Nonsense").status_code == 422
    assert save(op, "A-WEST", status=None).status_code == 422
    assert save(op, "A-WEST", date_override="2026-13-01").status_code == 422
    # clearing an override
    it = save(op, "A-WEST", date_override=None).json()["item"]
    assert it["date"]["source"] == "quarter"
    assert [a["action"] for a in op.audit(object_type="server_upgrade")] == ["created", "updated", "updated"]
    # unknown quarter / appliance
    assert op.post("/api/operations/appliance/save", {"object_id": oid(op, "A-WEST"), "year": 2030, "quarter": "Q1"}).status_code == 404
    assert op.post("/api/operations/appliance/save", {"object_id": "nope", "year": 2026, "quarter": "Q4"}).status_code == 404


def test_prod_without_polarity_cannot_get_a_record(op):
    q4(op)
    r = save(op, "A-NOPOL", status="Scheduled")
    assert r.status_code == 422 and "East or West" in r.json()["error"]["fields"]["polarity"]
    assert save(op, "A-NOENV", status="Scheduled").status_code == 422
    assert op.sql("SELECT count(*) n FROM server_upgrades")[0]["n"] == 0
    op.ok("/api/bams/object/save", {"id": oid(op, "A-NOPOL"), "region": "East",
                                    "expected_row_version": op.sql("SELECT row_version v FROM bams_objects WHERE name='A-NOPOL'")[0]["v"]})
    assert save(op, "A-NOPOL", status="Scheduled").status_code == 200


def test_reset_needs_confirm_backs_up_and_follows_quarter(op):
    q4(op)
    save(op, "A-DEV", status="Scheduled", target_version="9.9", date_override="2026-12-01")
    body = {"object_id": oid(op, "A-DEV"), "year": 2026, "quarter": "Q4"}
    op.err("/api/operations/appliance/reset", body, 409, "confirmation_required")
    op.err("/api/operations/appliance/reset", {**body, "confirm": True, "expected_row_version": 7}, 409, "stale_write")
    j = op.ok("/api/operations/appliance/reset", {**body, "confirm": True})
    assert j["item"]["status_is_default"] and j["item"]["version"]["effective"] == "4.78.0"
    assert any(s["type"] == "backup_created" for s in j["side_effects"])
    assert op.sql("SELECT count(*) n FROM server_upgrades")[0]["n"] == 0
    op.ok("/api/operations/appliance/reset", {**body, "confirm": True})        # idempotent


# ---------------------------------------------------------------- set-version
def sv(op, names, version, **kw):
    return op.post("/api/operations/appliance/set-version",
                   {"year": 2026, "quarter": "Q4", "object_ids": [oid(op, n) for n in names], "target_version": version, **kw})


def test_set_version_bulk_skips_audits_and_leaves_other_fields(op):
    q4(op)
    save(op, "A-EAST", status="Scheduled", date_override="2026-11-01")
    before = op.sql("SELECT count(*) n FROM audit_events")[0]["n"]
    r = sv(op, ["A-EAST", "A-WEST", "A-DEV", "A-NOPOL", "A-NOENV"], "5.0.1")
    assert r.status_code == 200
    it = r.json()["item"]
    assert sorted(x["appliance"] for x in it["updated"]) == ["A-DEV", "A-EAST", "A-WEST"]
    assert {x["appliance"]: x["code"] for x in it["skipped"]} == {"A-NOPOL": "needs_polarity", "A-NOENV": "needs_environment"}
    assert it["message"].startswith("Version set on 3; 2 skipped")
    assert op.sql("SELECT count(*) n FROM audit_events")[0]["n"] - before == 3          # one per appliance
    e = op.sql("SELECT status, scheduled_date, target_version FROM server_upgrades WHERE server_name = 'A-EAST'")[0]
    assert (e["status"], e["scheduled_date"], e["target_version"]) == ("Scheduled", "2026-11-01", "5.0.1")
    assert rows(op)[1]["A-WEST"]["status"] == "Planned"
    # blank clears back to the quarter default; appliances without a record are untouched (no row created)
    it = sv(op, ["A-EAST", "A-WEST", "B-WEST"], None).json()["item"]
    assert len(it["updated"]) == 2 and [x["appliance"] for x in it["unchanged"]] == ["B-WEST"]
    assert rows(op)[1]["A-EAST"]["version"]["effective"] == "4.78.0"
    assert op.sql("SELECT count(*) n FROM server_upgrades")[0]["n"] == 3
    # same value again is a no-op
    assert len(sv(op, ["A-DEV"], "5.0.1").json()["item"]["unchanged"]) == 1


def test_set_version_cap_validation_and_atomicity(op, monkeypatch):
    q4(op)
    assert op.post("/api/operations/appliance/set-version", {"year": 2026, "quarter": "Q4", "object_ids": [f"x{i}" for i in range(501)]}).status_code == 422
    assert op.post("/api/operations/appliance/set-version", {"year": 2026, "quarter": "Q4", "object_ids": []}).status_code == 422
    assert sv(op, ["A-DEV"], "x" * 51).status_code == 422
    assert op.post("/api/operations/appliance/set-version", {"year": 2030, "quarter": "Q1", "object_ids": ["a"]}).status_code == 404
    ids = [oid(op, n) for n in ("A-DEV", "A-EAST", "A-WEST")]
    from server import audit as A
    from server.ops import service as OS
    calls = {"n": 0}
    real = OS._audit

    def boom(*a, **k):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("injected")
        return real(*a, **k)
    monkeypatch.setattr(OS, "_audit", boom)
    r = op.post("/api/operations/appliance/set-version", {"year": 2026, "quarter": "Q4", "object_ids": ids, "target_version": "7"})
    assert r.status_code == 500
    assert op.sql("SELECT count(*) n FROM server_upgrades")[0]["n"] == 0                # all rolled back
    assert A is not None


def test_unknown_operations_subroutes_stay_501(op):
    assert op.c.post("/api/operations/schedule/sync").status_code == 501
    assert op.c.delete("/api/operations").status_code == 501


# ---------------------------------------------------------------- import additions (T-165)
def test_polarity_alias_and_east_west_normalisation(op):
    """Polarity is its own column (0.2.0): authoritative East/West, overrides Region; Region keeps free text."""
    item = inspect_ok(op, [R(appliance="N1", ticker="N1.T", polarity="EAST", env="PROD"),
                           R(appliance="N2", metric="M", ticker="N2.T", polarity=" west ", region="Europe", env="DEV"),
                           R(appliance="N3", metric="M", ticker="N3.T", region="Americas", env="PROD")])
    bad = inspect_ok(op, [R(appliance="N4", ticker="N4.T", polarity="North")])
    assert [e["code"] for e in bad["rows"][0]["errors"]] == ["polarity_invalid"]
    vals = {r["values"]["appliance"]: r["values"]["region"] for r in item["rows"]}
    assert vals == {"N1": "East", "N2": "West", "N3": "Americas"}                 # other text still imports
    assert item["operations_note"] == {"count": 1, "text": "1 appliances need East or West set for Operations"}
    res = apply(op, item)["item"]
    assert res["operations_note"]["count"] == 1
    assert {o["name"]: o["region"] for o in op.sql("SELECT name, region FROM bams_objects WHERE name LIKE 'N%'")} == vals


def test_ops_note_counts_missing_env_and_respects_existing_values(op):
    # existing A-NOENV has region East but no environment -> still counted; existing A-EAST complete -> not counted
    item = inspect_ok(op, [R(appliance="A-NOENV", metric="M2", ticker="Z.1"), R(appliance="A-EAST", metric="M2", ticker="Z.2"),
                           R(appliance="BRAND", ticker="Z.3", region="East"), R(appliance="BRAND2", ticker="Z.4", region="East", env="PROD")])
    assert item["operations_note"]["count"] == 2                                  # A-NOENV, BRAND
    assert apply(op, item)["item"]["operations_note"]["count"] == 2
    none = inspect_ok(op, [R(appliance="BRAND2", metric="M3", ticker="Z.5")])
    assert none["operations_note"] == {"count": 0, "text": None}


def test_region_header_still_works_and_template_text(op):
    item = inspect_ok(op, [R(appliance="Q1", ticker="Q1.T", region="west", env="PROD")])
    assert item["rows"][0]["values"]["region"] == "West"
    assert bams_reader.norm_polarity("Europe") == "Europe" and bams_reader.norm_polarity(None) is None
    r = op.get("/api/import/bams/template", format="xlsx")
    import io
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    text = " ".join(str(c.value) for row in wb["Instructions"].iter_rows() for c in row if c.value)
    assert "Polarity: optional East or West" in text
    assert any(dv.sqref and "K2" in str(dv.sqref) and dv.errorStyle == "stop" for dv in wb["Import"].data_validations.dataValidation)
    assert [c.value for c in wb["Import"][1]] == HEAD
    assert up(op, [R(appliance="E1", ticker="E1.T", region="East", env="PROD")], name="e.xlsx").status_code == 200


def test_orphan_records_not_counted_and_cleared_on_quarter_delete(op):
    """QA-6-1"""
    q4(op)
    op.exec("INSERT INTO server_upgrades (id, client_id, server_name, environment, polarity, schedule_year, schedule_quarter)"
            " VALUES ('orph1', ?, 'GONE-01', 'DEV', 'DEV', 2026, 'Q4')", (op.cid,))
    assert op.get("/api/operations").json()["quarters"][0]["records"] == 0
    op.ok("/api/operations/quarter/delete", {"year": 2026, "quarter": "Q4", "confirm": True})
    assert op.sql("SELECT count(*) n FROM server_upgrades")[0]["n"] == 0
    assert [a["action"] for a in op.audit(object_type="server_upgrade")] == ["deleted"]


def test_rename_carries_operations_record(op):
    q4(op)
    save(op, "A-WEST", status="Scheduled", target_version="6.6")
    ov = op.sql("SELECT row_version v FROM bams_objects WHERE name='A-WEST'")[0]["v"]
    op.ok("/api/bams/object/save", {"id": oid(op, "A-WEST"), "name": "A-WEST-2", "expected_row_version": ov})
    assert op.sql("SELECT server_name FROM server_upgrades")[0]["server_name"] == "A-WEST-2"
    r = rows(op)[1]["A-WEST-2"]
    assert r["status"] == "Scheduled" and r["version"]["own"] == "6.6" and r["record_id"]
    a = [x for x in op.audit(object_type="server_upgrade") if x["reason"] == "appliance renamed in BAMS"]
    assert len(a) == 1 and a[0]["category"] == "operations"
    # case-only rename keeps the record too
    ov = op.sql("SELECT row_version v FROM bams_objects WHERE name='A-WEST-2'")[0]["v"]
    op.ok("/api/bams/object/save", {"id": oid(op, "A-WEST-2"), "name": "a-west-2", "expected_row_version": ov})
    assert rows(op)[1]["a-west-2"]["status"] == "Scheduled"


def test_rename_collision_with_orphan_record_is_refused_atomically(op):
    q4(op)
    save(op, "A-WEST", status="Scheduled")
    op.exec("INSERT INTO server_upgrades (id, client_id, server_name, environment, polarity, schedule_year, schedule_quarter)"
            " VALUES ('orph2', ?, 'TAKEN', 'DEV', 'DEV', 2026, 'Q4')", (op.cid,))
    ov = op.sql("SELECT row_version v FROM bams_objects WHERE name='A-WEST'")[0]["v"]
    e = op.err("/api/bams/object/save", {"id": oid(op, "A-WEST"), "name": "TAKEN", "expected_row_version": ov}, 409, "conflict")
    assert "2026 Q4" in e["message"]
    assert op.sql("SELECT name FROM bams_objects WHERE id = ?", (oid(op, "A-WEST"),))[0]["name"] == "A-WEST"
    assert op.sql("SELECT count(*) n FROM server_upgrades WHERE server_name='A-WEST'")[0]["n"] == 1


def test_bams_import_apply_never_renames(op):
    q4(op)
    save(op, "A-WEST", status="Scheduled")
    item = inspect_ok(op, [R(appliance="A-WEST", metric="CPU", ticker="O.W", location="NY")])
    apply(op, item)
    assert rows(op)[1]["A-WEST"]["status"] == "Scheduled"
