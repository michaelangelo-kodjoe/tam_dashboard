"""BAMS appliance/metric import file spec (D-63, D-64): same hardened reader as accounts, different columns.
One file row = one metric of one appliance. Row-level problems make that row Invalid; they never fail the file."""
from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List, Optional

from ..dupes import clean_name
from . import reader as R
from .reader import CellError, FileSpec, Formula, ParsedRow, _clip, _is_blank, _raw_text, _text

FIELDS = ("account", "bpid", "appliance", "metric", "ticker", "region", "location", "environment", "enabled",
          "stale_after_seconds")
LABELS = {"account": "Account", "bpid": "BPID", "appliance": "Appliance", "metric": "Metric", "ticker": "Ticker",
          "region": "Region", "location": "Location", "environment": "Environment", "enabled": "Enabled",
          "stale_after_seconds": "Stale after (s)"}
HEADERS = [LABELS[f] for f in FIELDS]
ALIASES = {v.casefold(): k for k, v in LABELS.items()}
LIMITS = {"account": 200, "bpid": 32, "appliance": 200, "metric": 200, "ticker": 200, "region": 100, "location": 200}
DEFAULT_STALE = 120
MAX_STALE = 31536000
_YES = {"yes", "y", "true", "1"}
_NO = {"no", "n", "false", "0"}


def _e(row: int, fld: str, code: str, problem: str) -> Dict[str, str]:
    return R._err(row, fld, code, problem, LABELS)


def check_headers(mapping: Dict[str, int], header_cells: List[Any]) -> None:
    missing = [LABELS[f] for f in ("appliance", "metric", "ticker") if f not in mapping]
    if "account" not in mapping and "bpid" not in mapping:
        missing.insert(0, "Account or BPID")
    if missing:
        found = [_clip(str(c), 40) for c in header_cells if not _is_blank(c)][:30]
        raise R._bad("header_missing", "Row 1 must contain the columns: " + ", ".join(missing) +
                     ". Download the template to see the layout.", missing=missing, found=found)


def _flag_cell(v: Any, fld: str, row: int, errors: List[Dict[str, str]]) -> bool:
    if isinstance(v, Formula):
        errors.append(_e(row, fld, "formula_not_allowed", "formulas are not accepted; paste the value"))
        return True
    if isinstance(v, CellError):
        errors.append(_e(row, fld, "cell_error", f"the cell holds an error value ({_clip(str(v), 20)}); fix or clear it"))
        return True
    return False


def parse_row(rownum: int, cells: Dict[str, Any]) -> ParsedRow:
    errors: List[Dict[str, str]] = []
    values: Dict[str, Any] = {f: None for f in FIELDS}
    raw = {f: _raw_text(cells.get(f)) for f in FIELDS}
    for fld in ("account", "bpid", "appliance", "metric", "ticker", "region", "location", "environment"):
        values[fld] = _text(cells.get(fld), fld, rownum, errors, LABELS)
    for fld in ("appliance", "metric"):
        if values[fld] is not None:
            values[fld] = clean_name(values[fld])
    for fld, limit in LIMITS.items():
        val = values[fld]
        if val is not None and len(val) > limit:
            code = f"{fld}_too_long"
            errors.append(_e(rownum, fld, code, f"is {len(val)} characters; the limit is {limit}. Shorten it (nothing is cut automatically)"))
            values[fld] = None
    for fld, code in (("appliance", "appliance_required"), ("metric", "metric_required"), ("ticker", "ticker_required")):
        if values[fld] is None and not any(e["field"] == fld for e in errors):
            errors.append(_e(rownum, fld, code, "is required"))
    if values["account"] is None and values["bpid"] is None and not any(e["field"] in ("account", "bpid") for e in errors):
        errors.append(_e(rownum, "account", "account_required", "needs an Account name or a BPID"))
    env = values["environment"]
    if env is not None:
        if env.upper() in ("PROD", "DEV"):
            values["environment"] = env.upper()
        else:
            errors.append(_e(rownum, "environment", "environment_invalid", f"'{_clip(env, 30)}' is not PROD or DEV"))
            values["environment"] = None
    # Enabled
    v = cells.get("enabled")
    values["enabled"] = True
    if not _flag_cell(v, "enabled", rownum, errors) and not _is_blank(v):
        t = str(v).strip().casefold() if not isinstance(v, bool) else ("yes" if v else "no")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            t = str(int(v)) if float(v).is_integer() else "?"
        if t in _YES:
            values["enabled"] = True
        elif t in _NO:
            values["enabled"] = False
        else:
            errors.append(_e(rownum, "enabled", "enabled_invalid", f"'{_clip(_raw_text(v), 30)}' is not Yes or No"))
    # Stale after
    v = cells.get("stale_after_seconds")
    values["stale_after_seconds"] = DEFAULT_STALE
    if not _flag_cell(v, "stale_after_seconds", rownum, errors) and not _is_blank(v):
        n: Optional[int] = None
        if isinstance(v, bool) or isinstance(v, (_dt.date, _dt.time, _dt.datetime)):
            n = None
        elif isinstance(v, (int, float)):
            n = int(v) if float(v).is_integer() else None
        elif isinstance(v, str) and v.strip().isascii() and v.strip().isdigit():
            n = int(v.strip())
        if n is None or not 1 <= n <= MAX_STALE:
            errors.append(_e(rownum, "stale_after_seconds", "stale_after_invalid",
                             f"'{_clip(_raw_text(v), 30)}' must be a whole number of seconds above 0"))
        else:
            values["stale_after_seconds"] = n
    return ParsedRow(row=rownum, values=values, raw=raw, errors=errors)


SPEC = FileSpec(sheet="Import", aliases=ALIASES, labels=LABELS, parse_row=parse_row, check_headers=check_headers,
                noun="metric", no_rows_hint="Add appliances and metrics and upload it again.")


def read_upload(data: bytes, filename: str) -> R.ParsedFile:
    return R.read_upload(data, filename, SPEC)
