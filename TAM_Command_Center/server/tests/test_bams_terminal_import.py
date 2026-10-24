"""Bloomberg Terminal BAMS workbook auto-detection wired into the BAMS import (B-2)."""
from __future__ import annotations

import io

import openpyxl

from server.importer import bams_terminal_adapter as TA
from server.tests.test_bams_import import R, apply, ia, inspect_ok, up  # noqa: F401  (ia is a fixture)

TERMINAL_HEAD = ["Client", "Ticker", "Region", "Metric", "DC Location", "Current"]


def terminal_book(rows, head=TERMINAL_HEAD):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "BAMS"
    ws.append(head)
    for r in rows:
        ws.append(r)
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


def post(api, data, name="terminal.xlsx"):
    return api.c.post("/api/import/bams/inspect", content=data, headers={"X-File-Name": name})


ROWS = [
    ["Acme Capital", "BMSES 111 49686 Index", "AMER", "CPU utilisation", "New York", 12.3],
    ["Acme Capital", "BMSES 222 49686", "AMER", "Memory", "New York", 40],
    ["ACME CAPITAL (2)", "ignored separator", None, None, None, None],   # never matches: has a client
]


def test_adapter_returns_none_for_template_workbooks():
    assert TA.normalize_terminal_upload(terminal_book([], head=["Account", "Appliance", "Metric", "Ticker"]), "t.xlsx") is None
    assert TA.normalize_terminal_upload(b"a,b\n1,2\n", "x.csv") is None


def test_terminal_workbook_is_detected_and_converted(ia):
    r = post(ia, terminal_book(ROWS[:2]))
    assert r.status_code == 200, r.text
    item = r.json()["item"]
    assert any("Bloomberg Terminal BAMS export recognised" in n for n in item["file"]["notes"])
    assert item["file"]["rows_found"] == 2 and item["counts"]["invalid"] == 0
    assert item["appliances"]["new"] == 1 and item["metrics"]["new"] == 2
    vals = [x["values"] for x in item["rows"]]
    assert {v["appliance"] for v in vals} == {"BA49686"} and {v["location"] for v in vals} == {"New York"}
    assert vals[0]["ticker"] == "BMSES 111 49686 Index" and vals[1]["ticker"] == "BMSES 222 49686 Index"
    assert all(v["region"] is None for v in vals)                     # Terminal AMER/EMEA is not copied into Region
    res = apply(ia, item)["item"]
    assert res["counts"]["appliances_created"] == 1 and res["counts"]["metrics_created"] == 2
    assert ia.sql("SELECT count(*) n FROM bams_metrics")[0]["n"] == 2


def test_terminal_unknown_ticker_family_is_refused_cleanly(ia):
    r = post(ia, terminal_book([["Acme Capital", "BMSEX 1 2 Index", "AMER", "CPU", "NY", 1]]))
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "terminal_bams_family_unmapped"
    r = post(ia, terminal_book([["Acme Capital", "garbage", "AMER", "CPU", "NY", 1]]))
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "terminal_bams_ticker_invalid"


def test_template_import_is_unchanged_by_the_adapter(ia):
    item = inspect_ok(ia, [R(appliance="B1", ticker="T1")])
    assert not any("Terminal" in n for n in item["file"]["notes"]) and item["counts"]["new"] == 1
    assert up(ia, [R()], name="a.csv").status_code == 200
