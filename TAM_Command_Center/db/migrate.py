"""TAM Command Center: reference migration runner (data-architect-agent, Phase 1.2).

This module is the executable form of the migration contract in
docs/03_DATA_MODEL.md §6. The backend (T-10) may import it as-is or
re-implement it; either way the contract below is binding:

  1. Migrations live in db/migrations/NNNN_<snake_name>.sql, numbered from
     0001 with no gaps. They are forward-only: never edited after release,
     never downgraded.
  2. app_meta.schema_version is the single source of truth. Each migration
     file ends by raising schema_version to its own number.
  3. A DB whose schema_version is HIGHER than the newest known migration is
     refused (an older app must not touch a newer DB).
  4. A non-empty SQLite file that is not a TAM DB (application_id mismatch and
     no app_meta) is refused (spec §46 "validate database paths").
  5. Before migrating an EXISTING DB (schema_version >= 1) the caller-supplied
     backup hook runs with reason "pre-migration". It must use the SQLite
     online backup API (sqlite3.Connection.backup), never a file copy (§36).
     If the hook raises, nothing is migrated.
  6. Each migration runs in its own BEGIN IMMEDIATE transaction together with
     its schema_version bump and a `migration.NNNN.applied_at` flag, and is
     committed only if `PRAGMA foreign_key_check` is clean. Any error rolls
     the whole migration back.
  7. Running the runner again is a no-op (nothing pending -> no backup, no
     writes). Every 0001 statement is also IF NOT EXISTS / upsert-guarded.
  8. After migrating (and on every open, even when nothing is pending) the
     runner checks that every trigger declared in schema.sql exists
     (assert_guards). A DB whose audit/REPLACE/row_version guards were dropped
     is refused rather than silently opened.
  9. The DB records which channel created it: app_meta 'db.channel' = 'dev' |
     'prod', stamped on first open (assert_channel). Opening with the other
     channel is refused; a PROD open of a mock-seeded DB is refused.
 10. Future table rebuilds (SQLite cannot ALTER a CHECK) must follow the
     12-step procedure in https://sqlite.org/lang_altertable.html; the runner
     will grow a per-migration `-- tam:foreign_keys=off` directive for that.

Python 3.9+ compatible; standard library only.

CLI:
  python db/migrate.py <db_path> [--backup-dir DIR]   migrate (with online backup)
  python db/migrate.py --verify-schema                prove migrations == schema.sql
"""
from __future__ import annotations

import argparse
import datetime as _dt
import re
import sqlite3
import sys
import warnings
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

DB_DIR = Path(__file__).resolve().parent
MIGRATIONS_DIR = DB_DIR / "migrations"
SCHEMA_SQL = DB_DIR / "schema.sql"
APPLICATION_ID = 0x54414D43  # 'TAMC'
_NAME_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")

BackupHook = Callable[[sqlite3.Connection, str], Path]


class MigrationError(RuntimeError):
    pass


def utc_now() -> str:
    """Canonical instant format used by every *_at column."""
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def connect(path: str | Path) -> sqlite3.Connection:
    """Open a connection with the binding pragmas (autocommit mode; we BEGIN explicitly)."""
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
    if str(mode).lower() != "wal" and str(path) != ":memory:":
        raise MigrationError(f"could not enable WAL (journal_mode={mode})")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def discover() -> List[Tuple[int, Path]]:
    found: List[Tuple[int, Path]] = []
    for p in sorted(MIGRATIONS_DIR.glob("*.sql")):
        m = _NAME_RE.match(p.name)
        if not m:
            raise MigrationError(f"bad migration file name: {p.name}")
        found.append((int(m.group(1)), p))
    for expected, (num, p) in enumerate(found, start=1):
        if num != expected:
            raise MigrationError(f"migration numbering gap at {p.name} (expected {expected:04d})")
    return found


def current_version(conn: sqlite3.Connection) -> int:
    has_meta = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").fetchone()
    if not has_meta:
        user_tables = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
        if user_tables:
            raise MigrationError("refusing to migrate: file has tables but is not a TAM Command Center DB")
        app_id = conn.execute("PRAGMA application_id").fetchone()[0]
        if app_id not in (0, APPLICATION_ID):
            raise MigrationError(f"refusing to adopt a file with foreign application_id {app_id:#x}")
        return 0
    row = conn.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()
    if row is None:
        raise MigrationError("app_meta exists but schema_version is missing")
    app_id = conn.execute("PRAGMA application_id").fetchone()[0]
    if app_id != APPLICATION_ID:
        raise MigrationError(f"application_id {app_id:#x} is not TAMC")
    return int(row[0])


