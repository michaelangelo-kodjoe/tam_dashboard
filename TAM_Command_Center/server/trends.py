"""Accounts activity trend (D-31, PM-AC-2): executes db/queries/activity_trend.sql UNMODIFIED."""
from __future__ import annotations

import datetime as _dt
import sqlite3
from typing import Dict, List, Optional

from .dbkit import load_query
from .localtime import trend_params

TREND_DAYS = 14          # the reference query is fixed at 14 buckets


def activity_trend(conn: sqlite3.Connection, today: str, tz: Optional[_dt.tzinfo] = None, *,
                   include_inactive: bool = False) -> Dict[str, List[int]]:
    """{client_id: [n x 14]}, oldest first (index 13 = today). Every selected account is present, zeros included."""
    params = trend_params(_dt.date.fromisoformat(today), TREND_DAYS, tz, include_inactive)
    series: Dict[str, List[int]] = {}
    for r in conn.execute(load_query("activity_trend.sql"), params):
        series.setdefault(r["client_id"], [0] * TREND_DAYS)[r["day_index"]] = int(r["n"])
    return series
