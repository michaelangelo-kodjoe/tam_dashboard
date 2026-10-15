"""Pure alert lifecycle and freshness (D-52, D-53). No I/O, no clock reads: callers pass `now`.

Evaluation happens only for a NEW, FRESH sample. Stale data or a provider outage never reaches `step()`
(the monitor skips it), which is what "freezes" counters, events and suppression."""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Dict, Optional

OPS = {">": lambda a, b: a > b, ">=": lambda a, b: a >= b, "<": lambda a, b: a < b, "<=": lambda a, b: a <= b}
PERIOD_KEY = {"30d": "high_30", "60d": "high_60", "90d": "high_90"}
PERIOD_LABEL = {"30d": "30-day", "60d": "60-day", "90d": "90-day"}
LIVE_FLOOR = 75


def live_seconds(poll_interval: int) -> int:
    return max(poll_interval + 15, LIVE_FLOOR)


def freshness(age: Optional[float], has_value: bool, live_s: int, stale_s: int, available: bool = True) -> str:
    if not available or not has_value or age is None:
        return "No Data"
    if age <= live_s:
        return "Live"
    return "Delayed" if age <= stale_s else "Stale"


def level(rule: Dict[str, Any], highs: Dict[str, Optional[float]]) -> Optional[float]:
    """The number the value is compared with; None when it cannot be known (no high yet)."""
    t = rule["rule_type"]
    if t == "fixed_threshold":
        return rule["threshold"]
    high = highs.get(PERIOD_KEY[rule["reference_period"]])
    if high is None:
        return None
    return high * rule["threshold"] / 100.0 if t == "pct_of_high" else high


def breaches(rule: Dict[str, Any], value: Optional[float], highs: Dict[str, Optional[float]]) -> Optional[bool]:
    if value is None:
        return None
    lv = level(rule, highs)
    if lv is None:
        return None
    return OPS[rule["operator"]](value, lv)


@dataclass
class Decision:
    action: str                 # none | open | retrigger | recover
    breach_count: int
    suppress: bool


def step(rule: Dict[str, Any], value: float, highs: Dict[str, Optional[float]], active: Optional[Dict[str, Any]],
         last_closed_at: Optional[_dt.datetime], now: _dt.datetime) -> Decision:
    b = breaches(rule, value, highs)
    count, sup = int(rule["breach_count"]), bool(rule["suppress_until_clear"])
    if b is None:                                   # high unknown: nothing can be said, nothing changes
        return Decision("none", count, sup)
    if b:
        count += 1
        if active is not None:
            return Decision("retrigger", count, sup)
        if sup:
            return Decision("none", count, sup)
        if count < rule["consecutive_updates"]:
            return Decision("none", count, sup)
        if last_closed_at is not None and rule["cooldown_minutes"] > 0:
            if now < last_closed_at + _dt.timedelta(minutes=rule["cooldown_minutes"]):
                return Decision("none", count, sup)
        return Decision("open", count, sup)
    # clear: counters reset, suppression lifts, an open event becomes recovered (never closed)
    if active is not None and active["status"] == "open":
        return Decision("recover", 0, False)
    return Decision("none", 0, False)


def condition_text(rule: Dict[str, Any]) -> str:
    t = rule["rule_type"]
    if t == "fixed_threshold":
        return f"{rule['operator']} {num(rule['threshold'])}"
    if t == "pct_of_high":
        return f"{rule['operator']} {num(rule['threshold'])}% of the {PERIOD_LABEL[rule['reference_period']]} high"
    return f"{rule['operator']} the {PERIOD_LABEL[rule['reference_period']]} high"


def num(x: Optional[float]) -> str:
    if x is None:
        return ""
    return f"{x:,.4f}".rstrip("0").rstrip(".")


def _updates(n: int) -> str:
    return f"{n} update" + ("" if n == 1 else "s")


def rule_summary(rule: Dict[str, Any]) -> str:
    return f"{condition_text(rule)} for {_updates(rule['consecutive_updates'])}"


def preview_sentence(rule: Dict[str, Any], metric_name: str, highs: Dict[str, Optional[float]]) -> str:
    return preview_for(rule, metric_name, highs)


def preview_for(rule: Dict[str, Any], subject: str, highs: Optional[Dict[str, Optional[float]]]) -> str:
    """`subject` is a metric name or 'a matching metric'. highs None = template (no numbers)."""
    n, sev = _updates(rule["consecutive_updates"]), rule["severity"]
    t = rule["rule_type"]
    if t == "fixed_threshold":
        return f"Alerts when {subject} {rule['operator']} {num(rule['threshold'])} for {n} ({sev})"
    label = PERIOD_LABEL[rule["reference_period"]]
    hv = highs.get(PERIOD_KEY[rule["reference_period"]]) if highs else None
    hs = f" ({num(hv)})" if hv is not None else ""
    if t == "pct_of_high":
        return f"Alerts when {subject} {rule['operator']} {num(rule['threshold'])}% of the {label} high{hs} for {n} ({sev})"
    word = "exceeds" if rule["operator"] == ">" else "reaches"
    return f"Alerts when {subject} {word} the {label} high{hs} for {n} ({sev})"


def event_message(rule: Dict[str, Any], metric_name: str) -> str:
    return f"{metric_name} {condition_text(rule)}"[:1000]


def validate_rule_fields(r: Dict[str, Any]) -> Dict[str, str]:
    """Field messages for a merged rule/config (mirrors the schema CHECKs)."""
    f: Dict[str, str] = {}
    t = r.get("rule_type")
    if t not in ("fixed_threshold", "pct_of_high", "exceeds_high"):
        f["rule_type"] = "Choose a rule type."
        return f
    if r.get("operator") not in OPS:
        f["operator"] = "Choose an operator."
    th, ref = r.get("threshold"), r.get("reference_period")
    if t == "fixed_threshold":
        if th is None:
            f["threshold"] = "Threshold is required for a threshold rule."
        if ref is not None:
            f["reference_period"] = "A threshold rule has no reference period."
    elif t == "pct_of_high":
        if th is None or th <= 0:
            f["threshold"] = "Percent of high needs a threshold above 0."
        elif th > 10000:
            f["threshold"] = "Threshold is too large."
        if ref is None:
            f["reference_period"] = "Choose 30, 60 or 90 days."
    else:
        if ref is None:
            f["reference_period"] = "Choose 30, 60 or 90 days."
        if th is not None:
            f["threshold"] = "An exceeds-high rule has no threshold."
        if r.get("operator") not in (">", ">="):
            f["operator"] = "Use > or >= with a high."
    cu = r.get("consecutive_updates")
    if cu is None or cu < 1 or cu > 1000:
        f["consecutive_updates"] = "Consecutive updates must be 1 or more."
    cd = r.get("cooldown_minutes")
    if cd is None or cd < 0 or cd > 10080:
        f["cooldown_minutes"] = "Cooldown must be between 0 and 10080 minutes."
    return f
