"""Restore planner (D-126, D-127): classifies every staged row as New / Identical / Differs / Invalid against the
database and the file. Reads only. Parents before children; nothing existing is ever changed."""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..dbkit import open_scratch
from ..importer.reader import _CTRL, CellError, Formula, _clip, _is_blank
from . import tables as T
from .readers import RawRow

_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_ISSUES_KEPT = 5000
_ONE_LINE = {"name", "task", "server_name", "bpid", "ticker"}      # single-line, trimmed in the schema


@dataclass
class Result:
    table: str
    row: int
    outcome: str                              # new | identical | differs | invalid
    key: Any = None
    values: Optional[Dict[str, Any]] = None
    problems: List[Dict[str, str]] = field(default_factory=list)       # [{column, code, text}]
    raw: Dict[str, str] = field(default_factory=dict)
    file_id: Optional[str] = None


@dataclass
class Plan:
    results: List[Result]
    counts: Dict[str, Dict[str, int]]         # table key -> outcome -> n
    plan_hash: str

    def new_rows(self, table: str) -> List[Result]:
        return [r for r in self.results if r.table == table and r.outcome == "new"]

    @property
    def totals(self) -> Dict[str, int]:
        out = {"new": 0, "identical": 0, "differs": 0, "invalid": 0}
        for c in self.counts.values():
            for k in out:
                out[k] += c.get(k, 0)
        out["rows"] = sum(out.values())
        return out


# ------------------------------------------------------------------------------------------- typing
def _p(col: str, code: str, text: str) -> Dict[str, str]:
    return {"column": col, "code": code, "text": text}


def _typed(c: T.Col, v: Any, probs: List[Dict[str, str]]) -> Any:
    h = c.header
    if isinstance(v, Formula):
        probs.append(_p(h, "formula_not_allowed", f"{h}: formulas are not accepted; paste the value"))
        return None
    if isinstance(v, CellError):
        probs.append(_p(h, "cell_error", f"{h}: the cell holds an error value"))
        return None
    if _is_blank(v):
        return c.default
    k = c.kind
    if k == "bool":
        if isinstance(v, bool):
            return int(v)
        s = str(v).strip().casefold()
        if s in ("yes", "y", "true", "1", "1.0"):
            return 1
        if s in ("no", "n", "false", "0", "0.0"):
            return 0
        probs.append(_p(h, "bool_invalid", f"{h}: '{_clip(str(v), 20)}' is not Yes or No"))
        return None
    if k == "int":
        try:
            if isinstance(v, bool):
                raise ValueError
            f = float(str(v).strip()) if not isinstance(v, (int, float)) else float(v)
            if not f.is_integer():
                raise ValueError
            n = int(f)
        except ValueError:
            probs.append(_p(h, "number_invalid", f"{h}: '{_clip(str(v), 20)}' is not a whole number"))
            return None
        if (c.minv is not None and n < c.minv) or (c.maxv is not None and n > c.maxv):
            probs.append(_p(h, "number_range", f"{h}: {n} is outside the allowed range"))
            return None
        return n
    if k == "date":
        if isinstance(v, _dt.datetime):
            return v.date().isoformat()
        if isinstance(v, _dt.date):
            return v.isoformat()
        s = str(v).strip()
        try:
            if not _DATE.match(s):
                raise ValueError
            _dt.date.fromisoformat(s)
        except ValueError:
            probs.append(_p(h, "date_invalid", f"{h}: '{_clip(s, 20)}' is not a date in YYYY-MM-DD form"))
            return None
        return s
    if k == "instant":
        if isinstance(v, (_dt.datetime, _dt.date)):
            d = v if isinstance(v, _dt.datetime) else _dt.datetime(v.year, v.month, v.day)
            d = d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)
        else:
            s = str(v).strip()
            if _INSTANT.match(s):
                try:
                    _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
                    return s
                except ValueError:
                    pass
            try:
                d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
                d = d if d.tzinfo else d.replace(tzinfo=_dt.timezone.utc)
            except ValueError:
                probs.append(_p(h, "time_invalid", f"{h}: '{_clip(s, 30)}' is not a date and time"))
                return None
        d = d.astimezone(_dt.timezone.utc)
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"
    # text
    if isinstance(v, bool) or isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        probs.append(_p(h, "value_type", f"{h}: a date, time or TRUE/FALSE is not accepted here; type it as text"))
        return None
    if isinstance(v, float):
        s = str(int(v)) if v.is_integer() else repr(v)
    else:
        s = str(v)
    if _CTRL.search(s):
        probs.append(_p(h, "control_characters", f"{h}: contains control characters"))
        return None
    if c.db in _ONE_LINE:                                   # QA-7-3: say exactly what the database rule is
        if re.search(r"[\t\r\n]", s):
            probs.append(_p(h, "tab_or_linebreak", f"{h}: must not contain tabs or line breaks"
                                                  + (" (the value starts with a tab)" if s[:1] == "\t" else "")))
            return None
        if s != s.strip():
            probs.append(_p(h, "leading_trailing_space", f"{h}: must not start or end with a space"))
            return None
    if c.choices:
        canon = {x.casefold(): x for x in c.choices}.get(s.strip().casefold())
        if canon is None:
            probs.append(_p(h, "value_not_allowed", f"{h}: '{_clip(s, 30)}' is not one of: {', '.join(c.choices)}"))
            return None
        return canon
    if c.maxlen and len(s) > c.maxlen:
        probs.append(_p(h, "too_long", f"{h}: is {len(s)} characters; the limit is {c.maxlen}"))
        return None
    return s


