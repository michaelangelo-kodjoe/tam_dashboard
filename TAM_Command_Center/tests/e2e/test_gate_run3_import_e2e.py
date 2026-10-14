"""Run 3 gate (T-92..T-94, ERROR_LOG_4): account bulk import (xlsx + csv) with duplicate detection.

Black-box against a real DEV uvicorn process on a scratch tree/DB. Expected values come from the spec
(docs/01_PM_SPEC.md D-37..D-48, docs/04_API_CONTRACT.md 10) and from direct SQLite reads, not from server code.
Run from TAM_Command_Center/:  .venv/bin/python -m pytest tests/e2e/test_gate_run3_import_e2e.py -q
"""
from __future__ import annotations

import io
import json
import re
import sqlite3
import sys
import zipfile
from pathlib import Path

import httpx
import openpyxl
import pytest

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "server" / "tests"))
from test_gate32_e2e import free_port, make_tree, start  # noqa: E402
from importkit import HEAD, csv_bytes, rezip, xlsx  # noqa: E402

MIB = 1024 * 1024


class Api:
    def __init__(self, c, db, bdir):
        self.c, self.db, self.bdir = c, db, bdir

    def q(self, sql, *a):
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            return con.execute(sql, a).fetchall()
        finally:
            con.close()

    def counts(self):
        return (self.q("select count(*) from clients")[0][0], self.q("select count(*) from audit_events")[0][0],
                len(list(self.bdir.glob("*pre-import*"))))

    def add(self, name, **kw):
        r = self.c.post("/api/client/save", json={"name": name, "duplicates_confirmed": True, **kw})
        assert r.status_code == 200, r.text
        return r.json()["item"]

    def up(self, data, name="a.xlsx"):
        return self.c.post("/api/import/accounts/inspect", content=data,
                           headers={"X-File-Name": name, "Content-Type": "application/octet-stream"})

    def ins(self, data, name="a.xlsx"):
        r = self.up(data, name)
        assert r.status_code == 200, r.text
        return r.json()["item"]

    def apply(self, imp, decisions=(), **kw):
        body = {"import_id": imp["import_id"], "plan_hash": imp["plan_hash"], "confirm": True,
                "decisions": list(decisions)}
        body.update(kw)
        return self.c.post("/api/import/accounts/apply", json=body)

    def client(self, name):
        r = self.q("select id,name,bpid,products,status,next_contact,notes,row_version from clients where name=? collate nocase", name)
        return r[0] if r else None


@pytest.fixture(scope="module")
def api(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("run3"))
    port = free_port()
    p = start(tree, port, {"TAM_DEV_MODE": "1"})
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60) as c:
        yield Api(c, tree / "dev_data" / "tam_dev.db", tree / "dev_data" / "TAM_Backups")
    p.terminate()
    p.wait(5)


def rows_by(item):
    return {r["row"]: r for r in item["rows"]}


def no_score(obj):
    s = json.dumps(obj).lower()
    assert "%" not in s, "percent sign in payload"
    assert not re.search(r"score|similarity|confidence|percent", s)


