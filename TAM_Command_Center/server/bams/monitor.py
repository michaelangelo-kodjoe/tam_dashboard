"""BAMS monitor: the ONLY caller of the provider (D-51). UI reads never poll. Time comes from the injected clock."""
from __future__ import annotations

import datetime as _dt
import logging
import threading
import uuid
from typing import Any, Dict, List, Optional

from ..dbkit import transaction
from . import lifecycle as L
from . import repo
from .clock import Clock, fmt, parse
from .notify import Notifier, toast_text
from .provider import Provider, ProviderUnavailable

log = logging.getLogger("tam.bams")

HISTORY_DAYS = 90
PRUNE_DAYS = 100
BACKFILL_STEP_HOURS = 4
BACKFILL_MIN_DAYS = 80
BACKFILL_PER_POLL = 100


class Monitor:
    def __init__(self, rt: Any, provider: Provider, notifier: Notifier, clock: Clock, *, threaded: bool = False) -> None:
        self.rt, self.provider, self.notifier, self.clock, self.threaded = rt, provider, notifier, clock, threaded
        self.active = False
        self.started_at: Optional[_dt.datetime] = None
        self.last_poll_at: Optional[_dt.datetime] = None
        self.last_poll_ok: Optional[bool] = None
        self.last_error: Optional[str] = None
        self.poll_interval = 60
        self._poll_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------ status
    def state(self) -> str:
        if not self.provider.availability()[0]:
            return "provider_unavailable"
        return "running" if self.active else "stopped"

    def provider_info(self) -> Dict[str, Any]:
        ok, msg = self.provider.availability()
        mode = self.rt.config.mode
        return {"mode": mode, "kind": "simulated" if self.provider.simulated else self.provider.kind,
                "available": ok, "simulated": bool(self.provider.simulated), "message": msg}

    def info(self, desired: bool, interval: int) -> Dict[str, Any]:
        st = self.state()
        nxt = (self.last_poll_at + _dt.timedelta(seconds=interval)) if (st == "running" and self.last_poll_at) else None
        return {"state": st, "desired_running": desired, "poll_interval_seconds": interval,
                "started_at": fmt(self.started_at) if self.started_at else None,
                "last_poll_at": fmt(self.last_poll_at) if self.last_poll_at else None,
                "next_poll_at": fmt(nxt) if nxt else None, "last_poll_ok": self.last_poll_ok,
                "last_error": self.last_error,
                "freshness": {"live_seconds": L.live_seconds(interval), "stale_seconds_default": 120}}

    # ------------------------------------------------------------ lifecycle of the loop
    def activate(self) -> None:
        if self.active:
            return
        self.active = True
        self.started_at = self.clock.now()
        if self.threaded:
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._loop, name="bams-monitor", daemon=True)
            self._thread.start()

    def deactivate(self) -> None:
        self.active = False
        self._stop.set()
        t = self._thread
        if t is not None and t is not threading.current_thread():
            t.join(timeout=5)
        self._thread = None

    def resume(self) -> None:
        """At server start: honour the persisted Start/Stop choice (DEV default running, PROD default stopped)."""
        with self.rt.db() as conn:
            v = repo.meta_get(conn, repo.DESIRED_KEY)
        desired = (v == "1") if v is not None else (self.rt.config.mode == "DEV")
        if desired:
            self.activate()

    def shutdown(self) -> None:
        self.deactivate()

    def _loop(self) -> None:
        stop = self._stop
        while not stop.is_set():
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001 - the loop must survive anything
                log.exception("BAMS poll crashed")
            stop.wait(max(5, self.poll_interval))

    # ------------------------------------------------------------ one poll cycle
    def poll_once(self) -> Dict[str, Any]:
        with self._poll_lock:
            now = self.clock.now()
            self.last_poll_at = now
            ok, msg = self.provider.availability()
            if not ok:
                self.last_poll_ok, self.last_error = False, msg
                log.debug("BAMS poll skipped: provider unavailable")
                return {"polled": 0, "updated": 0, "available": False}
            try:
                return self._poll(now)
            except ProviderUnavailable as exc:
                self.last_poll_ok, self.last_error = False, str(exc)[:200]
                log.warning("BAMS provider unavailable during poll")
                return {"polled": 0, "updated": 0, "available": False}
            except Exception as exc:  # noqa: BLE001
                self.last_poll_ok, self.last_error = False, "Poll failed; see the log."
                log.warning("BAMS poll failed: %s", type(exc).__name__)
                log.debug("BAMS poll failure detail", exc_info=True)
                return {"polled": 0, "updated": 0, "available": True, "failed": True}

    def _poll(self, now: _dt.datetime) -> Dict[str, Any]:
        pending: List[Dict[str, Any]] = []
        updated = 0
        with self.rt.db() as conn:
            settings = repo.read_settings(conn)
            self.poll_interval = settings["poll_interval_seconds"]
            if self.provider.simulated:
                with transaction(conn):
                    backfill(conn, self.provider, now)
            metrics = repo.metric_rows(conn)
            if self.provider.simulated:
                self._plan_scenarios(conn, metrics, now)
            quotes = self.provider.fetch([m["ticker"] for m in metrics], now)
            with transaction(conn):
                for m in metrics:
                    q = quotes.get(m["ticker"])
                    if q is None:
                        continue
                    # Only a clock that did not advance is skipped (a frozen DEV mock clock, or a clock stepped back):
                    # the seeded timestamps are then in the "future" and writing older ones would break the schema's
                    # ordering checks (QA-E5-3).
                    last = max((parse(x) for x in (m["last_received"], m["last_source_update"]) if x), default=None)
                    if last is not None and now <= last:
                        continue
                    # Every successful valid observation is ingested: it refreshes last_received and reaches alert
                    # evaluation even when the value did not change (an unchanged value is not a missed poll).
                    if self._ingest(conn, m, q, now, settings, pending):
                        updated += 1
                self._daily_prune(conn, now)
            self._deliver(conn, pending, settings)
        self.last_poll_ok, self.last_error = True, None
        log.debug("BAMS poll ok: metrics=%d updated=%d", len(metrics), updated)
        return {"polled": len(metrics), "updated": updated, "available": True}

    def _plan_scenarios(self, conn: Any, metrics: List[Dict[str, Any]], now: _dt.datetime) -> None:
        """QA-E5-3 (DEV simulator only): for metrics that carry a non-closed rule event, steer the simulated value so
        open alerts keep breaching and recovered ones stay clear. The lifecycle engine is untouched."""
        active: Dict[str, Dict[str, str]] = {}
        for e in repo.active_events(conn):
            if e["rule_id"]:
                active.setdefault(e["metric_id"], {})[e["rule_id"]] = e["status"]
        plan: Dict[str, float] = {}
        for m in metrics:
            st = active.get(m["metric_id"])
            if not st:
                continue
            highs = {k: m[k] for k in ("high_30", "high_60", "high_90")}
            levels, rules = [], repo.rules_for_metric(conn, m["metric_id"], enabled_only=True)
            for r in rules:
                levels.append((L.level(r, highs), r["operator"], st.get(r["id"]) == "open", r["id"] in st))
            v = self.provider.plan_value(m["ticker"], now, levels)
            if v is not None:
                plan[m["ticker"]] = v
            else:
                v = self.provider.value_at(m["ticker"], now)
            # A lower sibling rule with no event would open the moment a higher rule's seeded alert keeps breaching.
            # Treat it as already acknowledged (suppress until clear) - ordinary lifecycle state, engine unchanged.
            with transaction(conn):
                for r in rules:
                    if r["id"] not in st and not r["suppress_until_clear"] and L.breaches(r, v, highs):
                        conn.execute("UPDATE bams_alert_rules SET suppress_until_clear = 1 WHERE id = :i", {"i": r["id"]})
        self.provider.scenario = plan

    # ------------------------------------------------------------ ingest one new quote
    def _ingest(self, conn: Any, m: Dict[str, Any], q: Any, now: _dt.datetime, settings: Dict[str, Any],
                pending: List[Dict[str, Any]]) -> bool:
        """One successful valid observation. -> True when the VALUE changed.

        `last_received` (communication freshness: Live/Delayed/Stale) = now on every observation.
        `last_source_update` (value-change time) and the change-history sample advance only when the value changed.
        Alert evaluation runs on every observation so consecutive-observation rules count unchanged values."""
        value = float(q.value)
        now_s = fmt(now)
        highs = {k: m[k] for k in ("high_30", "high_60", "high_90")}
        prev = m["current_value"]
        changed_value = prev is None or m["last_source_update"] is None or value != float(prev)
        if changed_value:
            conn.execute("UPDATE bams_metrics SET current_value = :v, last_source_update = :s, last_received = :r WHERE id = :i",
                         {"v": value, "s": fmt(q.source_update or now), "r": now_s, "i": m["metric_id"]})
            repo.insert_samples(conn, [{"metric_id": m["metric_id"], "sampled_at": now_s,
                                        "source_update": fmt(q.source_update or now), "value": value}])
        else:
            conn.execute("UPDATE bams_metrics SET last_received = :r WHERE id = :i", {"r": now_s, "i": m["metric_id"]})
        for rule in repo.rules_for_metric(conn, m["metric_id"], enabled_only=True):
            self._evaluate(conn, m, rule, value, highs, now, settings, pending)
        # highs are updated AFTER evaluation so "exceeds high" compares with the prior high
        day = now_s[:10]
        new = dict(m)
        changed = False
        for k in ("30", "60", "90"):
            cur = m["high_" + k]
            if cur is None or value > cur:
                new["high_" + k], new["high_%s_date" % k] = value, day
                changed = True
        if changed:
            repo.set_highs(conn, m["metric_id"], new)
        return changed_value

    def _evaluate(self, conn: Any, m: Dict[str, Any], rule: Dict[str, Any], value: float, highs: Dict[str, Any],
                  now: _dt.datetime, settings: Dict[str, Any], pending: List[Dict[str, Any]]) -> None:
        active = repo.active_event_for(conn, m["metric_id"], rule["id"])
        lc = repo.last_closed_at(conn, m["metric_id"], rule["id"])
        d = L.step(rule, value, highs, active, parse(lc) if lc else None, now)
        if d.breach_count != rule["breach_count"] or d.suppress != bool(rule["suppress_until_clear"]):
            conn.execute("UPDATE bams_alert_rules SET breach_count = :c, suppress_until_clear = :s WHERE id = :i",
                         {"c": d.breach_count, "s": 1 if d.suppress else 0, "i": rule["id"]})
        now_s = fmt(now)
        low_is_bad = rule["operator"] in ("<", "<=")
        if d.action == "open":
            eid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO bams_alert_events (id, metric_id, rule_id, alert_type, severity, message, opened_at,"
                " last_triggered_at, status, current_value, trigger_value, peak_value, created_at, updated_at)"
                " VALUES (:id, :m, :r, :t, :sev, :msg, :now, :now, 'open', :v, :v, :v, :now, :now)",
                {"id": eid, "m": m["metric_id"], "r": rule["id"], "t": rule["rule_type"], "sev": rule["severity"],
                 "msg": L.event_message(rule, m["metric_name"]), "now": now_s, "v": value})
            self._record(conn, eid, "opened", rule["severity"], m, value, now_s, settings, pending)
        elif d.action == "retrigger" and active is not None:
            peak = active["peak_value"]
            peak = value if peak is None else (min(peak, value) if low_is_bad else max(peak, value))
            conn.execute("UPDATE bams_alert_events SET last_triggered_at = :now, current_value = :v, peak_value = :p,"
                         " status = 'open', recovered_at = NULL, updated_at = :now WHERE id = :i",
                         {"now": now_s, "v": value, "p": peak, "i": active["id"]})
        elif d.action == "recover" and active is not None:
            conn.execute("UPDATE bams_alert_events SET status = 'recovered', recovered_at = :now, current_value = :v,"
                         " updated_at = :now WHERE id = :i", {"now": now_s, "v": value, "i": active["id"]})
            self._record(conn, active["id"], "recovered", active["severity"], m, value, now_s, settings, pending)
        elif active is not None and active["current_value"] != value:
            conn.execute("UPDATE bams_alert_events SET current_value = :v, updated_at = :now WHERE id = :i",
                         {"v": value, "now": now_s, "i": active["id"]})

    def _record(self, conn: Any, event_id: str, kind: str, severity: str, m: Dict[str, Any], value: Optional[float],
                now_s: str, settings: Dict[str, Any], pending: List[Dict[str, Any]]) -> None:
        record_in_app(conn, event_id, kind, now_s, settings)
        if kind in ("opened", "recovered"):
            pending.append({"event_id": event_id, "kind": kind, "severity": severity, "metric": m["metric_name"],
                            "where": f"{m['client_name']} / {m['object_name']}", "value": value})

    def _deliver(self, conn: Any, pending: List[Dict[str, Any]], settings: Dict[str, Any]) -> None:
        """Desktop toasts after the data transaction. Never raises; once per event/kind/channel."""
        if not settings["desktop_notifications"]:
            return
        for p in pending:
            if p["kind"] == "recovered" and not settings["notify_recovered"]:
                continue
            try:
                if repo.notification_logged(conn, p["event_id"], p["kind"], "desktop"):
                    continue
                verb = "opened" if p["kind"] == "opened" else "recovered"
                title, body = toast_text(verb, p["severity"], settings["privacy_mode"], p["metric"], p["where"], p["value"])
                res = self.notifier.send(title, body)
                if not res.ok:
                    log.warning("desktop notification failed: %s", res.detail)
                with transaction(conn):
                    repo.log_notification(conn, p["event_id"], p["kind"], "desktop", fmt(self.clock.now()), res.ok, res.detail)
            except Exception as exc:  # noqa: BLE001
                log.warning("desktop notification error: %s", type(exc).__name__)

    # ------------------------------------------------------------ housekeeping
    def _daily_prune(self, conn: Any, now: _dt.datetime) -> None:
        today = fmt(now)[:10]
        if repo.meta_get(conn, repo.PRUNE_KEY) == today:
            return
        repo.prune_samples(conn, fmt(now - _dt.timedelta(days=PRUNE_DAYS)))
        for m in repo.metric_rows(conn, include_disabled=True):
            recompute_highs(conn, m["metric_id"], now)
        repo.meta_set(conn, repo.PRUNE_KEY, today)