def parse_row(t: T.Table, rr: RawRow, scratch: Optional[sqlite3.Connection]) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    probs: List[Dict[str, str]] = []
    vals: Dict[str, Any] = {}
    for c in t.data_cols:
        present = c.header.casefold() in rr.cells
        if not present:
            continue
        before = len(probs)
        v = _typed(c, rr.cells[c.header.casefold()], probs)
        if c.required and v is None and len(probs) == before:
            probs.append(_p(c.header, "required", f"{c.header}: is required"))
        if len(probs) == before:
            vals[c.db] = v
    if not probs and scratch is not None:
        msg = _scratch_check(scratch, t, vals)
        if msg:
            probs.append(_p("", "database_rule", msg))
    return vals, probs


def _scratch_check(conn: sqlite3.Connection, t: T.Table, vals: Dict[str, Any]) -> Optional[str]:
    """Dry insert into an empty in-memory copy of the schema so the real CHECK rules decide (never the live DB)."""
    cols = [c for c, v in vals.items() if v is not None]
    sql = f"INSERT INTO {t.db} ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})"  # nosec B608 - fixed identifiers
    conn.execute("SAVEPOINT chk")
    try:
        conn.execute(sql, {c: vals[c] for c in cols})
        return None
    except sqlite3.IntegrityError as exc:
        m = str(exc)
        col = next((c for c in cols + [x.db for x in t.data_cols] if c and f"{t.db}.{c}" in m), None)
        if m.startswith("NOT NULL"):
            return f"{col or 'A column'}: is required"
        return (f"{col}: the value is not allowed by the database rules" if col
                else "The values in this row do not fit together (a database rule rejected it)")
    finally:
        conn.execute("ROLLBACK TO chk")
        conn.execute("RELEASE chk")


new_scratch = open_scratch


# ------------------------------------------------------------------------------------------- db snapshot
def _key(t: T.Table, vals: Dict[str, Any]) -> Any:
    return tuple(vals.get(c) for c in t.id_cols) if len(t.id_cols) > 1 else vals.get(t.id_cols[0])


def load_db(conn: sqlite3.Connection) -> Dict[str, Dict[Any, Dict[str, Any]]]:
    out: Dict[str, Dict[Any, Dict[str, Any]]] = {}
    for t in T.TABLES:
        cols = [c.db for c in t.data_cols]
        sql = f"SELECT {', '.join(cols)} FROM {t.db}"  # nosec B608 - fixed identifiers
        rows = {}
        for r in conn.execute(sql):
            d = dict(zip(cols, r))
            rows[_key(t, d)] = d
        out[t.key] = rows
    return out


def _same(a: Any, b: Any) -> bool:
    return (a is None and b is None) or a == b


def _diff_cols(t: T.Table, vals: Dict[str, Any], db: Dict[str, Any]) -> List[str]:
    return [c.header for c in t.data_cols if c.db in vals and not _same(vals[c.db], db.get(c.db))]


