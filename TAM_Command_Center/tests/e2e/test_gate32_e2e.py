"""Gate 3.2 end-to-end checks (spec section 52, in-scope scenarios) + security probes.

Self-contained: copies server/ db/ web/ VERSION.txt into a pytest temp dir (so no repo path or real data is
touched), starts real uvicorn processes (DEV on a free port; PROD-channel copy on another), drives them over HTTP.
Run from TAM_Command_Center/:  .venv/bin/python -m pytest tests/e2e -q
"""
from __future__ import annotations

import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_tree(dst: Path, channel: str = "dev") -> Path:
    dst.mkdir(parents=True, exist_ok=True)
    for d in ("server", "db", "web"):
        shutil.copytree(ROOT / d, dst / d, ignore=shutil.ignore_patterns("__pycache__", "tests", ".pytest_cache"))
    (dst / "VERSION.txt").write_text(f"version=0.1.0-{channel}\nchannel={channel}\n")
    return dst


def start(tree: Path, port: int, env_extra: dict) -> subprocess.Popen:
    env = {k: v for k, v in os.environ.items() if not k.startswith("TAM_")}
    env.update(env_extra)
    env["TAM_PORT"] = str(port)
    p = subprocess.Popen([sys.executable, "-m", "server"], cwd=tree, env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
    for _ in range(80):
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=0.5).status_code == 200:
                return p
        except Exception:
            time.sleep(0.15)
        if p.poll() is not None:
            break
    out = p.stdout.read() if p.poll() is not None else ""
    p.kill()
    raise RuntimeError(f"server did not start: {out}")


@pytest.fixture(scope="session")
def dev(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("dev"))
    port = free_port()
    p = start(tree, port, {"TAM_DEV_MODE": "1"})
    yield {"tree": tree, "port": port, "base": f"http://127.0.0.1:{port}", "proc": p,
           "db": tree / "dev_data" / "tam_dev.db", "backups": tree / "dev_data" / "TAM_Backups"}
    p.terminate()
    p.wait(5)


@pytest.fixture(scope="session")
def c(dev):
    with httpx.Client(base_url=dev["base"], timeout=10) as cl:
        yield cl


def post(c, path, body, **kw):
    return c.post(path, json=body, **kw)


@pytest.fixture(scope="session")
def state(c):
    return c.get("/api/state").json()


@pytest.fixture()
def acct(c):
    """A fresh account per test so tests are independent."""
    r = post(c, "/api/client/save", {"name": f"QA Acct {time.time_ns()}", "duplicates_confirmed": True})
    assert r.status_code == 200, r.text
    return r.json()["item"]


# ------------------------------------------------------------------ Today
def test_today_ordering_and_shape(c):
    d = c.get("/api/today").json()
    q = d["queue"]
    tiers = [i["tier"] for i in q]
    assert tiers == sorted(tiers) and set(tiers) <= {1, 2, 3, 4, 5, 6}
    ids = {(i["kind"], i["id"]) for i in q}
    assert not ids & {(i["kind"], i["id"]) for i in d["upcoming"]}, "queue item also in upcoming"
    assert len(ids) == len(q), "duplicate queue item"
    first_overdue = min(n for n, i in enumerate(q) if i["urgency"] == "overdue" and i["kind"] == "task")
    first_upc = min(n for n, i in enumerate(q) if i["tier"] == 6)
    assert first_overdue < first_upc, "overdue must precede normal upcoming"
    assert any(i["kind"] == "bams_alert" and i["urgency"] in ("alert", "critical") for i in q), "active alert actionable"
    assert any(i["kind"] == "server_upgrade" for i in q), "near-term upgrade in queue"
    # within tier-1 overdue tasks: oldest first? record order for evidence
    od = [i["date"] for i in q if i["tier"] == 1 and i["kind"] == "task"]
    print("tier1 task dates:", od)


