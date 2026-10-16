"""BodyLimit: the 413 must reach a client that is still sending (no early close / connection reset)."""
from __future__ import annotations

import socket
import threading
import time

import pytest

uvicorn = pytest.importorskip("uvicorn")
from fastapi import FastAPI  # noqa: E402

from server.app import BodyLimit  # noqa: E402

CAP = 2 * 1024 * 1024


@pytest.fixture(scope="module")
def port():
    app = FastAPI()

    @app.post("/x")
    async def x() -> dict:
        return {"ok": True}
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    srv = uvicorn.Server(uvicorn.Config(BodyLimit(app, CAP), host="127.0.0.1", port=p, log_level="error"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", p), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield p
    srv.should_exit = True
    t.join(timeout=5)


def _post(port, total, chunked=False):
    c = socket.create_connection(("127.0.0.1", port), timeout=10)
    if chunked:
        head = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
    else:
        head = f"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {total}\r\n\r\n".encode()
    c.sendall(head)
    chunk, sent, broken = b"x" * 65536, 0, False
    try:
        while sent < total:
            c.sendall(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" if chunked else chunk)
            sent += len(chunk)
        if chunked:
            c.sendall(b"0\r\n\r\n")
    except OSError:
        broken = True
    data = b""
    try:
        while b"\r\n\r\n" not in data:
            d = c.recv(65536)
            if not d:
                break
            data += d
    except OSError:
        pass
    c.close()
    return data, broken


@pytest.mark.parametrize("chunked", [False, True])
def test_413_reaches_a_client_that_keeps_sending(port, chunked):
    for _ in range(25):
        data, broken = _post(port, 20 * 1024 * 1024, chunked)
        assert data.startswith(b"HTTP/1.1 413"), data[:60]
        assert broken is False, "the server closed the connection while the client was still sending"
        assert b"payload_too_large" in data or b"content-length" in data.lower()


def test_header_only_rejection_is_still_prompt_and_under_cap_passes(port):
    t0 = time.monotonic()
    c = socket.create_connection(("127.0.0.1", port), timeout=10)
    c.sendall(b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 999999999\r\n\r\n")
    data = c.recv(65536)
    c.close()
    assert data.startswith(b"HTTP/1.1 413") and time.monotonic() - t0 < 4
    data, broken = _post(port, CAP - 70000)
    assert data.startswith(b"HTTP/1.1 200") and not broken