# ------------------------------------------------------------------------------------------- plan
def build_plan(staged: Dict[str, Tuple[str, List[RawRow]]], conn: sqlite3.Connection,
               csv_parent_hint: bool = False) -> Plan:
    """staged: table key -> (file_id, rows). Pure function of (staged rows, database)."""
    db = load_db(conn)
    scratch = new_scratch()
    results: List[Result] = []
    counts: Dict[str, Dict[str, int]] = {}
    new_keys: Dict[str, Set[Any]] = {t.key: set() for t in T.TABLES}
    # uniqueness trackers: db + new rows of this file
    acct_names = {str(r["name"]).casefold(): k for k, r in db["accounts"].items()}
    app_names = {(r["client_id"], str(r["name"]).casefold()): k for k, r in db["appliances"].items()}
    tickers = {r["ticker"]: k for k, r in db["metrics"].items()}
    metric_names = {(r["object_id"], str(r["metric_name"]).casefold()): k for k, r in db["metrics"].items()}
    primaries = {r["client_id"]: k for k, r in db["contacts"].items() if r.get("is_primary")}
    rec_ident: Dict[Tuple, Any] = {}
    for k, r in db["records"].items():
        rec_ident[_rec_ident(r)] = k
    for t in T.TABLES:
        c = counts.setdefault(t.key, {"new": 0, "identical": 0, "differs": 0, "invalid": 0})
        if t.key not in staged:
            continue
        file_id, rows = staged[t.key]
        seen: Dict[Any, int] = {}
        for rr in rows:
            raw = {h: _raw(v) for h, v in rr.cells.items()}
            vals, probs = parse_row(t, rr, scratch)
            res = Result(t.key, rr.n, "invalid", None, vals, probs, raw, file_id)
            if not probs:
                key = _key(t, vals)
                res.key = key
                if key in seen:
                    probs.append(_p("", "repeats_row", f"Repeats row {seen[key]} of this sheet (same {'/'.join(t.id_cols)})"))
                else:
                    seen[key] = rr.n
                    if key in db[t.key]:
                        diff = _diff_cols(t, vals, db[t.key][key])
                        res.outcome = "differs" if diff else "identical"
                        if diff:
                            res.problems = [_p(diff[0], "differs", "Already in the database with different content ("
                                               + ", ".join(diff[:6]) + (", ..." if len(diff) > 6 else "")
                                               + "). Existing data is never overwritten; this row is skipped.")]
                    else:
                        _check_new(t, vals, res, db, new_keys, acct_names, app_names, tickers, metric_names, primaries,
                                   rec_ident, staged, csv_parent_hint)
                        if not res.problems:
                            res.outcome = "new"
                            _register(t, vals, key, new_keys, acct_names, app_names, tickers, metric_names, primaries,
                                      rec_ident)
            c[res.outcome] += 1
            results.append(res)
    scratch.close()
    h = hashlib.sha256()
    for r in results:
        h.update(json.dumps([r.table, r.row, r.outcome, str(r.key), r.file_id], sort_keys=True).encode())
    return Plan(results, counts, "sha256:" + h.hexdigest())


def _raw(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, _dt.datetime):
        return v.isoformat(sep=" ")
    return str(v)[:32767]


def _rec_ident(r: Dict[str, Any]) -> Tuple:
    if r.get("schedule_year") is not None:
        return (r["client_id"], str(r["server_name"]).casefold(), r["schedule_year"], r.get("schedule_quarter"))
    return (r["client_id"], str(r["server_name"]).casefold(), None, r.get("scheduled_date") or "")


def _check_new(t, vals, res, db, new_keys, acct_names, app_names, tickers, metric_names, primaries, rec_ident, staged,
               csv_hint) -> None:
    def parent_ok(table: str, key: Any) -> bool:
        return key in db[table] or key in new_keys[table]

    def miss(label: str, ptable: str, hint: str) -> None:
        extra = f" {hint}." if csv_hint and ptable not in staged else ""
        res.problems.append(_p(label, "parent_missing", f"{label}: the parent record is not in the database or in this "
                                                       f"restore.{extra}"))

    for fk, ptable, hint in t.parents:
        if fk == "*window":
            y, q = vals.get("schedule_year"), vals.get("schedule_quarter")
            if y is not None and q is not None and not parent_ok("quarters", (y, q)):
                miss("Operations quarter", ptable, hint)
            continue
        v = vals.get(fk)
        if v is not None and not parent_ok(ptable, v):
            miss(fk, ptable, hint)
    if res.problems:
        return
    if t.key == "accounts" and str(vals["name"]).casefold() in acct_names:
        res.problems.append(_p("name", "name_taken", "name: another account with this name already exists "
                                                     "(different id). Merge similar accounts with the account import."))
    elif t.key == "appliances" and (vals["client_id"], str(vals["name"]).casefold()) in app_names:
        res.problems.append(_p("name", "name_taken", "name: this account already has an appliance with this name "
                                                     "(different id)."))
    elif t.key == "metrics":
        if vals["ticker"] in tickers:
            res.problems.append(_p("ticker", "ticker_taken", "ticker: already used by another metric (different id)."))
        elif (vals["object_id"], str(vals["metric_name"]).casefold()) in metric_names:
            res.problems.append(_p("metric_name", "name_taken", "metric_name: this appliance already has a metric "
                                                                "with this name (different id)."))
    elif t.key == "contacts" and vals.get("is_primary") and vals["client_id"] in primaries:
        res.problems.append(_p("is_primary", "second_primary", "is_primary: this account already has a primary contact."))
    elif t.key == "records" and _rec_ident(vals) in rec_ident:
        res.problems.append(_p("server_name", "record_taken", "This appliance already has an Operations record for this "
                                                              "quarter (different id)."))


def _register(t, vals, key, new_keys, acct_names, app_names, tickers, metric_names, primaries, rec_ident) -> None:
    new_keys[t.key].add(key)
    if t.key == "accounts":
        acct_names[str(vals["name"]).casefold()] = key
    elif t.key == "appliances":
        app_names[(vals["client_id"], str(vals["name"]).casefold())] = key
    elif t.key == "metrics":
        tickers[vals["ticker"]] = key
        metric_names[(vals["object_id"], str(vals["metric_name"]).casefold())] = key
    elif t.key == "contacts" and vals.get("is_primary"):
        primaries[vals["client_id"]] = key
    elif t.key == "records":
        rec_ident[_rec_ident(vals)] = key
