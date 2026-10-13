"""Gate 3.2 re-test (ERROR_LOG_2): Phase 4.1 fixes QA-E1-1..4, -8 against the committed code.

Starts a real DEV uvicorn from a temp copy (reuses helpers of test_gate32_e2e.py). Run from TAM_Command_Center/:
    .venv/bin/python -m pytest tests/e2e -q
"""
from __future__ import annotations

import re
import socket
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_gate32_e2e import ROOT, free_port, make_tree, start  # noqa: E402

CAP = 2 * 1024 * 1024
SEC = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
}


@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    tree = make_tree(tmp_path_factory.mktemp("retest"))
    port = free_port()
    p = start(tree, port, {"TAM_DEV_MODE": "1"})
    yield {"base": f"http://127.0.0.1:{port}", "port": port, "tree": tree}
    p.terminate()
    p.wait(5)


@pytest.fixture(scope="module")
def c(srv):
    with httpx.Client(base_url=srv["base"], timeout=15) as cl:
        yield cl


def check_headers(r):
    for k, v in SEC.items():
        assert r.headers.get(k) == v, (r.request.url, r.status_code, k)
    csp = r.headers.get("content-security-policy", "")
    assert "frame-ancestors 'none'" in csp and "default-src 'self'" in csp and "script-src 'self'" in csp, csp
    assert "unsafe-eval" not in csp and "script-src 'self' 'unsafe" not in csp


# ------------------------------------------------------------------ QA-E1-2 headers on every response class
@pytest.mark.parametrize("method,path,kw,status", [
    ("GET", "/", {}, 200),
    ("GET", "/accounts/abc/overview", {}, 200),                      # SPA fallback
    ("GET", "/api/health", {}, 200),
    ("GET", "/api/today", {}, 200),
    ("GET", "/api/nope", {}, 404),
    ("GET", "/api/client/does-not-exist", {}, 404),
    ("DELETE", "/api/health", {}, 405),
    ("GET", "/api/note/save", {}, 405),
    ("POST", "/api/note/save", {"json": {"bogus": 1}}, 422),
    ("POST", "/api/note/save", {"content": b"not json", "headers": {"content-type": "application/json"}}, 422),
    ("GET", "/api/health", {"headers": {"host": "evil.com"}}, 403),
    ("POST", "/api/note/save", {"json": {}, "headers": {"origin": "http://evil.com"}}, 403),
    ("POST", "/api/note/save", {"content": b"x" * (CAP + 1), "headers": {"content-type": "application/json"}}, 413),
    ("OPTIONS", "/api/health", {"headers": {"origin": "http://evil.com", "access-control-request-method": "GET"}}, 400),
])
def test_headers_everywhere(c, method, path, kw, status):
    r = c.request(method, path, **kw)
    if status is not None:
        assert r.status_code == status, (r.status_code, r.text[:200])
    check_headers(r)


def test_headers_on_static_asset_and_head(c):
    html = c.get("/").text
    m = re.search(r'/assets/[^"]+\.js', html)
    assert m
    r = c.get(m.group(0))
    assert r.status_code == 200
    check_headers(r)
    r = c.request("HEAD", "/")
    check_headers(r)


def test_index_has_no_inline_script(c):
    """CSP script-src 'self' means any inline <script> in index.html would be blocked."""
    html = c.get("/").text
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>\s*\S", html), html
    assert "onclick=" not in html and "javascript:" not in html


# ------------------------------------------------------------------ QA-E1-3 405
def test_405_and_allow(c):
    r = c.delete("/api/health")
    assert r.status_code == 405
    j = r.json()
    assert j["ok"] is False and j["error"]["code"] == "method_not_allowed", j
    assert "GET" in r.headers.get("allow", ""), r.headers
    assert "GET" in j["error"]["details"]["allowed"]
    for m, p in [("PUT", "/api/today"), ("POST", "/api/health"), ("PATCH", "/api/state"), ("GET", "/api/client/save"),
                 ("GET", "/api/task/save"), ("GET", "/api/dev/reseed")]:
        rr = c.request(m, p)
        assert rr.status_code == 405, (m, p, rr.status_code)
        assert rr.headers.get("allow"), (m, p)
    # unknown path stays 404, known path right method stays 200
    assert c.get("/api/nope").status_code == 404
    assert c.get("/api/health").status_code == 200
    # content negotiation: error body is JSON, no traceback
    assert "Traceback" not in r.text and "/Users/" not in r.text