def online_backup(conn: sqlite3.Connection, dest: Path) -> Path:
    """SQLite online backup API (safe under WAL with concurrent writers), then verify."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        raise MigrationError(f"backup target already exists: {dest}")
    target = sqlite3.connect(str(dest))
    try:
        conn.backup(target)
        result = target.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise MigrationError(f"backup failed integrity_check: {result}")
    finally:
        target.close()
    return dest


def make_backup_hook(backup_dir: Path) -> BackupHook:
    def hook(conn: sqlite3.Connection, reason: str) -> Path:
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        v = current_version(conn)
        return online_backup(conn, backup_dir / f"tam_{stamp}_{reason}_v{v}.db")
    return hook


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


_DECLARED: Optional[Dict[str, str]] = None


def declared_triggers() -> Dict[str, str]:
    """name -> normalised DDL of every trigger in schema.sql (built once in memory).

    NOTE for deployment-agent: schema.sql must ship with the app; the runner
    reads it at startup to verify the guards (QA-2-5).
    """
    global _DECLARED
    if _DECLARED is None:
        mem = sqlite3.connect(":memory:")
        mem.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
        _DECLARED = {n: _norm(q) for n, q in mem.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='trigger'")}
        mem.close()
    return _DECLARED


def assert_guards(conn: sqlite3.Connection) -> None:
    """Refuse a DB whose trigger set differs from schema.sql in any way (contract item 8):
    a declared trigger missing, a declared trigger altered, or an undeclared one present.

    Compares the normalised trigger SQL, so a same-name trigger with a
    neutered body is refused too.
    """
    have = {n: _norm(q) for n, q in conn.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger'")}
    missing = [t for t in declared_triggers() if t not in have]
    if missing:
        raise MigrationError(f"guard triggers missing: {missing}")
    altered = [t for t, q in declared_triggers().items() if have[t] != q]
    if altered:
        raise MigrationError(f"guard triggers altered: {altered}")
    extra = sorted(t for t in have if t not in declared_triggers())
    if extra:  # QA-3-4: an undeclared trigger can rewrite or delete data unseen
        raise MigrationError(f"undeclared triggers present: {extra}")


def assert_channel(conn: sqlite3.Connection, channel: str) -> None:
    """Stamp app_meta 'db.channel' on first open; refuse a channel mismatch (contract item 9)."""
    if channel not in ("dev", "prod"):
        raise ValueError(channel)
    # Every refusal is decided BEFORE anything is written (QA-2-4): a refused
    # PROD open must not stamp a DEV/mock DB and strand it.
    if channel == "prod":
        # Any mock artefact makes a DB unusable in PROD (QA-3-3): the keys are
        # independent, so each one refuses on its own.
        mock = [k for (k,) in conn.execute(
            "SELECT key FROM app_meta WHERE key IN ('db.mock_seed', 'bams.mock_clock') ORDER BY key")]
        if mock:
            raise MigrationError(f"refusing to open a mock-seeded DB in PROD (found {', '.join(mock)})")
    row = conn.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()
    if row is not None and row[0] != channel:
        raise MigrationError(f"DB belongs to channel {row[0]!r}; refusing to open it as {channel!r}")
    if row is None:
        conn.execute("INSERT INTO app_meta(key, value) VALUES ('db.channel', ?) "
                     "ON CONFLICT(key) DO NOTHING", (channel,))


def purge_audit_events(conn: sqlite3.Connection, where_sql: str = "1") -> int:
    """The ONLY audit delete path (DEV reseed / future retention job).

    Must run inside the caller's open transaction. It drops the delete guard,
    deletes, and re-creates the guard from its own stored DDL, so a crash or
    rollback can never leave deletes enabled (SQLite DDL is transactional).
    """
    if not conn.in_transaction:
        raise MigrationError("purge_audit_events must run inside a transaction")
    ddl = conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' "
                       "AND name='trg_audit_events_no_delete'").fetchone()
    if ddl is None:
        raise MigrationError("audit delete guard missing")
    conn.execute("DROP TRIGGER trg_audit_events_no_delete")
    n = conn.execute(f"DELETE FROM audit_events WHERE {where_sql}").rowcount
    conn.execute(ddl[0])
    return n


def migrate(conn: sqlite3.Connection, backup_hook: Optional[BackupHook] = None, *,
            channel: Optional[str]) -> Dict[str, object]:
    """Apply pending migrations, verify guards, stamp/check the channel.

    `channel` is REQUIRED (QA-2-4): the app passes 'dev' or 'prod' on every
    open. Only schema tooling and tests may pass channel=None explicitly, which
    skips the channel check and emits a warning.
    Returns {'from', 'to', 'applied', 'backup'}.
    """
    if channel is None:
        warnings.warn("migrate(channel=None): channel check skipped (tooling/tests only)", stacklevel=2)
    migrations = discover()
    latest = migrations[-1][0] if migrations else 0
    cur = current_version(conn)
    if cur > latest:
        raise MigrationError(f"DB schema_version {cur} is newer than this app ({latest}); refusing")
    pending = [(n, p) for n, p in migrations if n > cur]
    result: Dict[str, object] = {"from": cur, "to": cur, "applied": [], "backup": None}
    if not pending:
        assert_guards(conn)
        if channel:
            assert_channel(conn, channel)
        return result  # contract item 7: no-op, no backup, no schema writes

    if cur >= 1:
        if backup_hook is None:
            raise MigrationError("existing DB needs migration but no pre-migration backup hook was given")
        qc = conn.execute("PRAGMA quick_check").fetchone()[0]
        if qc != "ok":
            raise MigrationError(f"quick_check failed before migration: {qc}")
        result["backup"] = str(backup_hook(conn, "pre-migration"))  # raises -> abort

    for num, path in pending:
        sql = path.read_text(encoding="utf-8")
        try:
            # executescript leaves the explicit transaction open so we can verify before COMMIT.
            conn.executescript("BEGIN IMMEDIATE;\n" + sql)
            got = int(conn.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0])
            if got != num:
                raise MigrationError(f"{path.name} left schema_version={got}, expected {num}")
            bad = conn.execute("PRAGMA foreign_key_check").fetchall()
            if bad:
                raise MigrationError(f"{path.name} violates foreign keys: {bad[:5]}")
            conn.execute(
                "INSERT INTO app_meta(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (f"migration.{num:04d}.applied_at", utc_now()))
            conn.execute("COMMIT")
        except Exception as exc:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            if isinstance(exc, sqlite3.Error):
                # QA-8-1: bad SQL / disk full in a migration is a refused database, not a crash. Everything is rolled
                # back and the pre-migration backup is kept; the app turns this into a clean exit code 4.
                raise MigrationError(f"{path.name} failed and was rolled back ({type(exc).__name__}: {str(exc)[:200]})") from exc
            raise
        result["applied"].append(path.name)  # type: ignore[union-attr]
        result["to"] = num
    assert_guards(conn)
    if channel:
        assert_channel(conn, channel)
    return result


def schema_fingerprint(conn: sqlite3.Connection) -> List[Tuple[str, str, str]]:
    rows = conn.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").fetchall()
    return [(t, n, re.sub(r"\s+", " ", s).strip()) for t, n, s in rows]


def verify_schema() -> bool:
    """Fresh DB via migrations vs fresh DB via schema.sql must be identical."""
    a = sqlite3.connect(":memory:", isolation_level=None)
    a.execute("PRAGMA foreign_keys = ON")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        migrate(a, channel=None)
    b = sqlite3.connect(":memory:", isolation_level=None)
    b.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
    fa, fb = schema_fingerprint(a), schema_fingerprint(b)
    same = fa == fb and a.execute("PRAGMA application_id").fetchone() == b.execute("PRAGMA application_id").fetchone()
    if not same:
        for x, y in zip(fa, fb):
            if x != y:
                print("DIFF:\n  migrations:", x, "\n  schema.sql:", y)
        print(f"objects: migrations={len(fa)} schema.sql={len(fb)}")
    return same


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("db", nargs="?")
    ap.add_argument("--backup-dir", type=Path)
    ap.add_argument("--verify-schema", action="store_true")
    ap.add_argument("--channel", choices=["dev", "prod"], help="stamp/check app_meta db.channel (required to migrate)")
    args = ap.parse_args(argv)
    if args.verify_schema:
        ok = verify_schema()
        print("verify-schema:", "IDENTICAL" if ok else "MISMATCH")
        return 0 if ok else 1
    if not args.db:
        ap.error("db path required")
    if not args.channel:
        ap.error("--channel dev|prod is required (QA-2-4)")
    db = Path(args.db)
    backup_dir = args.backup_dir or (db.parent / "backups")
    conn = connect(db)
    try:
        res = migrate(conn, make_backup_hook(backup_dir), channel=args.channel)
    except MigrationError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(res)
    return 0


if __name__ == "__main__":
    sys.exit(main())
