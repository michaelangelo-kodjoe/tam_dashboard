"""BlpapiProvider against a fake blpapi module (nothing here touches a real Terminal)."""
from __future__ import annotations

import datetime as dt
import sys

import pytest

from server.bams import provider as P
from server.bams.provider import BlpapiProvider, ProviderUnavailable
from server.tests import fake_blpapi as F

T0 = dt.datetime(2026, 10, 14, 12, 0, tzinfo=dt.timezone.utc)


def mk(fake, **kw):
    return BlpapiProvider(blpapi_module=fake, probe=lambda h, p: True, **kw)


def test_good_bad_ticker_and_bad_field_do_not_fail_poll():
    def script(secs, fld):
        return [F.response(F.sec_ok("A", fld, "12.5"), F.sec_bad("BAD"), F.sec_badfield("B", fld),
                           F.sec_ok("NAN", fld, float("nan")), F.sec_ok("TXT", fld, "n/a"))]
    prov = mk(F.FakeBlpapi(script))
    out = prov.fetch(["A", "BAD", "B", "NAN", "TXT", "GONE"], T0)
    assert set(out) == {"A"} and out["A"].value == 12.5
    assert prov.last_problems["BAD"].startswith("invalid security")
    assert prov.last_problems["B"].startswith("invalid field")
    assert prov.last_problems["GONE"] == "missing from response"
    assert set(prov.last_problems) == {"BAD", "B", "NAN", "TXT", "GONE"}


def test_options_field_and_source_update_changes_only_on_new_value():
    fake = F.FakeBlpapi(F.good_script)
    prov = mk(fake, host="h", port=1234, field="LAST_PRICE")
    q1 = prov.fetch(["A"], T0)["A"]
    q2 = prov.fetch(["A"], T0 + dt.timedelta(seconds=60))["A"]
    assert (fake.sessions[0].opts.host, fake.sessions[0].opts.port) == ("h", 1234)
    assert fake.requests[0][1] == "LAST_PRICE" and len(fake.sessions) == 1   # session reused
    assert q2.source_update == q1.source_update == T0


def test_batches_split_and_partial_responses():
    def script(secs, fld):
        half = len(secs) // 2
        return [F.response(*[F.sec_ok(s, fld, 1) for s in secs[:half]], partial=True),
                F.response(*[F.sec_ok(s, fld, 1) for s in secs[half:]])]
    fake = F.FakeBlpapi(script)
    prov = mk(fake, batch_size=3)
    tk = [f"T{i}" for i in range(7)]
    assert set(prov.fetch(tk, T0)) == set(tk)
    assert [len(r[0]) for r in fake.requests] == [3, 3, 1]
    assert BlpapiProvider.BATCH_SIZE == 500


def test_session_start_failure_then_reconnect_next_poll():
    fake = F.FakeBlpapi(F.good_script, start_ok=False)
    prov = mk(fake)
    with pytest.raises(ProviderUnavailable, match="failed to start"):
        prov.fetch(["A"], T0)
    assert fake.sessions[0].stopped
    fake.start_ok = True
    assert "A" in prov.fetch(["A"], T0)
    assert len(fake.sessions) == 2


def test_service_open_failure():
    prov = mk(F.FakeBlpapi(F.good_script, open_ok=False))
    with pytest.raises(ProviderUnavailable, match="refdata"):
        prov.fetch(["A"], T0)


def test_terminated_mid_run_discards_session_and_reconnects():
    state = {"n": 0}

    def script(secs, fld):
        state["n"] += 1
        if state["n"] == 1:
            return [F.Event(F.Event.SESSION_STATUS, [F.Msg("SessionTerminated")])]
        return F.good_script(secs, fld)
    fake = F.FakeBlpapi(script)
    prov = mk(fake)
    with pytest.raises(ProviderUnavailable, match="SessionTerminated"):
        prov.fetch(["A"], T0)
    assert fake.sessions[0].stopped
    assert "A" in prov.fetch(["A"], T0)
    assert len(fake.sessions) == 2


def test_response_error_and_unexpected_exception_become_unavailable():
    err = F.Msg("ReferenceDataResponse", {"responseError": F.El({"category": F.S("NO_AUTH"), "message": F.S("x")})})
    prov = mk(F.FakeBlpapi(lambda s, f: [F.Event(F.Event.RESPONSE, [err])]))
    with pytest.raises(ProviderUnavailable, match="NO_AUTH"):
        prov.fetch(["A"], T0)

    def boom(s, f):
        raise ValueError("secret-ish")
    prov = mk(F.FakeBlpapi(boom))
    with pytest.raises(ProviderUnavailable) as ei:
        prov.fetch(["A"], T0)
    assert "secret-ish" not in str(ei.value)


def test_hung_terminal_times_out(monkeypatch):
    prov = mk(F.FakeBlpapi(lambda s, f: []))
    monkeypatch.setattr(BlpapiProvider, "REQUEST_TIMEOUT_S", 0.05)
    with pytest.raises(ProviderUnavailable, match="timed out"):
        prov.fetch(["A"], T0)


def test_not_installed(monkeypatch):
    monkeypatch.setitem(sys.modules, "blpapi", None)          # makes `import blpapi` raise ImportError
    prov = BlpapiProvider()
    ok, msg = prov.availability()
    assert not ok and "not installed" in msg
    with pytest.raises(ProviderUnavailable, match="not installed"):
        prov.fetch(["A"], T0)
    assert prov.environment()["installed"] is False


def test_availability_and_environment_with_fake():
    fake = F.FakeBlpapi(F.good_script)
    up = BlpapiProvider(blpapi_module=fake, probe=lambda h, p: True)
    assert up.availability() == (True, None)
    env = up.environment()
    assert env["installed"] and env["version"] == "9.9.9" and env["terminal_reachable"] is True
    down = BlpapiProvider(blpapi_module=fake, probe=lambda h, p: False)
    ok, msg = down.availability()
    assert not ok and "not reachable" in msg and "8194" in msg
    assert fake.sessions == []                                  # availability never opens a session


def test_prod_never_simulated():
    prov = P.select_provider("PROD")
    assert isinstance(prov, BlpapiProvider) and prov.simulated is False
    with pytest.raises(RuntimeError):
        P.SimulatedProvider("PROD")
    assert not hasattr(prov, "value_at")