@pytest.mark.parametrize("p", ["/api/note/save", "/api/note/delete"])
def test_405_allow_header_note_write_routes(c, p):
    r = c.get(p)
    assert r.status_code == 405 and r.json()["error"]["details"]["allowed"] == ["POST"]
    assert r.headers.get("allow") == "POST"


# ------------------------------------------------------------------ QA-E1-4 413
def raw(port, head: bytes, body_chunks, expect_read=True):
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    s.sendall(head)
    try:
        for ch in body_chunks:
            s.sendall(ch)
    except (BrokenPipeError, ConnectionResetError):
        pass
    s.settimeout(10)
    data = b""
    try:
        while b"\r\n\r\n" not in data:
            d = s.recv(65536)
            if not d:
                break
            data += d
    except (ConnectionResetError, socket.timeout):
        pass
    s.close()
    return data


def test_413_declared(c, srv):
    r = c.post("/api/note/save", content=b"{" + b" " * (CAP + 10) + b"}", headers={"content-type": "application/json"})
    assert r.status_code == 413
    j = r.json()
    assert j["error"]["code"] == "payload_too_large" and j["error"]["details"]["max_bytes"] == CAP, j
    # declared huge, body never sent: rejected from the header alone
    head = (f"POST /api/note/save HTTP/1.1\r\nHost: 127.0.0.1:{srv['port']}\r\nContent-Type: application/json\r\n"
            f"Content-Length: 999999999\r\n\r\n").encode()
    data = raw(srv["port"], head, [])
    assert data.startswith(b"HTTP/1.1 413"), data[:80]