def test_queue_click_through_targets_resolve(c):
    """Every queue item has the data the frontend needs to navigate, and the target account/server exists."""
    d = c.get("/api/today").json()
    st = c.get("/api/state").json()
    accts = {a["id"] for a in st["accounts"]}
    for i in d["queue"]:
        if i["kind"] == "task" and i["client_id"] is None:
            continue
        assert i["client_id"] in accts, i
        if i["kind"] in ("bams_alert", "server_upgrade"):
            assert i["server_name"], i
            infra = c.get(f"/api/client/{i['client_id']}/infrastructure").json()
            names = {o["name"] for o in infra["bams_objects"]} | {u["server_name"] for u in infra["server_upgrades"]}
            assert i["server_name"] in names, (i["server_name"], names)


# ------------------------------------------------------------------ Account workspace
def test_tasks_filter_to_account(c, state):
    a = state["accounts"][0]
    items = c.get("/api/tasks", params={"client_id": a["id"]}).json()["items"]
    assert items and all(t["client_id"] == a["id"] for t in items)
    none = c.get("/api/tasks", params={"client_id": "none"}).json()["items"]
    assert none and all(t["client_id"] is None for t in none)


def test_account_counts_match_tasks(c, state):
    for a in state["accounts"][:5]:
        open_ = c.get("/api/tasks", params={"client_id": a["id"], "status": "open"}).json()["count"]
        assert open_ == a["counts"]["open_tasks"], a["name"]


@pytest.mark.parametrize("ntype,filt,affects_last", [("Meeting Note", "meeting", True), ("Call Note", "call", True),
                                                   ("General Note", "general", False)])
