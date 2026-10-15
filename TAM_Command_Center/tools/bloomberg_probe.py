"""Bloomberg Desktop API probe: run this ON THE WORKSTATION with the Terminal logged in.

  python tools/bloomberg_probe.py "IBM US Equity" "NOTAREAL XX Equity" --fields PX_LAST NOT_A_FIELD
  python tools/bloomberg_probe.py "EURUSD Curncy" --out probe_out.txt --host localhost --port 8194

Sends one ReferenceDataRequest, then writes the RAW session events, service events and responses to a text file
(default bloomberg_probe_output.txt). It is read-only, needs no credentials, stores none, and does not touch the
app database. Paste the output file back to answer the open questions in docs/BLPAPI_NOTES.md.
Include one deliberately bad ticker and one bad field (as above) so the error shapes are captured.
"""
from __future__ import annotations

import argparse
import datetime as dt
import socket
import sys
import time

lines: list = []


def emit(s: str = "") -> None:
    print(s)
    lines.append(s)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tickers", nargs="+", help="securities, e.g. 'IBM US Equity' (quote names with spaces)")
    ap.add_argument("--fields", nargs="+", default=["PX_LAST"])
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8194)
    ap.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for the response")
    ap.add_argument("--out", default="bloomberg_probe_output.txt")
    a = ap.parse_args()

    emit(f"probe started {dt.datetime.now().isoformat(timespec='seconds')} python {sys.version.split()[0]} {sys.platform}")
    try:
        import blpapi
    except Exception as exc:
        emit(f"blpapi import FAILED: {exc!r}")
        return _finish(a.out, 2)
    for fn in ("version", "cpp_sdk_version"):
        try:
            emit(f"blpapi.{fn}() = {getattr(blpapi, fn)()}")
        except Exception as exc:
            emit(f"blpapi.{fn}() error: {exc!r}")
    try:
        socket.create_connection((a.host, a.port), timeout=2).close()
        emit(f"TCP {a.host}:{a.port}: connected")
    except OSError as exc:
        emit(f"TCP {a.host}:{a.port}: FAILED {exc!r}")

    opts = blpapi.SessionOptions()
    opts.setServerHost(a.host)
    opts.setServerPort(a.port)
    sess = blpapi.Session(opts)
    try:
        started = sess.start()
        emit(f"session.start() -> {started}")
        if started:
            emit(f"openService('//blp/refdata') -> {sess.openService('//blp/refdata')}")
            svc = sess.getService("//blp/refdata")
            req = svc.createRequest("ReferenceDataRequest")
            for t in a.tickers:
                req.getElement("securities").appendValue(t)
            for f in a.fields:
                req.getElement("fields").appendValue(f)
            emit(f"request: securities={a.tickers} fields={a.fields}")
            sess.sendRequest(req)
        deadline = time.monotonic() + a.timeout
        while time.monotonic() < deadline:
            ev = sess.nextEvent(1000)
            et = ev.eventType()
            names = {v: k for k, v in vars(blpapi.Event).items() if k.isupper() and isinstance(v, int)}
            emit(f"--- event type {et} ({names.get(et, '?')})")
            for msg in ev:
                emit(f"message type: {msg.messageType()}")
                emit(str(msg))        # raw dump of the whole message
            if et == blpapi.Event.RESPONSE:
                break
            if et == blpapi.Event.TIMEOUT and not started:
                break
        else:
            emit("TIMED OUT waiting for a final RESPONSE")
    except Exception as exc:
        emit(f"EXCEPTION: {exc!r}")
    finally:
        try:
            sess.stop()
        except Exception:
            pass
    return _finish(a.out, 0)


def _finish(path: str, code: int) -> int:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"\nSaved to {path}. No credentials are included.")
    return code


if __name__ == "__main__":
    sys.exit(main())
