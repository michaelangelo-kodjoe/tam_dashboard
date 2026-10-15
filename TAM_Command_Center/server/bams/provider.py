"""BAMS data providers (D-49, D-50). The provider is chosen from the app MODE only:
DEV -> SimulatedProvider, PROD -> BlpapiProvider (real read-only Desktop API poller; unavailable when blpapi/Terminal are absent).
No setting, env var or route can switch this; PROD never constructs the simulator (fail closed).
All BAMS metric values are percentages (user decision 2026-10-14); no unit is stored."""
from __future__ import annotations

import datetime as _dt
import hashlib
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


@dataclass(frozen=True)
class Quote:
    value: float
    source_update: _dt.datetime


class ProviderUnavailable(Exception):
    pass


class Provider:
    kind = "base"
    simulated = False

    def availability(self) -> Tuple[bool, Optional[str]]:
        raise NotImplementedError

    def fetch(self, tickers: Iterable[str], now: _dt.datetime) -> Dict[str, Quote]:
        """Latest quote per ticker; a ticker without a new update is simply absent."""
        raise NotImplementedError


class BlpapiProvider(Provider):
    """Read-only Bloomberg Desktop API snapshot poller (ReferenceDataRequest). blpapi is imported lazily so the app
    runs without it. Every failure becomes ProviderUnavailable (whole poll) or an absent ticker (per ticker);
    nothing else escapes. Response parsing lives in blpapi_parse.py ([U] shapes, see docs/BLPAPI_NOTES.md)."""
    kind = "blpapi"
    HOST = "localhost"
    PORT = 8194
    SERVICE = "//blp/refdata"
    FIELD = "PX_LAST"              # constant: no setting exists for it (settings routes are fixed by the contract)
    BATCH_SIZE = 500               # [U] max securities per request; lower this if the Terminal rejects big requests
    REQUEST_TIMEOUT_S = 30.0       # hard deadline for one request (all its events)
    EVENT_WAIT_MS = 1000
    PROBE_TIMEOUT_S = 1.0
    NOT_INSTALLED = "BLPAPI is not installed (python -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi)"

    def __init__(self, host: Optional[str] = None, port: Optional[int] = None, field: Optional[str] = None,
                 batch_size: Optional[int] = None, blpapi_module: Any = None, probe: Any = None) -> None:
        self.host = host or self.HOST
        self.port = int(port or self.PORT)
        self.field = field or self.FIELD
        self.batch_size = max(1, int(batch_size or self.BATCH_SIZE))
        self._injected = blpapi_module           # tests inject a fake module; production leaves this None
        self._probe = probe                      # tests may inject a reachability probe
        self._session: Any = None
        self._lock = threading.Lock()
        self._last: Dict[str, float] = {}        # ticker -> last value seen
        self._changed: Dict[str, _dt.datetime] = {}   # ticker -> when the value last changed (our source_update)
        self.last_problems: Dict[str, str] = {}  # ticker -> reason, for the latest poll (no values logged)

    # -- environment
    def _module(self) -> Any:
        if self._injected is not None:
            return self._injected
        try:
            import blpapi  # type: ignore  # lazy: absent on dev machines
            return blpapi
        except Exception:  # noqa: BLE001 - ImportError or a broken native install
            return None

    def _reachable(self) -> bool:
        if self._probe is not None:
            return bool(self._probe(self.host, self.port))
        import socket
        try:
            with socket.create_connection((self.host, self.port), timeout=self.PROBE_TIMEOUT_S):
                return True
        except OSError:
            return False

    def environment(self) -> Dict[str, Any]:
        """Installed/version/reachability facts (never raises, opens no Bloomberg session)."""
        m = self._module()
        info: Dict[str, Any] = {"installed": m is not None, "version": None, "cpp_version": None,
                                "host": self.host, "port": self.port, "terminal_reachable": None}
        if m is not None:
            for key, fn in (("version", "version"), ("cpp_version", "cpp_sdk_version")):
                try:
                    info[key] = str(getattr(m, fn)())
                except Exception:  # noqa: BLE001
                    pass
            info["terminal_reachable"] = self._reachable()
        return info

    def availability(self) -> Tuple[bool, Optional[str]]:
        try:
            if self._module() is None:
                return False, self.NOT_INSTALLED
            if not self._reachable():
                return False, (f"Bloomberg Terminal not reachable on {self.host}:{self.port}. "
                               "Start the Terminal, log in, and check the Desktop API is enabled.")
            return True, None
        except Exception:  # noqa: BLE001
            return False, "BLPAPI availability check failed"

    # -- session
    def _drop_session(self) -> None:
        s, self._session = self._session, None
        if s is not None:
            try:
                s.stop()
            except Exception:  # noqa: BLE001
                pass

    def _open(self, m: Any) -> Any:
        if self._session is not None:
            return self._session
        try:
            opts = m.SessionOptions()
            opts.setServerHost(self.host)
            opts.setServerPort(self.port)
            sess = m.Session(opts)
        except Exception as exc:  # noqa: BLE001
            raise ProviderUnavailable("Could not create a Bloomberg session (%s)" % type(exc).__name__)
        try:
            started = sess.start()
        except Exception:  # noqa: BLE001
            started = False
        if not started:
            self._stop_quiet(sess)
            raise ProviderUnavailable("Bloomberg session failed to start. Is the Terminal running and logged in?")
        try:
            opened = sess.openService(self.SERVICE)
        except Exception:  # noqa: BLE001
            opened = False
        if not opened:
            self._stop_quiet(sess)
            raise ProviderUnavailable("Bloomberg refdata service could not be opened. Is the Terminal logged in?")
        self._session = sess
        return sess

    @staticmethod
    def _stop_quiet(sess: Any) -> None:
        try:
            sess.stop()
        except Exception:  # noqa: BLE001
            pass

    def _request(self, m: Any, sess: Any, batch: List[str]) -> Dict[str, Tuple[Optional[float], Optional[str]]]:
        from . import blpapi_parse as bp
        svc = sess.getService(self.SERVICE)
        req = svc.createRequest("ReferenceDataRequest")
        for t in batch:
            req.getElement("securities").appendValue(t)
        req.getElement("fields").appendValue(self.field)
        sess.sendRequest(req)
        results: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
        deadline = time.monotonic() + self.REQUEST_TIMEOUT_S
        ET = m.Event
        while True:
            if time.monotonic() > deadline:
                raise ProviderUnavailable("Bloomberg request timed out")
            ev = sess.nextEvent(self.EVENT_WAIT_MS)
            et = ev.eventType()
            if et == ET.TIMEOUT:
                continue
            for msg in ev:
                mt = bp.message_type(msg)
                if et in (ET.SESSION_STATUS, ET.SERVICE_STATUS) and mt in bp.FATAL_SESSION_MESSAGES:
                    raise ProviderUnavailable("Bloomberg session lost (%s). Will reconnect on the next poll." % mt)
                if et in (ET.RESPONSE, ET.PARTIAL_RESPONSE):
                    err = bp.response_error(msg)
                    if err:
                        raise ProviderUnavailable("Bloomberg rejected the request: " + err)
                    results.update(bp.parse_refdata_message(msg, self.field))
                elif et == ET.REQUEST_STATUS:
                    raise ProviderUnavailable("Bloomberg request failed")
            if et == ET.RESPONSE:
                return results

    def fetch(self, tickers: Iterable[str], now: _dt.datetime) -> Dict[str, Quote]:
        tickers = list(dict.fromkeys(t for t in tickers if t))
        with self._lock:
            m = self._module()
            if m is None:
                raise ProviderUnavailable(self.NOT_INSTALLED)
            problems: Dict[str, str] = {}
            out: Dict[str, Quote] = {}
            try:
                if not tickers:
                    return out
                sess = self._open(m)
                for i in range(0, len(tickers), self.batch_size):
                    batch = tickers[i:i + self.batch_size]
                    got = self._request(m, sess, batch)
                    for t in batch:
                        v, why = got.get(t, (None, "missing from response"))
                        if v is None:
                            problems[t] = why or "no value"
                            continue
                        if self._last.get(t) != v or t not in self._changed:
                            self._last[t], self._changed[t] = v, now
                        out[t] = Quote(v, self._changed[t])
            except ProviderUnavailable:
                self._drop_session()
                raise
            except Exception as exc:  # noqa: BLE001 - never raise anything else into the monitor
                self._drop_session()
                raise ProviderUnavailable("Bloomberg poll failed (%s). Will reconnect on the next poll." % type(exc).__name__)
            finally:
                self.last_problems = problems
            return out


