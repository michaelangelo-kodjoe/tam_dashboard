"""Database access: the only place that opens SQLite files.

* `channel` ('dev'|'prod') is a REQUIRED keyword on every open; there is no default
  (PM D-25b). The stamp in app_meta is checked on every open.
* Imports the reference runner `db/migrate.py` (and `db/queries/*.sql`) unmodified.
* Never copies a live DB file; backups use the SQLite online backup API (see backups.py).
"""
from __future__ import annotations

import os
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

DB_DIR = Path(__file__).resolve().parent.parent / "db"
if str(DB_DIR) not in sys.path:
    sys.path.insert(0, str(DB_DIR))
import migrate  # noqa: E402  (db/migrate.py, owned by the data architect)

QUERIES_DIR = DB_DIR / "queries"
_SQL_CACHE: Dict[str, str] = {}


def load_query(name: str) -> str:
    if name not in _SQL_CACHE:
        _SQL_CACHE[name] = (QUERIES_DIR / name).read_text(encoding="utf-8")
    return _SQL_CACHE[name]


def open_db(path: Path, *, channel: str, rows: bool = True) -> sqlite3.Connection:
    """Open a connection (WAL, foreign keys, busy timeout via migrate.connect)."""
    if channel not in ("dev", "prod"):
        raise ValueError(f"channel must be 'dev' or 'prod', got {channel!r}")
    conn = migrate.connect(path)
    try:
        has_meta = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").fetchone()
        if has_meta:
            row = conn.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()
            if row is not None and row[0] != channel:
                raise migrate.MigrationError(
                    f"DB belongs to channel {row[0]!r}; refusing to open it as {channel!r}")
        if rows:
            conn.row_factory = sqlite3.Row
    except Exception:
        conn.close()
        raise
    return conn


def atomic_replace(src: Any, dst: Any) -> None:
    """The ONE place a database file is swapped (whole-database restore, D-140): same-volume atomic rename."""
    os.replace(src, dst)


def raw_connect(target: Any, *, uri: bool = False) -> sqlite3.Connection:
    """Plain connection for the whole-database restore (staged copies, read-only checks, the swap). Only dbkit opens files."""
    return sqlite3.connect(str(target), uri=uri)


def open_scratch() -> sqlite3.Connection:
    """Empty in-memory database with the full schema (no file, no live data): used to dry-run row validity."""
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.executescript((DB_DIR / "schema.sql").read_text(encoding="utf-8"))
    conn.execute("PRAGMA foreign_keys = OFF")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE ... COMMIT; ROLLBACK on any error. Data and audit share this transaction."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    else:
        try:
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise


def rows_to_dicts(cur: sqlite3.Cursor) -> List[Dict[str, Any]]:
    return [dict(r) for r in cur.fetchall()]


def one(conn: sqlite3.Connection, sql: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    r = conn.execute(sql, params or {}).fetchone()
    return dict(r) if r is not None else None


def like_pattern(q: str) -> str:
    """Escape \\ % _ and wrap in % for use with `LIKE :p ESCAPE '\\'`."""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"