def record_in_app(conn: Any, event_id: str, kind: str, at: str, settings: Dict[str, Any]) -> None:
    if settings.get("in_app_notifications", True):
        repo.log_notification(conn, event_id, kind, "in_app", at, True, None)


def recompute_highs(conn: Any, metric_id: str, now: _dt.datetime) -> None:
    out: Dict[str, Any] = {}
    for k, days in (("30", 30), ("60", 60), ("90", 90)):
        h = repo.high_from_samples(conn, metric_id, fmt(now - _dt.timedelta(days=days)))
        out["high_" + k], out["high_%s_date" % k] = (h["value"], h["day"]) if h else (None, None)
    repo.set_highs(conn, metric_id, out)


def backfill(conn: Any, provider: Any, now: _dt.datetime, *, limit: int = BACKFILL_PER_POLL) -> int:
    """DEV simulator only: coarse (4-hourly) history back to 90 days, and a bridge from an old last sample up to now,
    so highs, trends and sparklines mean something. Only fills gaps; never touches existing samples."""
    if not getattr(provider, "simulated", False):
        return 0
    cutoff = fmt(now - _dt.timedelta(days=BACKFILL_MIN_DAYS))
    recent = fmt(now - _dt.timedelta(hours=12))
    step = _dt.timedelta(hours=BACKFILL_STEP_HOURS)
    done = 0
    for m in repo.metric_rows(conn, include_disabled=True):
        first, last = repo.sample_span(conn, m["metric_id"])
        ranges = []
        if first is None:
            ranges.append((now - _dt.timedelta(days=HISTORY_DAYS), now - step))
        else:
            if first > cutoff:
                ranges.append((now - _dt.timedelta(days=HISTORY_DAYS), parse(first) - step))
            if last < recent:
                ranges.append((parse(last) + step, now - step))
        rows = []
        for lo, hi in ranges:
            t = lo
            while t <= hi:
                rows.append({"metric_id": m["metric_id"], "sampled_at": fmt(t), "source_update": fmt(t),
                             "value": provider.value_at(m["ticker"], t)})
                t += step
        if rows:
            repo.insert_samples(conn, rows)
            recompute_highs(conn, m["metric_id"], now)
        if ranges:
            done += 1
        if done >= limit:
            break
    return done


def make_ctx(monitor: "Monitor", conn: Any) -> Any:
    from .reads import Ctx
    ok, _ = monitor.provider.availability()
    return Ctx(monitor.clock.now(), repo.read_settings(conn)["poll_interval_seconds"], ok, bool(monitor.provider.simulated))
