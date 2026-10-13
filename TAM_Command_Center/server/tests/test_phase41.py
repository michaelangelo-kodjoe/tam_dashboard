"""Phase 4.1: additive API requests FE-AC-1..4 and the QA-E1-2/3/4 hardening."""
from __future__ import annotations

import uuid

from server.app import SECURITY_HEADERS
from server.constants import MAX_BODY_BYTES

from .conftest import d
from .test_today import _alert, _upgrade


def _note(api, cid, **kw):
    return api.ok("/api/note/save", {"client_id": cid, "note_type": "Meeting Note", "subject": "QBR prep", **kw})["item"]


# ------------------------------------------------------------------ FE-AC-1
def test_get_note_returns_note_shape(api):
    c = api.mk_client()
    n = _note(api, c["id"], body="hello")
    j = api.get(f"/api/note/{n['id']}").json()
    assert j["ok"] is True and j["item"] == n
    assert set(j["item"]) == {"id", "client_id", "note_type", "timestamp", "subject", "body", "action_items", "source",
                              "row_version", "created_at", "updated_at"}


def test_get_note_404_and_wrong_method(api):
    r = api.get("/api/note/ghost")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert api.get("/api/note/save").status_code == 405          # write route, not a missing note
    assert api.c.post(f"/api/note/ghost").status_code == 405


# ------------------------------------------------------------------ FE-AC-2
def test_activity_note_entries_have_client_id_and_created_at(api):
    c = api.mk_client()
    n = _note(api, c["id"])
    items = api.get(f"/api/client/{c['id']}/activity").json()["items"]
    e = next(i for i in items if i["kind"] == "note")
    assert e["client_id"] == c["id"] and e["created_at"] == n["created_at"]
    assert e["id"] == n["id"] and e["row_version"] == n["row_version"]


# ------------------------------------------------------------------ FE-AC-3
def test_system_events_carry_server_name(api):
    c = api.mk_client()
    cid = c["id"]
    eid = _alert(api, cid, name="bxa-ny-01")
    api.exec("INSERT INTO audit_events (category, client_id, object_type, object_id, object_label, action, source)"
             " VALUES ('operations', ?, 'server_upgrade', ?, 'srv-upg-9', 'created', 'GUI')", (cid, str(uuid.uuid4())))
    t = api.mk_task(cid, "x")
    api.ok("/api/task/archive", {"id": t["id"], "archived": True, "expected_row_version": t["row_version"]})
    items = api.get(f"/api/client/{cid}/activity", filter="system").json()["items"]
    by_type = {i["event_type"]: i for i in items}
    assert by_type["bams_alert.opened"]["server_name"] == "bxa-ny-01"
    assert by_type["server_upgrade.created"]["server_name"] == "srv-upg-9"
    assert by_type["task.archived"]["server_name"] is None
    assert all("server_name" in i for i in items)
    # Today recent_changes
    rc = api.get("/api/today").json()["recent_changes"]
    assert all("server_name" in r for r in rc)
    assert any(r["object_type"] == "bams_alert_event" and r["server_name"] == "bxa-ny-01" for r in rc)
    assert any(r["object_type"] == "server_upgrade" and r["server_name"] == "srv-upg-9" for r in rc)
    assert all(r["server_name"] is None for r in rc if r["object_type"] not in ("bams_alert_event", "server_upgrade"))
    assert eid


# ------------------------------------------------------------------ FE-AC-4
def test_next_upgrade_in_state_and_account_infrastructure(api):
    c, e = api.mk_client("A"), api.mk_client("B")
    _upgrade(api, c["id"], "late", d(30))
    _upgrade(api, c["id"], "soon", d(5))
    _upgrade(api, c["id"], "done", d(2), status="Completed")
    _upgrade(api, c["id"], "deferred", d(3), status="Deferred")
    _upgrade(api, c["id"], "past", d(-4))
    st = api.get("/api/state").json()
    assert st["infrastructure"][c["id"]]["next_upgrade"] == {"date": d(5), "server": "soon"}
    assert st["infrastructure"][e["id"]]["next_upgrade"] is None
    inf = api.get(f"/api/client/{c['id']}/infrastructure").json()
    assert inf["next_upgrade"] == {"date": d(5), "server": "soon"}
    # agrees with the account-summary rule
    acct = next(a for a in st["accounts"] if a["id"] == c["id"])
    assert acct["counts"]["next_upgrade"] == d(5)


# ------------------------------------------------------------------ QA-E1-2
def test_security_headers_on_api_spa_and_errors(api, tmp_path):
    web = api.rt.config.web_dir
    web.mkdir(parents=True, exist_ok=True)
    (web / "index.html").write_text("<html></html>")
    for path in ("/api/health", "/", "/accounts/x", "/api/nope", "/missing.js"):
        r = api.c.get(path)
        for k, v in SECURITY_HEADERS.items():
            assert r.headers.get(k) == v, (path, k)
    assert api.c.get("/api/health").headers["X-Frame-Options"] == "DENY"
    csp = api.c.get("/").headers["Content-Security-Policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "'unsafe-eval'" not in csp


# ------------------------------------------------------------------ QA-E1-3
def test_wrong_method_is_405_with_allow(api):
    r = api.c.delete("/api/health")
    assert r.status_code == 405 and r.json()["error"]["code"] == "method_not_allowed"
    assert "GET" in r.headers["Allow"]
    r = api.c.get("/api/task/save")
    assert r.status_code == 405 and r.headers["Allow"] == "POST"
    assert api.c.post("/api/state", json={}).status_code == 405
    assert api.c.get("/api/does/not/exist").status_code == 404
    # stubs keep answering 501 for every method
    assert api.c.delete("/api/operations").status_code == 501


def test_head_on_spa_root(api):
    web = api.rt.config.web_dir
    web.mkdir(parents=True, exist_ok=True)
    (web / "index.html").write_text("<html></html>")
    assert api.c.head("/").status_code == 200


# ------------------------------------------------------------------ QA-E1-4
def test_oversize_body_is_413(api):
    r = api.c.post("/api/note/save", content=b"x" * (MAX_BODY_BYTES + 1), headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    j = r.json()
    assert j["ok"] is False and j["error"]["code"] == "payload_too_large"
    assert j["error"]["details"]["max_bytes"] == MAX_BODY_BYTES
    assert r.headers["X-Frame-Options"] == "DENY"


def test_oversize_chunked_body_is_413_and_normal_chunked_ok(api):
    def gen(n, size=65536):
        for _ in range(n // size + 1):
            yield b"x" * size
    r = api.c.post("/api/note/save", content=gen(MAX_BODY_BYTES + 70000), headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    c = api.mk_client()
    body = (b'{"client_id": "%s", "note_type": "General Note", "body": "hi"}' % c["id"].encode())
    r = api.c.post("/api/note/save", content=iter([body[:10], body[10:]]), headers={"Content-Type": "application/json"})
    assert r.status_code == 200, r.text


def test_max_legit_note_still_accepted(api):
    c = api.mk_client()
    assert _note(api, c["id"], body="a" * 50000)["id"]
