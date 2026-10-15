"""BAMS data providers (D-49, D-50). The provider is chosen from the app MODE only:
DEV -> SimulatedProvider, PROD -> BlpapiProvider (a stub that reports unavailable in this run).
No setting, env var or route can switch this; PROD never constructs the simulator (fail closed).
All BAMS metric values are percentages (user decision 2026-10-14); no unit is stored."""
from __future__ import annotations

import datetime as _dt
import hashlib
import math
import threading
from dataclasses import dataclass
from typing import Dict, Iterable, Optional, Set, Tuple


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
    """Stub: the real Bloomberg session is not implemented in this run, so it is always unavailable."""
    kind = "blpapi"
    MESSAGE = "BLPAPI provider not implemented/connected"

    def availability(self) -> Tuple[bool, Optional[str]]:
        return False, self.MESSAGE

    def fetch(self, tickers: Iterable[str], now: _dt.datetime) -> Dict[str, Quote]:
        raise ProviderUnavailable(self.MESSAGE)


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