def test_note_crud(c, acct, ntype, filt, affects_last):
    cid = acct["id"]
    r = post(c, "/api/note/save", {"client_id": cid, "note_type": ntype, "subject": "S1", "body": "B1"})
    assert r.status_code == 200, r.text
    n = r.json()["item"]
    assert n["source"] == "GUI" and n["note_type"] == ntype
    fx = {s["type"] for s in r.json()["side_effects"]}
    assert ("last_contact_updated" in fx) == affects_last
    acc = [a for a in c.get("/api/state").json()["accounts"] if a["id"] == cid][0]
    assert (acc["last_contact"] is not None) == affects_last
    # edit
    r = post(c, "/api/note/save", {"id": n["id"], "expected_row_version": n["row_version"], "subject": "S2"})
    assert r.status_code == 200 and r.json()["item"]["subject"] == "S2" and r.json()["item"]["body"] == "B1"
    n2 = r.json()["item"]
    # stale write
    r = post(c, "/api/note/save", {"id": n["id"], "expected_row_version": n["row_version"], "subject": "S3"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_write"
    # filter
    act = c.get(f"/api/client/{cid}/activity", params={"filter": filt}).json()
    assert [e["id"] for e in act["items"] if e["kind"] == "note"] == [n["id"]]
    assert all(e["kind"] == "note" and e["note_type"] == ntype for e in act["items"])
    # delete requires confirm
    r = post(c, "/api/note/delete", {"id": n["id"]})
    assert r.status_code in (409, 422)
    r = post(c, "/api/note/delete", {"id": n["id"], "confirm": True})
    assert r.status_code == 200 and any(s["type"] == "backup_created" for s in r.json()["side_effects"])
    sysf = c.get(f"/api/client/{cid}/activity", params={"filter": "system"}).json()["items"]
    assert any(e["sentence"].startswith(f"{ntype} deleted") for e in sysf), sysf
    assert not [e for e in c.get(f"/api/client/{cid}/activity", params={"filter": filt}).json()["items"]
                if e["kind"] == "note"]


def test_note_validation(c, acct):
    cid = acct["id"]
    assert post(c, "/api/note/save", {"client_id": cid, "note_type": "Meeting Note"}).status_code == 422
    assert post(c, "/api/note/save", {"client_id": cid, "note_type": "Bogus", "subject": "x"}).status_code == 422
    assert post(c, "/api/note/save", {"client_id": cid, "note_type": "General Note", "subject": "x", "source": "System"}
                ).status_code == 422
    assert post(c, "/api/note/save", {"client_id": "nope", "note_type": "General Note", "subject": "x"}).status_code == 422


def test_activity_filters_and_system_distinct(c, acct):
    cid = acct["id"]
    for t in ("Meeting Note", "Call Note", "General Note"):
        post(c, "/api/note/save", {"client_id": cid, "note_type": t, "subject": t})
    ct = post(c, "/api/contact/save", {"client_id": cid, "name": "Pat"}).json()["item"]
    post(c, "/api/task/save", {"task": "t", "client_id": cid})
    allv = c.get(f"/api/client/{cid}/activity", params={"filter": "all"}).json()["items"]
    kinds = {e["kind"] for e in allv}
    assert kinds == {"note", "system"}
    sysv = c.get(f"/api/client/{cid}/activity", params={"filter": "system"}).json()["items"]
    assert sysv and all(e["kind"] == "system" for e in sysv)
    assert all("subject" not in e for e in sysv)
    for f, t in (("meeting", "Meeting Note"), ("call", "Call Note"), ("general", "General Note")):
        items = c.get(f"/api/client/{cid}/activity", params={"filter": f}).json()["items"]
        assert [e["note_type"] for e in items] == [t]
    # system entries are read-only: no route edits them
    sid = sysv[0]["entry_key"]
    assert post(c, "/api/note/delete", {"id": sid.split(":")[-1], "confirm": True}).status_code == 404
    assert c.get(f"/api/client/nope/activity").status_code == 404
    # ordering newest first
    ts = [e["ts"] for e in allv]
    assert ts == sorted(ts, reverse=True)
    # pagination covers all, no dupes
    seen, cur = [], None
    while True:
        p = {"filter": "all", "limit": 2}
        if cur:
            p["before"] = cur
        pg = c.get(f"/api/client/{cid}/activity", params=p).json()
        seen += [e["entry_key"] for e in pg["items"]]
        cur = pg["next_cursor"]
        if not pg["has_more"]:
            break
    assert len(seen) == len(set(seen)) == len(allv)


def test_contact_primary(c, acct):
    cid = acct["id"]
    a = post(c, "/api/contact/save", {"client_id": cid, "name": "A", "is_primary": True}).json()["item"]
    r = post(c, "/api/contact/save", {"client_id": cid, "name": "B", "is_primary": True})
    b = r.json()["item"]
    assert any(s["type"] == "primary_cleared" and s["contact_id"] == a["id"] for s in r.json()["side_effects"])
    cts = [x for x in c.get("/api/state").json()["contacts"] if x["client_id"] == cid]
    assert [x["name"] for x in cts if x["is_primary"]] == ["B"]
    assert cts[0]["name"] == "B", "primary sorted first"
    # make primary via id
    r = post(c, "/api/contact/save", {"id": a["id"], "is_primary": True})
    assert r.status_code == 200
    cts = [x for x in c.get("/api/state").json()["contacts"] if x["client_id"] == cid]
    assert [x["name"] for x in cts if x["is_primary"]] == ["A"]
    # clear primary: zero primaries allowed
    r = post(c, "/api/contact/save", {"id": a["id"], "is_primary": False})
    assert r.status_code == 200
    assert not [x for x in c.get("/api/state").json()["contacts"] if x["client_id"] == cid and x["is_primary"]]
    # bad email, immutable client
    assert post(c, "/api/contact/save", {"client_id": cid, "name": "C", "email": "nope"}).status_code == 422
    # concurrent set-primary race: DB trigger must keep exactly one
    def mk(n): return post(c, "/api/contact/save", {"client_id": cid, "name": n}).json()["item"]
    x, y = mk("X"), mk("Y")
    ths = [threading.Thread(target=lambda i=i: post(c, "/api/contact/save", {"id": i, "is_primary": True})) for i in (x["id"], y["id"])]
    [t.start() for t in ths]; [t.join() for t in ths]
    cts = [z for z in c.get("/api/state").json()["contacts"] if z["client_id"] == cid and z["is_primary"]]
    assert len(cts) == 1


def test_infrastructure(c, state):
    a = [a for a in state["accounts"] if a["counts"]["servers"] > 0][0]
    inf = c.get(f"/api/client/{a['id']}/infrastructure").json()
    assert inf["bams_objects"] and inf["server_upgrades"] and "metrics" in inf["bams_objects"][0]
    assert "metrics" not in state["infrastructure"][a["id"]]["bams_objects"][0]
    assert c.get("/api/client/nope/infrastructure").status_code == 404


def test_d07_d08_rules(c, acct):
    cid = acct["id"]
    r = post(c, "/api/task/save", {"task": "fu", "client_id": cid, "category": "Client Follow-Up", "due": "2026-11-01",
                                   "update_next_contact": True})
    assert any(s["type"] == "next_contact_updated" for s in r.json()["side_effects"])
    r = post(c, "/api/task/save", {"task": "fu2", "client_id": cid, "category": "Client Follow-Up", "due": "2026-11-02"})
    assert not any(s["type"] == "next_contact_updated" for s in r.json()["side_effects"])


# ------------------------------------------------------------------ Safety
def test_loopback_bind(dev):
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{dev['port']}", "-sTCP:LISTEN"], capture_output=True, text=True).stdout
    assert "127.0.0.1:" in out and "*:" not in out and "0.0.0.0" not in out, out


def test_second_instance_blocked(dev):
    env = {k: v for k, v in os.environ.items() if not k.startswith("TAM_")}
    env.update(TAM_DEV_MODE="1", TAM_PORT=str(free_port()))
    r = subprocess.run([sys.executable, "-m", "server"], cwd=dev["tree"], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "Another TAM Command Center instance" in r.stderr and str(dev["proc"].pid) in r.stderr


def test_dev_build_refuses_prod_mode(dev):
    env = {k: v for k, v in os.environ.items() if not k.startswith("TAM_")}
    env["TAM_PORT"] = str(free_port())
    r = subprocess.run([sys.executable, "-m", "server"], cwd=dev["tree"], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 3 and "DEV-channel build" in r.stderr, (r.returncode, r.stderr)


@pytest.fixture(scope="session")
def prod(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("prod"), "prod")
    la = tmp_path_factory.mktemp("localappdata")
    port = free_port()
    p = start(tree, port, {"TAM_DEV_MODE": "1", "TAM_BAMS_TEST_MODE": "1", "LOCALAPPDATA": str(la)})
    yield {"base": f"http://127.0.0.1:{port}", "la": la, "tree": tree}
    p.terminate(); p.wait(5)


def test_prod_has_no_dev_routes(prod):
    with httpx.Client(base_url=prod["base"]) as pc:
        h = pc.get("/api/health").json()
        assert h["mode"] == "PROD" and "dev" not in h["db_path"].lower().split("tam_command_center")[-1]
        assert pc.post("/api/dev/reseed", json={"confirm": True}).status_code == 404
        assert pc.get("/openapi.json").status_code in (404,) or pc.get("/openapi.json").headers["content-type"].startswith("application/json") is False or "paths" not in pc.get("/openapi.json").text
        assert "paths" not in pc.get("/openapi.json").text
        assert pc.get("/docs").status_code != 200 or "swagger" not in pc.get("/docs").text.lower()
        # DEV seeding must not occur in PROD
        assert pc.get("/api/state").json()["accounts"] == []
    assert (prod["la"] / "TAM_Command_Center" / "tam_command_center.db").exists()
    assert not (prod["tree"] / "dev_data").exists()


def test_dev_has_dev_route_and_openapi(c):
    assert c.get("/openapi.json").status_code == 200


def test_backup_under_wal(c, dev):
    stop = threading.Event()
    errs = []
    def writer():
        i = 0
        while not stop.is_set():
            r = post(c, "/api/task/save", {"task": f"wal-{i}"}); i += 1
            if r.status_code != 200: errs.append(r.text)
    t = threading.Thread(target=writer); t.start()
    try:
        for _ in range(5):
            r = post(c, "/api/data/backup", {})
            assert r.status_code == 200, r.text
            name = r.json()["item"]["name"]
            f = dev["backups"] / name
            assert f.exists() and f.stat().st_size > 0
            cx = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            assert cx.execute("pragma integrity_check").fetchone()[0] == "ok"
            assert cx.execute("select count(*) from clients").fetchone()[0] > 0
            cx.close()
    finally:
        stop.set(); t.join()
    assert not errs, errs[:2]
    # the DB really is WAL
    cx = sqlite3.connect(dev["db"]); assert cx.execute("pragma journal_mode").fetchone()[0] == "wal"; cx.close()


def test_destructive_actions_create_backup(c, dev, acct):
    before = set(p.name for p in dev["backups"].iterdir())
    t = post(c, "/api/task/save", {"task": "to-del", "client_id": acct["id"]}).json()["item"]
    r = post(c, "/api/task/delete", {"id": t["id"], "confirm": True})
    assert r.status_code == 200 and r.json()["side_effects"][0]["type"] == "backup_created"
    ct = post(c, "/api/contact/save", {"client_id": acct["id"], "name": "Z"}).json()["item"]
    assert post(c, "/api/contact/delete", {"id": ct["id"], "confirm": True}).json()["side_effects"][0]["type"] == "backup_created"
    # account delete: needs matching confirm_name
    assert post(c, "/api/client/delete", {"id": acct["id"], "confirm": True}).status_code == 409
    assert post(c, "/api/client/delete", {"id": acct["id"], "confirm": True, "confirm_name": "wrong"}).status_code == 409
    r = post(c, "/api/client/delete", {"id": acct["id"], "confirm": True, "confirm_name": acct["name"]})
    assert r.status_code == 200 and r.json()["side_effects"][0]["type"] == "backup_created"
    new = set(p.name for p in dev["backups"].iterdir()) - before
    assert len(new) >= 3
    # pre-delete backup contains the account
    bk = [dev["backups"] / n for n in new if n.endswith(".db")]
    assert any(sqlite3.connect(b).execute("select count(*) from clients where id=?", (acct["id"],)).fetchone()[0] == 1 for b in bk)
    # history survives
    cx = sqlite3.connect(dev["db"])
    assert cx.execute("select count(*) from audit_events where action='deleted' or action like '%deleted'").fetchone()[0] > 0
    cx.close()


def test_reseed_makes_backup(c):
    assert post(c, "/api/dev/reseed", {}).status_code == 409
    r = post(c, "/api/dev/reseed", {"confirm": True})
    assert r.status_code == 200 and r.json()["side_effects"][0]["type"] == "backup_created"


# ------------------------------------------------------------------ Security probes
def test_host_and_origin_guards(dev):
    b = dev["base"]
    assert httpx.get(b + "/api/health", headers={"Host": "evil.com"}).status_code == 403
    assert httpx.get(b + "/api/health", headers={"Host": "127.0.0.1.evil.com"}).status_code == 403
    assert httpx.get(b + "/api/health", headers={"Host": "localhost:1"}).status_code == 200
    h = {"Origin": "http://evil.com"}
    assert httpx.post(b + "/api/task/save", json={"task": "x"}, headers=h).status_code == 403
    assert httpx.post(b + "/api/task/save", json={"task": "x"}, headers={"Origin": "null"}).status_code == 403
    assert httpx.post(b + "/api/task/save", content="{}", headers={"Origin": "http://evil.com", "Content-Type": "text/plain"}).status_code == 403
    # text/plain without Origin must not be accepted as JSON
    r = httpx.post(b + "/api/task/save", content='{"task":"x"}', headers={"Content-Type": "text/plain"})
    assert r.status_code in (415, 422), r.status_code
    # CORS: evil origin gets no ACAO; allowed vite origin does
    r = httpx.options(b + "/api/task/save", headers={"Origin": "http://evil.com", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers
    r = httpx.get(b + "/api/health", headers={"Origin": "http://127.0.0.1:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"
    assert "access-control-allow-credentials" not in r.headers


@pytest.mark.parametrize("path", ["/../server/config.py", "/%2e%2e/server/config.py", "/..%2fserver/config.py",
                                   "/assets/../../server/config.py", "/%2e%2e%2f%2e%2e%2fdb/schema.sql",
                                   "/assets/%2e%2e/%2e%2e/VERSION.txt", "//etc/passwd", "/..\\server\\config.py"])
def test_path_traversal(dev, path):
    with socket.create_connection(("127.0.0.1", dev["port"])) as s:
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
        data = b""
        while chunk := s.recv(65536):
            data += chunk
    body = data.split(b"\r\n\r\n", 1)[-1]
    assert b"def load_config" not in body and b"CREATE TABLE" not in body and b"channel=dev" not in body and b"root:" not in body, path


SQLI = ["' OR 1=1 --", "'; DROP TABLE clients; --", "\" OR \"\"=\"", "%' UNION SELECT sql,1,1 FROM sqlite_master --",
        "x' AND (SELECT count(*) FROM sqlite_master)>0 --", "\\", "%", "_"]


@pytest.mark.parametrize("payload", SQLI)
def test_sql_injection_reads(c, state, payload):
    aid = state["accounts"][0]["id"]
    for url, params in (("/api/tasks", {"q": payload}), ("/api/tasks", {"client_id": payload}),
                        ("/api/tasks", {"category": payload}), (f"/api/client/{aid}/activity", {"q": payload}),
                        (f"/api/client/{aid}/activity", {"before": payload})):
        r = c.get(url, params=params)
        assert r.status_code in (200, 400, 404, 422), (url, params, r.status_code, r.text[:200])
        assert "sqlite_master" not in r.text and "CREATE TABLE" not in r.text
    assert c.get(f"/api/client/{payload}/activity").status_code in (404, 422)
    assert c.get(f"/api/client/{payload}/infrastructure").status_code in (404, 422)
    assert c.get("/api/state").json()["accounts"], "tables intact"


def test_sql_injection_writes_and_literal_storage(c):
    p = "Robert'); DROP TABLE clients;--"
    r = post(c, "/api/client/save", {"name": p, "notes": "' OR '1'='1"})
    assert r.status_code == 200 and r.json()["item"]["name"] == p
    assert [a for a in c.get("/api/state").json()["accounts"] if a["name"] == p]
    assert post(c, "/api/task/save", {"task": "x", "client_id": "' OR 1=1 --"}).status_code == 422
    assert post(c, "/api/client/delete", {"id": r.json()["item"]["id"], "confirm": True, "confirm_name": p}).status_code == 200


def test_xss_payload_roundtrip_is_inert_json(c, acct):
    """API stores/returns raw text as JSON (never HTML). Rendering side is checked in the browser pass."""
    x = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    r = post(c, "/api/note/save", {"client_id": acct["id"], "note_type": "General Note", "subject": x, "body": x})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    assert r.headers.get("x-content-type-options") == "nosniff"


def test_input_limits_and_unknown_fields(c, acct):
    assert post(c, "/api/client/save", {"name": "a" * 201}).status_code == 422
    assert post(c, "/api/client/save", {"name": "ok", "evil": 1}).status_code == 422
    assert post(c, "/api/note/save", {"client_id": acct["id"], "note_type": "General Note", "body": "x" * 50001}).status_code == 422
    assert post(c, "/api/client/save", {"name": "tab\tname"}).status_code == 422
    assert post(c, "/api/task/save", {"task": "x", "id": "chosen-id"}).status_code in (404, 422)
    big = httpx.post(c.base_url.join("/api/note/save"), content=b"{" + b" " * 20_000_000 + b"}", headers={"Content-Type": "application/json"}, timeout=30)
    print("20MB body ->", big.status_code)


def test_stub_and_unknown_routes(c):
    assert c.get("/api/operations/x").status_code == 501
    assert c.post("/api/import/anything", content=b"x").status_code == 501
    assert c.get("/api/nope").status_code == 404
    assert c.put("/api/health").status_code in (404, 405)


def test_error_responses_do_not_leak(c):
    r = c.post("/api/task/save", content=b"{bad json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and "Traceback" not in r.text and "/Users/" not in r.text


def test_logs_contain_no_note_bodies(c, dev, acct):
    secret = f"SECRETBODY{time.time_ns()}"
    post(c, "/api/note/save", {"client_id": acct["id"], "note_type": "General Note", "subject": "s", "body": secret})
    post(c, "/api/settings/save", {"settings": {"log_level": "DEBUG"}})
    post(c, "/api/note/save", {"client_id": acct["id"], "note_type": "General Note", "subject": "s2", "body": secret + "2"})
    logs = "\n".join(c.get("/api/logs/recent", params={"limit": 1000}).json()["lines"])
    post(c, "/api/settings/save", {"settings": {"log_level": "INFO"}})
    assert secret not in logs


def test_spa_fallback_and_assets(c):
    r = c.get("/accounts/xyz/overview")
    assert r.status_code == 200 and "<div id=\"root\"" in r.text
    assert c.get("/assets/missing.js").status_code == 404