# ------------------------------------------------------------------ US-13.1 templates
def test_template_xlsx_and_csv(api):
    r = api.c.get("/api/import/accounts/template")
    assert r.status_code == 200 and "spreadsheetml" in r.headers["content-type"]
    assert r.headers["cache-control"] == "no-store"
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == ["Instructions", "Accounts", "Lists"]
    assert wb["Lists"].sheet_state == "hidden"
    ws = wb["Accounts"]
    assert [c.value.replace(" *", "").rstrip("*") if isinstance(c.value, str) else c.value for c in ws[1][:6]] == HEAD
    dv = [d for d in ws.data_validations.dataValidation if d.type == "list"]
    assert dv and "D" in str(dv[0].sqref)
    vals = [c.value for row in wb["Lists"].iter_rows() for c in row if c.value]
    check = re.search(r"status\s+TEXT[^,]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)", (ROOT / "db" / "schema.sql").read_text(), re.I | re.S)
    schema_vals = re.findall(r"'([^']+)'", check.group(1))
    assert schema_vals == ["Active", "Inactive"]
    assert set(schema_vals) <= set(vals) and not (set(vals) - set(schema_vals) - {"Status"})
    assert not any(isinstance(c.value, str) and c.value.startswith("=") for row in ws.iter_rows(min_row=2) for c in row)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert not any("vbaProject" in n or "externalLink" in n for n in z.namelist())
    r = api.c.get("/api/import/accounts/template?format=csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.content.startswith(b"\xef\xbb\xbf")
    assert r.content.decode("utf-8-sig").strip().split(",")[:6] and r.content.decode("utf-8-sig").count("\n") <= 1
    assert api.c.get("/api/import/accounts/template?format=pdf").status_code == 422


def test_template_roundtrips_empty_as_no_rows(api):
    r = api.up(api.c.get("/api/import/accounts/template").content)
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "no_rows"
    r = api.up(api.c.get("/api/import/accounts/template?format=csv").content, "t.csv")
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "no_rows"


# ------------------------------------------------------------------ flagging, reasons, no score, no write
def test_user_example_flagged_with_reasons_and_no_write(api):
    api.add("Web Ltd", bpid="777001")
    cpid = api.client("Castellan Peak Global Markets")
    api.c.post("/api/client/save", json={"id": cpid[0], "expected_row_version": cpid[7], "bpid": "300", "products": "Terminal", "next_contact": None, "notes": None})
    before = api.counts()
    data = xlsx([("web mgmt ltd", None, "B-PIPE", None, None, None),
                 ("  castellan  peak GLOBAL markets ", "300", "X", "Active", "2026-12-01", "n"),
                 ("Acme Capital", None, None, None, None, None)])
    imp = api.ins(data)
    assert api.counts() == before  # nothing written by Inspect
    rows = rows_by(imp)
    assert rows[2]["state"] == "needs_review"
    cand = rows[2]["candidates"][0]
    assert cand["name"] == "Web Ltd" and cand["strength"] in ("High", "Medium", "Low")
    assert cand["strength"] == "Medium" and [x["code"] for x in cand["reasons"]] == ["contained_name"]
    assert rows[3]["state"] == "update" and rows[3]["match"]["kind"] == "exact" and not rows[3]["candidates"]
    assert rows[3]["match"]["fills"] == {"next_contact": "2026-12-01", "notes": "n"}
    assert rows[3]["match"]["kept"]["products"]["existing"] == "Terminal"
    assert rows[4]["state"] == "new"
    assert imp["counts"]["needs_review"] == 1 and imp["counts"]["updates"] == 1 and imp["counts"]["new"] == 1
    no_score(imp)
    # Apply with unresolved flag -> 409 and nothing written, no backup
    r = api.apply(imp)
    assert r.status_code == 409 and r.json()["error"]["code"] == "unresolved_duplicates"
    assert r.json()["error"]["details"]["rows"] == [2]
    assert api.counts() == before
    # decide different -> applies
    r = api.apply(imp, [{"row": 2, "choice": "different"}])
    assert r.status_code == 200, r.text
    res = r.json()["item"]
    assert res["counts"]["created"] == 2 and res["counts"]["updated"] == 1 and res["counts"]["overwritten"] == 0
    assert api.client("web mgmt ltd") and api.client("Acme Capital")
    cp = api.client("Castellan Peak Global Markets")
    assert cp[3] == "Terminal" and cp[5] == "2026-12-01" and cp[6] == "n"  # products kept, blanks filled
    # backup exists, integrity ok
    bk = api.bdir / res["backup"]["name"]
    assert bk.exists()
    con = sqlite3.connect(f"file:{bk}?mode=ro", uri=True)
    assert con.execute("pragma integrity_check").fetchone()[0] == "ok"
    assert con.execute("select count(*) from clients").fetchone()[0] == before[0]  # backup is pre-import state
    con.close()
    # audit: one per created/updated account, source Bulk Import
    ev = api.q("select object_type,action,source,reason,object_label from audit_events where source='Bulk Import' order by id")
    assert len(ev) == 3 == res["audit_events"] and {e[4] for e in ev} == {"web mgmt ltd", "Acme Capital", "Castellan Peak Global Markets"}
    assert all(e[0] == "client" and e[3].startswith("Bulk import: a.xlsx, row") for e in ev)
    assert sorted(e[1] for e in ev) == ["created", "created", "updated"]
    # already_applied
    r = api.apply(imp, [{"row": 2, "choice": "different"}])
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_applied"
    # idempotent re-import: rows now all exact -> unchanged, no write/backup/audit
    c0, a0, b0 = api.counts()
    imp2 = api.ins(data)
    assert imp2["counts"]["new"] == 0 and imp2["counts"]["needs_review"] == 0
    assert imp2["counts"]["unchanged"] == 3
    r = api.apply(imp2)
    assert r.status_code == 200 and r.json()["item"]["backup"] is None and r.json()["item"]["audit_events"] == 0
    assert api.counts() == (c0, a0, b0)


def test_check_similar_and_server_side_enforcement(api):
    api.add("Zork Mgmt Ltd", bpid="55")
    r = api.c.post("/api/client/check-similar", json={"name": "zork ltd"})
    assert r.status_code == 200
    it = r.json()["item"]
    assert it["exact"] is None and it["candidates"][0]["name"] == "Zork Mgmt Ltd"
    assert it["candidates"][0]["strength"] in ("High", "Medium", "Low")
    no_score(it)
    r = api.c.post("/api/client/check-similar", json={"name": "  ZORK mgmt   ltd "})
    assert r.json()["item"]["exact"]["name"] == "Zork Mgmt Ltd"
    n0 = api.counts()
    # direct API call without the flag
    r = api.c.post("/api/client/save", json={"name": "zork ltd"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "possible_duplicate"
    assert r.json()["error"]["details"]["candidates"]
    r = api.c.post("/api/client/save", json={"name": "zork ltd", "duplicates_confirmed": False})
    assert r.status_code == 409
    assert api.counts() == n0
    # exact twin stays conflict even with flag
    r = api.c.post("/api/client/save", json={"name": "ZORK MGMT LTD", "duplicates_confirmed": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict"
    # no candidates creates directly
    r = api.c.post("/api/client/save", json={"name": "Qwertyuiop Zxcvbn Unique"})
    assert r.status_code == 200
    # confirmed creates
    r = api.c.post("/api/client/save", json={"name": "zork ltd", "duplicates_confirmed": True})
    assert r.status_code == 200
    # update unaffected by dup check
    it = r.json()["item"]
    r = api.c.post("/api/client/save", json={"id": it["id"], "expected_row_version": it["row_version"], "notes": "x"})
    assert r.status_code == 200
    # parity import vs check-similar
    imp = api.ins(xlsx([("Zork Holdings Limited",)]))
    ci = api.c.post("/api/client/check-similar", json={"name": "Zork Holdings Limited"}).json()["item"]["candidates"]
    strip = lambda cs: [(c["ref"], c["strength"], [x["code"] for x in c["reasons"]], [x["text"] for x in c["reasons"]]) for c in cs]
    assert strip(imp["rows"][0]["candidates"]) == strip(ci)


# ------------------------------------------------------------------ merge semantics
def test_fill_blanks_only_inactive_and_decisions(api):
    a = api.add("Lumen Dormant Partners Trust", status="Inactive", bpid="L1")
    b = api.add("Tessel Rivers Fund")
    data = xlsx([("Lumen Dormant Partners Trust", "L1", "P", "Active", "2027-01-02", "N"),
                 ("Tessel Rivers Fund Ltd", "T9", "PP", "Inactive", None, "M")])
    imp = api.ins(data)
    r1, r2 = imp["rows"]
    assert r1["state"] == "update" and "Existing account is Inactive and stays Inactive" in r1["match"]["notes"]
    assert r2["state"] == "needs_review"
    # same without target on single candidate? with multiple needs target; supply target
    ref = r2["candidates"][0]["ref"]
    # bad decisions -> 422
    for bad in ([{"row": 3, "choice": "same"}],
                [{"row": 2, "choice": "skip"}, {"row": 3, "choice": "skip"}],
                [{"row": 3, "choice": "different", "target": ref}],
                [{"row": 3, "choice": "same", "target": {"type": "account", "id": "nope"}}]):
        r = api.apply(imp, bad)
        assert r.status_code == 422, (bad, r.text)
    n0 = api.counts()
    assert api.apply(imp, [{"row": 3, "choice": "same", "target": ref}, {"row": 3, "choice": "skip"}]).status_code == 422
    assert api.counts() == n0
    r = api.apply(imp, [{"row": 3, "choice": "same", "target": ref}])
    assert r.status_code == 200, r.text
    la = api.client("Lumen Dormant Partners Trust")
    assert la[4] == "Inactive" and la[3] == "P" and la[5] == "2027-01-02" and la[6] == "N" and la[2] == "L1"
    tb = api.client("Tessel Rivers Fund")
    assert tb[4] == "Active" and tb[2] == "T9" and tb[3] == "PP" and tb[6] == "M" and tb[5] is None
    assert not api.client("Tessel Rivers Fund Ltd")
    # second import with different values: nothing overwritten
    imp = api.ins(xlsx([("Tessel Rivers Fund", "ZZ", "QQ", "Inactive", "2030-01-01", "OTHER")]))
    assert imp["rows"][0]["match"]["fills"] == {"next_contact": "2030-01-01"} and imp["rows"][0]["match"]["kept"]["bpid"]["differs"]
    assert api.apply(imp).status_code == 200
    tb = api.client("Tessel Rivers Fund")
    assert (tb[2], tb[3], tb[4], tb[6]) == ("T9", "PP", "Active", "M") and tb[5] == "2030-01-01"


def test_in_file_duplicates(api):
    data = xlsx([("Velvet Quillon Fund", None, "A", None, None, None),
                 ("velvet  QUILLON fund", "V1", "B", None, "2027-02-02", None),
                 ("Velvet Quillon Fund Ltd", None, None, None, None, None)])
    imp = api.ins(data)
    rows = rows_by(imp)
    assert rows[3].get("merged_into") == {"row": 2}
    assert rows[4]["state"] == "needs_review" and rows[4]["candidates"][0]["ref"] == {"type": "row", "row": 2}
    assert rows[4]["candidates"][0]["strength"] == "High"
    r = api.apply(imp, [{"row": 4, "choice": "same", "target": {"type": "row", "row": 2}}])
    assert r.status_code == 200, r.text
    v = api.client("Velvet Quillon Fund")
    assert (v[2], v[3], v[5]) == ("V1", "A", "2027-02-02")  # earlier row wins, later fills blanks
    assert api.q("select count(*) from clients where name like 'Velvet Q%'")[0][0] == 1
    # skipped earlier row cannot be a target
    imp = api.ins(xlsx([("Yarrow Quasar Fund",), ("Yarrow Quasar Fund Ltd",)]))
    r = api.apply(imp, [{"row": 2, "choice": "same", "target": {"type": "row", "row": 2}}] if False else
                  [{"row": 3, "choice": "same", "target": {"type": "row", "row": 2}}])
    assert r.status_code == 200


def test_invalid_rows_and_skipped_download(api):
    data = xlsx([("Good Row One Co", None, None, "Active", None, None),
                 ("Bad Status Co", None, None, "Dormant", None, None),
                 ("Bad Date Co", None, None, None, "13/45/2026", None),
                 ("", "B1", None, None, None, None),
                 ("X" * 201, None, None, None, None, None),
                 ("Formula Co", None, None, None, None, None)], formulas=["A7"])
    imp = api.ins(data)
    st = {r["row"]: r["state"] for r in imp["rows"]}
    assert st[2] == "new" and all(st[i] == "invalid" for i in (3, 4, 5, 6, 7)), st
    assert imp["counts"]["invalid"] == 5
    codes = {r["row"]: r["errors"][0]["code"] for r in imp["rows"] if r["errors"]}
    assert codes[3] == "status_not_allowed" and codes[4] == "date_invalid" and codes[5] == "name_required"
    assert codes[6] == "name_too_long" and codes[7] in ("formula_not_allowed", "cell_error")
    assert all(len(v) <= 500 for r in imp["rows"] if r["raw"] for v in r["raw"].values() if isinstance(v, str))
    res = api.apply(imp).json()["item"]
    assert res["counts"]["created"] == 1 and res["counts"]["skipped"] == 5
    r = api.c.get(res["skipped_url"])
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    ws = wb["Accounts"]
    assert [c.value for c in ws[1]][:6] == HEAD and ws.max_row == 6
    assert all(c.data_type != "f" for row in ws.iter_rows() for c in row)
    assert api.c.get(res["skipped_url"].replace(".xlsx", ".csv")).status_code == 404


# ------------------------------------------------------------------ stale / concurrency
def test_preview_stale_and_refresh(api):
    api.add("Cobalt Ridge Fund")
    imp = api.ins(xlsx([("Cobalt Ridge Fund", None, "P", None, None, None), ("Cobalt Ridge Fund Ltd",)]))
    # concurrent edit between Preview and Apply
    cid, _, _, _, _, _, _, rv = api.client("Cobalt Ridge Fund")
    r = api.c.post("/api/client/save", json={"id": cid, "expected_row_version": rv, "products": "Edited"})
    assert r.status_code == 200
    n0 = api.counts()
    dec = [{"row": 3, "choice": "different"}]
    r = api.apply(imp, dec)
    assert r.status_code == 409 and r.json()["error"]["code"] == "preview_stale", r.text
    assert api.counts() == n0
    fresh = api.c.get(f"/api/import/accounts/{imp['import_id']}")
    assert fresh.status_code == 200
    fi = fresh.json()["item"]
    assert fi["plan_hash"] != imp["plan_hash"]
    assert fi["rows"][0]["match"]["kept"]["products"]["existing"] == "Edited"
    r = api.apply(fi, dec)
    assert r.status_code == 200, r.text
    assert api.client("Cobalt Ridge Fund")[3] == "Edited"
    # deleted account between preview and apply
    api.add("Mistral Plain Fund")
    imp = api.ins(xlsx([("Mistral Plain Fund", None, "P", None, None, None)]))
    mid = api.client("Mistral Plain Fund")
    d = api.c.post("/api/client/delete", json={"id": mid[0], "confirm": True, "expected_row_version": mid[7]})
    if d.status_code == 200:
        r = api.apply(imp)
        assert r.status_code == 409 and r.json()["error"]["code"] == "preview_stale"
    assert api.apply({"import_id": "0" * 32, "plan_hash": "x"}).status_code == 410
    assert api.c.post("/api/import/accounts/apply", json={"import_id": imp["import_id"], "plan_hash": imp["plan_hash"],
                                                          "decisions": []}).status_code == 409


# ------------------------------------------------------------------ atomic rollback
def test_atomic_rollback_on_forced_failure(api):
    con = sqlite3.connect(api.db)
    con.execute("create trigger qa_boom before insert on audit_events when new.object_label='Boom Co' "
                "begin select raise(abort,'qa forced failure'); end")
    con.commit()
    con.close()
    n0 = api.counts()[:2]
    imp = api.ins(xlsx([("Qorvex Zimmel Co",), ("Ymber Sollace Co",), ("Boom Co",)]))
    r = api.apply(imp)
    assert r.status_code >= 500, r.text
    assert api.counts()[:2] == n0
    assert not api.client("Qorvex Zimmel Co") and not api.client("Ymber Sollace Co")
    con = sqlite3.connect(api.db)
    con.execute("drop trigger qa_boom")
    con.commit()
    con.close()
    # session still usable after the failure
    r = api.apply(imp)
    assert r.status_code in (200, 409, 410), r.text
    if r.status_code == 200:
        assert api.client("Boom Co")


# ------------------------------------------------------------------ caps
def test_row_cap_500_501(api):
    ok = api.up(xlsx([(f"Cap Account {i:04d} Zq{i}",) for i in range(500)]))
    assert ok.status_code == 200 and ok.json()["item"]["counts"]["rows"] == 500
    r = api.up(xlsx([(f"Cap Account {i:04d} Zq{i}",) for i in range(501)]))
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "too_many_rows"
    assert "812" not in r.text and r.json()["error"]["details"]["found"] == 501
    csv501 = "Account name\n" + "\n".join(f"Cap Account {i:04d} Zq{i}" for i in range(501))
    r = api.up(csv_bytes(csv501), "c.csv")
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "too_many_rows"
    # padded blank rows beyond 10,000
    r = api.up(xlsx([("Pad Co",)], padding=10500))
    assert r.status_code == 422 and r.json()["error"]["details"]["reason"] == "too_many_rows"
    # blank rows are ignored
    r = api.up(xlsx([("Blank A Co",), (None,), ("  ",), ("Blank B Co",)]))
    assert r.status_code == 200 and [x["row"] for x in r.json()["item"]["rows"]] == [2, 5]


def test_body_caps_only_upload_route_5mib(api):
    big3 = b"Account name\n" + b"A" * (3 * MIB)
    r = api.up(big3, "big.csv")
    assert r.status_code != 413, r.text  # under 5 MiB: processed (name too long -> invalid row)
    r = api.up(b"A" * (5 * MIB + 10), "big.csv")
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    assert r.json()["error"]["details"]["max_bytes"] == 5 * MIB
    # declared Content-Length over cap
    r = api.c.post("/api/import/accounts/inspect", content=b"x" * (5 * MIB + 1), headers={"X-File-Name": "a.csv"})
    assert r.status_code == 413
    # other routes keep 2 MiB
    for path in ("/api/client/check-similar", "/api/client/save", "/api/import/accounts/apply", "/api/note/save"):
        r = api.c.post(path, content=b"{" + b" " * (3 * MIB) + b"}", headers={"Content-Type": "application/json"})
        assert r.status_code == 413, (path, r.status_code)
    # server still healthy
    assert api.c.get("/api/health").status_code == 200


# ------------------------------------------------------------------ hostile files
def test_hostile_files(api):
    n0 = api.counts()
    good = xlsx([("Hostile Base Co",)])
    reason = lambda d, n: (lambda r: (r.status_code, r.json()["error"]["details"].get("reason") if r.status_code in (413, 422) else r.text))(api.up(d, n))
    # zip bomb: one highly compressible entry
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", b"0" * (60 * MIB))
    assert len(bomb.getvalue()) < 5 * MIB
    assert reason(bomb.getvalue(), "bomb.xlsx") == (422, "zip_unsafe")
    many = io.BytesIO()
    with zipfile.ZipFile(many, "w") as z:
        for i in range(250):
            z.writestr(f"xl/f{i}.xml", "x")
    assert reason(many.getvalue(), "many.xlsx")[0] == 422
    # traversal name
    assert reason(rezip(good, add={"../evil.xml": b"x"}), "t.xlsx")[0] == 422
    # XML entities
    sheet = next(n for n in zipfile.ZipFile(io.BytesIO(good)).namelist() if n.startswith("xl/worksheets/sheet"))
    ent = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><worksheet>&b;</worksheet>'
    assert reason(rezip(good, replace={sheet: ent}), "e.xlsx") == (422, "xml_unsafe")
    # macro-enabled renamed
    assert reason(rezip(good, add={"xl/vbaProject.bin": b"MZ"}), "m.xlsx") == (422, "macros")
    ct = zipfile.ZipFile(io.BytesIO(good)).read("[Content_Types].xml").replace(
        b"spreadsheetml.sheet.main+xml", b"ms-excel.sheet.macroEnabled.main+xml")
    assert reason(rezip(good, replace={"[Content_Types].xml": ct}), "m2.xlsx")[0] == 422
    # external links / embeddings
    assert reason(rezip(good, add={"xl/externalLinks/externalLink1.xml": b"<x/>"}), "x.xlsx") == (422, "external_links")
    assert reason(rezip(good, add={"xl/embeddings/o.bin": b"x"}), "x.xlsx") == (422, "embedded_objects")
    rel = b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="h" Target="http://evil/" TargetMode="External"/></Relationships>'
    assert reason(rezip(good, add={"xl/worksheets/_rels/sheet1.xml.rels": rel}), "x.xlsx")[0] == 422
    # type confusion
    assert reason(b"\x00\x01\x02\xff" * 100, "b.csv") == (422, "not_csv")
    assert reason(good, "x.csv") == (422, "not_csv")
    assert reason(b"Account name\nA\n", "x.xlsx") == (422, "not_xlsx")
    assert reason(good, "x.xls")[0] == 422 and reason(good, "x.xlsm") == (422, "unsupported_type")
    assert reason(good, "x.txt") == (422, "unsupported_type")
    assert reason(b"", "e.csv")[0] == 422 and reason(b"", "e.xlsx")[0] == 422
    assert reason(good[: len(good) // 2], "trunc.xlsx")[0] == 422
    # encrypted-looking (OLE container) named xlsx
    assert reason(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 600, "ole.xlsx")[0] == 422
    # wrong sheet / duplicate header / missing header
    assert reason(xlsx([("A",)], sheet="Other"), "s.xlsx") == (422, "sheet_missing")
    assert reason(xlsx([("A",)], headers=["Account name", "BPID", "BPID"]), "s.xlsx") == (422, "header_duplicate")
    assert reason(xlsx([("A",)], headers=["Name", "BPID"]), "s.xlsx") == (422, "header_missing")
    # huge cell
    import os
    rnd = lambda n: os.urandom(n // 2).hex()
    r = api.up(xlsx([(rnd(200000), rnd(5000), rnd(600), None, None, rnd(30000))]))
    assert r.status_code == 200 and r.json()["item"]["rows"][0]["state"] == "invalid", r.text[:300]
    assert len(r.text) < 20000, len(r.text)
    assert api.counts() == n0


def test_csv_variants_and_injection(api):
    inj = "=cmd|' /C calc'!A0"
    cases = {
        "utf8": csv_bytes('Account name,BPID,Notes\n"Csv Alpha Co",1,"line1\nline2"\n'),
        "bom": b"\xef\xbb\xbf" + csv_bytes("Account name;BPID;Notes\nCsv Beta Co;2;x\n"),
        "semi": csv_bytes("Account name;BPID;Notes\nCsv Gamma Co;3;x\n"),
        "cp1252": "Account name,BPID,Notes\nCsv Dëlta Café Co,4,x\n".encode("cp1252"),
        "tab": csv_bytes("Account name\tBPID\tNotes\nCsv Epsilon Co\t5\tx\n"),
        "pipe": csv_bytes("Account name|BPID|Notes\nCsv Zeta Co|6|x\n"),
        "utf16": "Account name,BPID,Notes\nCsv Eta Co,7,x\n".encode("utf-16"),
    }
    for k, d in cases.items():
        r = api.up(d, f"{k}.csv")
        assert r.status_code == 200, (k, r.text)
        it = r.json()["item"]
        assert it["file"]["format"] == "csv" and it["counts"]["new"] == 1, (k, it["file"], it["counts"])
        assert it["file"]["encoding"] and it["file"]["delimiter"] and it["file"]["notes"], k
    r = api.up(cases["cp1252"], "c.csv").json()["item"]
    assert r["rows"][0]["values"]["name"] == "Csv Dëlta Café Co" and r["file"]["encoding"] == "Windows-1252"
    assert api.up(cases["semi"], "c.csv").json()["item"]["file"]["delimiter"] == "semicolon"
    assert api.up(cases["utf8"], "c.csv").json()["item"]["rows"][0]["values"]["notes"] == "line1\nline2"
    # injection: stored as text, exported with quote prefix
    d = csv_bytes(f'Account name,BPID,Products,Status,Next contact date,Notes\n"{inj}",=1+1,+SUM(1),,,"@HYPERLINK(""http://e"")"\n'
                  f'Bad Status Inj Co,,,{inj},,\n')
    imp = api.ins(d, "inj.csv")
    assert imp["rows"][0]["values"]["name"] == inj and imp["rows"][1]["state"] == "invalid"
    assert imp["rows"][0]["state"] == "needs_review"  # QA-E4 note: cmd/Commodities abbreviation flag (spec-literal)
    res = api.apply(imp, [{"row": 2, "choice": "different"}]).json()["item"]
    assert api.client(inj)[1] == inj
    sk = api.c.get(res["skipped_url"])
    assert sk.status_code == 200 and res["skipped_url"].endswith(".csv")
    txt = sk.content.decode("utf-8-sig")
    assert all(not ln.startswith(("=", "+", "@")) for ln in txt.splitlines()[1:])
    assert "'" + inj in txt
    # re-import of the skipped file works (extra columns ignored with warning)
    imp2 = api.ins(sk.content, "skipped.csv")
    assert any(w["code"] == "unknown_column" for w in imp2["warnings"])
    # xlsx formula-looking text stored as text
    imp = api.ins(xlsx([("=1+1 Text Co", None, "+x", None, None, "-y")]))
    assert imp["rows"][0]["state"] == "new" and imp["rows"][0]["values"]["products"] == "+x"


# ------------------------------------------------------------------ golden spot checks over the live API
@pytest.mark.parametrize("new,existing,exp_strength,exp_codes", [
    ("Halvorsen Fjord Asset Mgmt", "Halvorsen Fjord Asset Management", "High", {"same_words_spelled_differently", "abbreviation"}),
    ("Norrland Fund", "Norrland Sovereign Fund", "Medium", {"contained_name"}),
    ("Société Générale", "Societe Generale", "High", {"same_core_name"}),
    ("Smith & Sons Ltd.", "Smith and Sons Limited", "High", {"same_core_name"}),
    ("Meridian Re", "Meridian Reinsurance", "Low", {"shared_key_words"}),
    ("Fund 1", "Fund 2", None, None),
    ("Capital Trust", "Fund Trust", None, None),
])
def test_golden_live(api, new, existing, exp_strength, exp_codes):
    api.c.post("/api/client/save", json={"name": existing, "duplicates_confirmed": True})
    it = api.c.post("/api/client/check-similar", json={"name": new}).json()["item"]
    cs = [c for c in it["candidates"] if c["name"] == existing]
    if exp_strength is None:
        assert not cs
    else:
        assert cs and cs[0]["strength"] == exp_strength and {r["code"] for r in cs[0]["reasons"]} == exp_codes, cs


# ------------------------------------------------------------------ headers, other routes, regressions
def test_security_headers_and_smoke(api):
    for path in ("/api/health", "/api/import/accounts/template", "/", "/api/state"):
        r = api.c.get(path)
        h = {k.lower() for k in r.headers}
        assert "content-security-policy" in h and "x-frame-options" in h and r.headers.get("x-content-type-options") == "nosniff", path
    r = api.c.post("/api/import/accounts/inspect", content=b"x", headers={"Origin": "http://evil.example", "X-File-Name": "a.csv"})
    assert r.status_code in (400, 403), r.status_code
    r = api.c.get("/api/import/accounts/inspect")
    assert r.status_code == 405
    assert api.c.get("/api/import/other").status_code == 501
    assert api.c.get("/api/today").status_code == 200 and api.c.get("/api/state").status_code == 200
    st = api.c.get("/api/state").json()
    cl = st["accounts"]
    ids = [c["id"] for c in cl]
    assert len(ids) == len(set(ids))
    lower = [c["name"].casefold() for c in cl]
    assert len(lower) == len(set(lower))
    assert api.q("pragma integrity_check")[0][0] == "ok" and api.q("pragma foreign_key_check") == []
    assert api.q("select count(*) from audit_events where source='Bulk Import' and object_type!='client'")[0][0] == 0


def test_sessions_max_three(api):
    ims = [api.ins(xlsx([(f"Session Test {i} Qx",)])) for i in range(4)]
    assert api.c.get(f"/api/import/accounts/{ims[0]['import_id']}").status_code == 410
    assert api.c.get(f"/api/import/accounts/{ims[3]['import_id']}").status_code == 200