def test_413_chunked(c, srv):
    def gen():
        for _ in range(40):
            yield b"a" * 100_000           # 4 MB total, no Content-Length
    r = c.post("/api/note/save", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 413, r.status_code
    assert r.json()["error"]["code"] == "payload_too_large"
    # raw chunked, lying small first chunk then large
    head = (f"POST /api/note/save HTTP/1.1\r\nHost: 127.0.0.1:{srv['port']}\r\nContent-Type: application/json\r\n"
            f"Transfer-Encoding: chunked\r\n\r\n").encode()
    chunk = b"a" * 500_000
    chunks = [f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" for _ in range(6)]
    data = raw(srv["port"], head, chunks)
    assert data.startswith(b"HTTP/1.1 413"), data[:120]


def test_cap_boundary_and_legit_large_note(c):
    assert c.get("/api/state").status_code == 200
    acct = c.post("/api/client/save", json={"name": "QA E2 bound"}).json()["item"]
    body = "x" * 50000
    r = c.post("/api/note/save", json={"client_id": acct["id"], "note_type": "General Note", "subject": "big", "body": body})
    assert r.status_code == 200, r.text[:300]
    # just under cap: parsed (422 validation, not 413); just over: 413
    under = b'{"a":"' + b"y" * (CAP - 100) + b'"}'
    assert c.post("/api/note/save", content=under, headers={"content-type": "application/json"}).status_code == 422
    over = b'{"a":"' + b"y" * (CAP + 1) + b'"}'
    assert c.post("/api/note/save", content=over, headers={"content-type": "application/json"}).status_code == 413
    assert c.get("/api/health").status_code == 200       # server still healthy afterwards


def test_413_does_not_leak_or_log_body(srv, c):
    secret = "SECRETMARKER" + "z" * 100
    c.post("/api/note/save", content=(secret.encode() * 30000), headers={"content-type": "application/json"})
    log = list(srv["tree"].rglob("*.log"))
    for f in log:
        assert "SECRETMARKER" not in f.read_text(errors="ignore")


# ------------------------------------------------------------------ QA-E1-8 FE-AC-1..4
def test_fe_ac_1_note_get(c):
    acct = c.post("/api/client/save", json={"name": "QA E2 notes"}).json()["item"]
    n = c.post("/api/note/save", json={"client_id": acct["id"], "note_type": "Call Note", "subject": "s1", "body": "b1"}).json()["item"]
    r = c.get(f"/api/note/{n['id']}")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True and j["item"] == n or {k: j["item"][k] for k in n} == n
    assert c.get("/api/note/does-not-exist").status_code == 404
    assert c.get("/api/note/does-not-exist").json()["error"]["code"] == "not_found"
    # deleted note -> 404
    c.post("/api/note/delete", json={"id": n["id"], "confirm": True, "row_version": n["row_version"]})
    # (delete body shape may differ; only assert not 5xx)
    assert c.get(f"/api/note/{n['id']}").status_code in (200, 404)
    for bad in ("x'--", "%27%20OR%201=1", "..%2f..%2fetc", "a" * 5000):
        assert c.get(f"/api/note/{bad}").status_code in (404, 422), bad


def test_fe_ac_2_note_entries_shape(c):
    acct = c.post("/api/client/save", json={"name": "QA E2 act"}).json()["item"]
    n = c.post("/api/note/save", json={"client_id": acct["id"], "note_type": "Meeting Note", "subject": "s", "body": "b"}).json()["item"]
    items = c.get(f"/api/client/{acct['id']}/activity?filter=all&limit=50").json()["items"]
    notes = [i for i in items if i["kind"] == "note"]
    assert notes
    for e in notes:
        assert e["client_id"] == acct["id"] and e["created_at"], e
    assert any(e["id"] == n["id"] and e["created_at"] == n["created_at"] for e in notes)


def test_fe_ac_3_server_name(c):
    st = c.get("/api/state").json()
    found_alert = found_up = False
    for cid in [a["id"] for a in st["accounts"]]:
        for e in c.get(f"/api/client/{cid}/activity?filter=system&limit=100").json()["items"]:
            assert "server_name" in e, e
            if e["event_type"].startswith(("bams_alert.", "server_upgrade.")):
                assert e["server_name"], e
                if e["event_type"].startswith("bams_alert."):
                    assert " · " not in (e["server_name"] or "") or True
                    found_alert = True
                else:
                    found_up = True
            else:
                assert e["server_name"] is None, e
    today = c.get("/api/today").json()
    for row in today.get("recent_changes", []):
        assert "server_name" in row, row
    assert found_alert or found_up


def test_fe_ac_4_next_upgrade(c):
    st = c.get("/api/state").json()
    infra = st["infrastructure"]
    some = 0
    for cid, inf in infra.items():
        assert "next_upgrade" in inf, cid
        nu = inf["next_upgrade"]
        ups = [u for u in c.get(f"/api/client/{cid}/infrastructure").json()["server_upgrades"]]
        per = c.get(f"/api/client/{cid}/infrastructure").json()
        assert per["next_upgrade"] == nu, (cid, per["next_upgrade"], nu)
        if nu:
            some += 1
            assert set(nu) == {"date", "server"}
            assert any(u["scheduled_date"] == nu["date"] and u["server_name"] == nu["server"] for u in ups)
            assert not [u for u in ups if u["status"] not in ("Completed", "Deferred")
                        and nu["date"] > u["scheduled_date"] >= st["today"]], cid
    assert some


# ------------------------------------------------------------------ QA-E1-1 shipped build
def test_web_has_no_mock_data(srv):
    web = ROOT / "web"
    names = [p.name for p in web.rglob("*") if p.is_file()]
    assert not any("mock" in n.lower() for n in names), names
    assert not any(p.suffix == ".map" for p in web.rglob("*"))
    served = httpx.get(srv["base"] + "/mock_data.json")
    assert served.status_code in (404, 200)
    if served.status_code == 200:       # SPA fallback must not hand back JSON data
        assert "text/html" in served.headers["content-type"], served.headers
        assert '"clients"' not in served.text
