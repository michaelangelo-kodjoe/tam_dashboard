"""Local-day windows (D-06, D-29): each local midnight is converted to UTC on its own, so DST days are exact."""
from __future__ import annotations

import datetime as _dt
from typing import Dict, Optional


def fmt_instant(t: _dt.datetime) -> str:
    """UTC instant as YYYY-MM-DDTHH:MM:SS.mmmZ (the stored format)."""
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def local_midnight_utc(day: _dt.date, tz: Optional[_dt.tzinfo] = None) -> str:
    """UTC instant of the local midnight that starts `day` (`tz` None = the workstation zone)."""
    naive = _dt.datetime(day.year, day.month, day.day)
    local = naive.replace(tzinfo=tz) if tz is not None else naive          # naive = system local time
    return fmt_instant(local.astimezone(_dt.timezone.utc).replace(tzinfo=None))


def progress_params(day: _dt.date, tz: Optional[_dt.tzinfo] = None) -> Dict[str, str]:
    """Parameters for db/queries/day_progress.sql."""
    return {"today": day.isoformat(), "day_start_utc": local_midnight_utc(day, tz),
            "day_end_utc": local_midnight_utc(day + _dt.timedelta(days=1), tz)}


def trend_params(day: _dt.date, days: int, tz: Optional[_dt.tzinfo] = None,
                 include_inactive: bool = False) -> Dict[str, object]:
    """Parameters for db/queries/activity_trend.sql: b0..b14 = local midnights of day-13 .. day+1."""
    p: Dict[str, object] = {"today": day.isoformat(), "include_inactive": 1 if include_inactive else 0}
    for i in range(days + 1):
        p[f"b{i}"] = local_midnight_utc(day + _dt.timedelta(days=i - (days - 1)), tz)
    return p

