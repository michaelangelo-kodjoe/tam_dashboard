"""BAMS freshness semantics: Live/Delayed/Stale come from last_received (last successful valid receipt);
last_source_update is the value-change time. Unchanged successful polls still reach alert evaluation."""
from __future__ import annotations

import datetime as dt

import pytest

from server.bams.clock import fmt
from server.tests.test_bams_monitor import FakeNotifier, T0, events, post, setup_metric


@pytest.fixture
def b(build):
    api = build(app_kw={"utc_base": lambda: T0, "notifier": FakeNotifier()})
    return api


def advance(api, secs):
    post(api, "/api/dev/bams/clock", {"advance_seconds": secs})


def poll_value(api, mid, value, secs=60):
    advance(api, secs)
    post(api, "/api/dev/bams/force-value", {"metric_id": mid, "value": value})
    return api.sql("SELECT current_value, last_source_update, last_received FROM bams_metrics WHERE id = ?", (mid,))[0]


def now(api):
    return api.rt.bams.clock.now()


def metric_row(api, mid):
    return api.get(f"/api/bams/metric/{mid}").json()["item"]["row"]


def set_times(api, mid, received_ago, changed_ago, value=75.0):
    n = now(api)
    api.exec("UPDATE bams_metrics SET current_value = ?, last_source_update = ?, last_received = ? WHERE id = ?",
             (value, fmt(n - dt.timedelta(seconds=changed_ago)), None if received_ago is None else fmt(n - dt.timedelta(seconds=received_ago)), mid))


# 1
def test_recent_receipt_with_old_value_change_is_live(b):
    _, _, mid, _ = setup_metric(b)
    set_times(b, mid, received_ago=10, changed_ago=15 * 60)
    assert metric_row(b, mid)["freshness"] == "Live"


# 2
def test_old_receipt_is_stale(b):
    _, _, mid, _ = setup_metric(b)
    set_times(b, mid, received_ago=15 * 60, changed_ago=15 * 60)
    assert metric_row(b, mid)["freshness"] == "Stale"
    set_times(b, mid, received_ago=100, changed_ago=15 * 60)          # between live and stale_after (120 s)
    assert metric_row(b, mid)["freshness"] == "Delayed"


def test_no_receipt_stays_no_data(b):
    _, _, mid, _ = setup_metric(b)
    set_times(b, mid, received_ago=None, changed_ago=10)
    assert metric_row(b, mid)["freshness"] == "No Data"


# 3
def test_unchanged_successful_poll_advances_only_last_received(b):
    _, _, mid, _ = setup_metric(b)
    first = poll_value(b, mid, 75.0)
    second = poll_value(b, mid, 75.0, secs=600)
    assert second["current_value"] == 75.0
    assert second["last_source_update"] == first["last_source_update"]
    assert second["last_received"] > first["last_received"]
    assert second["last_received"] == fmt(now(b))
    assert metric_row(b, mid)["freshness"] == "Live"                    # a stable value stays Live while polls succeed


# 4
def test_changed_poll_updates_both(b):
    _, _, mid, _ = setup_metric(b)
    first = poll_value(b, mid, 75.0)
    second = poll_value(b, mid, 74.5)
    assert second["current_value"] == 74.5
    assert second["last_source_update"] == second["last_received"] == fmt(now(b))
    assert second["last_source_update"] > first["last_source_update"]


# 5
def test_unchanged_polls_reach_alert_evaluation_three_consecutive(b):
    _, _, mid, rid = setup_metric(b, operator="<", threshold=10, consecutive_updates=3)
    poll_value(b, mid, 8)
    assert b.sql("SELECT breach_count c FROM bams_alert_rules WHERE id = ?", (rid,))[0]["c"] == 1 and not events(b)
    poll_value(b, mid, 8)
    assert b.sql("SELECT breach_count c FROM bams_alert_rules WHERE id = ?", (rid,))[0]["c"] == 2 and not events(b)
    poll_value(b, mid, 8)                                                # third identical observation opens the alert
    ev = events(b)
    assert len(ev) == 1 and ev[0]["status"] == "open" and ev[0]["current_value"] == 8


# 6
def test_no_duplicate_history_for_unchanged_polls(b):
    _, _, mid, _ = setup_metric(b)
    poll_value(b, mid, 75.0)
    n = b.sql("SELECT count(*) n FROM bams_metric_samples WHERE metric_id = ?", (mid,))[0]["n"]
    poll_value(b, mid, 75.0)
    poll_value(b, mid, 75.0)
    assert b.sql("SELECT count(*) n FROM bams_metric_samples WHERE metric_id = ?", (mid,))[0]["n"] == n
    poll_value(b, mid, 76.0)
    assert b.sql("SELECT count(*) n FROM bams_metric_samples WHERE metric_id = ?", (mid,))[0]["n"] == n + 1


# 7
def test_failed_poll_does_not_advance_last_received_and_ages_to_stale(b):
    _, _, mid, _ = setup_metric(b)
    good = poll_value(b, mid, 75.0)
    b.rt.bams.provider.outage = True                                     # provider raises: a failed poll
    for _ in range(3):
        advance(b, 60)
        b.rt.bams.poll_once()
    after = b.sql("SELECT current_value, last_source_update, last_received FROM bams_metrics WHERE id = ?", (mid,))[0]
    assert after == good
    b.rt.bams.provider.outage = False
    b.rt.bams.provider.stale_all = True                                  # polls succeed but return no metric values
    advance(b, 600)
    b.rt.bams.poll_once()
    assert b.sql("SELECT last_received r FROM bams_metrics WHERE id = ?", (mid,))[0]["r"] == good["last_received"]
    assert metric_row(b, mid)["freshness"] == "Stale"
    b.rt.bams.provider.stale_all = False                                 # polling restored: back to Live on the next receipt
    poll_value(b, mid, 75.0, secs=1)
    assert metric_row(b, mid)["freshness"] == "Live"


def test_never_valued_metric_stays_no_data_and_opens_no_alert(b):
    """Imported/new metrics have no value: no stale alert, no event, under a poll that returns nothing."""
    _, _, mid, _ = setup_metric(b)
    b.rt.bams.provider.stale_all = True
    for _ in range(3):
        advance(b, 300)
        b.rt.bams.poll_once()
    assert metric_row(b, mid)["freshness"] == "No Data" and not events(b)