_OPS = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b}


def _h(*parts: object) -> int:
    return int(hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:12], 16)


class SimulatedProvider(Provider):
    kind = "simulated"
    simulated = True
    OUTAGE_TEXT = "Simulated outage (DEV)"

    def __init__(self, mode: str, seed: int = 7) -> None:
        if mode != "DEV":                      # defence in depth: refuse to exist outside DEV
            raise RuntimeError("SimulatedProvider is DEV-only")
        self.seed = seed
        self.calls = 0                         # number of fetch() calls (tests: independent of UI refresh)
        self.outage = False
        self.forced: Dict[str, float] = {}
        self.stale_tickers: Set[str] = set()
        self.stale_all = False
        self.scenario: Dict[str, float] = {}   # QA-E5-3: per-ticker values derived from non-closed alert state
        self._lock = threading.Lock()

    # -- deterministic generator (percentages, 0..100)
    def value_at(self, ticker: str, t: _dt.datetime) -> float:
        base = 20 + _h(self.seed, ticker, "b") % 50                  # 20..69
        amp = 3 + _h(self.seed, ticker, "a") % 8                     # 3..10
        phase = (_h(self.seed, ticker, "p") % 1000) / 1000.0
        hours = t.timestamp() / 3600.0
        v = base + amp * math.sin(2 * math.pi * (hours / 24.0 + phase))
        minute = int(t.timestamp() // 60)
        v += ((_h(self.seed, ticker, minute) % 1000) / 1000.0 - 0.5) * amp * 0.5
        day = int(t.timestamp() // 86400)
        if _h(self.seed, ticker, "spike", day) % 45 == 0 and 10 <= t.hour < 12:
            v += 25
        return round(min(100.0, max(0.0, v)), 1)

    def plan_value(self, ticker: str, now: _dt.datetime,
                   levels: Iterable[Tuple[Optional[float], str, bool, bool]]) -> Optional[float]:
        """QA-E5-3: pick a deterministic value that keeps seeded open alerts breaching and seeded recovered ones
        clear. `levels` = (compare level, operator, must_breach, has_event) per rule of the metric; rules that carry a
        seeded event outweigh event-less ones (an event-less lower rule may breach beneath an open higher one). Returns None when the
        natural simulated value already satisfies every rule (no override needed)."""
        rules = [(lv, op, need, ev) for lv, op, need, ev in levels if lv is not None]
        if not rules:
            return None
        minute = int(now.timestamp() // 60)
        d = 1 + (_h(self.seed, ticker, "sc", minute) % 30) / 10.0           # 1.0 .. 3.9, varies per minute
        natural = self.value_at(ticker, now)
        cands = [natural]
        for lv, _op, _need, _ev in rules:
            for c in (lv + d, lv - d, lv + 0.1, lv - 0.1):
                cands.append(round(min(100.0, max(0.0, c)), 1))

        def score(v: float) -> int:
            return sum((10 if ev else 1) for lv, op, need, ev in rules if bool(_OPS[op](v, lv)) == need)

        best = max(cands, key=score)               # max() keeps the first (natural first) among equals
        return None if best == natural else best

    def availability(self) -> Tuple[bool, Optional[str]]:
        return (False, self.OUTAGE_TEXT) if self.outage else (True, None)

    def fetch(self, tickers: Iterable[str], now: _dt.datetime) -> Dict[str, Quote]:
        with self._lock:
            self.calls += 1
            if self.outage:
                raise ProviderUnavailable(self.OUTAGE_TEXT)
            out: Dict[str, Quote] = {}
            for tk in tickers:
                if self.stale_all or tk in self.stale_tickers:
                    continue
                v = self.forced.get(tk)
                if v is None:
                    v = self.scenario.get(tk)
                out[tk] = Quote(v if v is not None else self.value_at(tk, now), now)
            return out


def select_provider(mode: str) -> Provider:
    """Mode is the ONLY input. PROD can never get the simulator."""
    if mode == "DEV":
        return SimulatedProvider(mode)
    return BlpapiProvider()
