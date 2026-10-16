"""Process runtime: config + lock + logging + migrated DB + backup service. Built once per server."""
from __future__ import annotations

import datetime as _dt
import json
import logging
import shutil
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from . import logsetup
from .audit import write_audit
from .backups import BackupService
from .config import Config
from .dbkit import migrate, open_db, transaction
from .errors import StartupRefused
from .locking import InstanceLock
from .reads import read_settings

log = logging.getLogger("tam.startup")


class Runtime:
    def __init__(self, config: Config, *, acquire_lock: bool = True,
                 clock: Optional[Callable[[], _dt.date]] = None,
                 tz: Optional[_dt.tzinfo] = None) -> None:
        self.config = config
        self.clock = clock or _dt.date.today
        self.tz = tz                      # None = workstation zone; tests inject a zone (DST days)
        self.backups = BackupService(config.backup_dir)
        self.lock = InstanceLock(config.lock_path)
        self.log_file: Optional[Path] = None
        self.startup_result: dict = {}
        self.bams: Any = None                     # server.bams.monitor.Monitor, attached by create_app
        from .portability.dbrestore import Gate      # lazy: keeps runtime import-light
        self.gate = Gate()                        # D-140 maintenance gate
        self.db_restore: Any = None               # staged whole-database restore (one at a time)
        self.restore_sessions: Any = None         # restore-from-file sessions
        self.import_sessions: Any = None          # server.importer.sessions.SessionStore, created on first use
        self._closed = False
        # D-18: lock BEFORE the DB is opened.
        config.data_dir.mkdir(parents=True, exist_ok=True)
        config.backup_dir.mkdir(parents=True, exist_ok=True)
        if acquire_lock:
            self.lock.acquire(config.port)
        try:
            self.log_file = logsetup.setup_logging(config.log_dir, "INFO")
            self._startup_db()
        except BaseException:
            self.close()
            raise

    # ------------------------------------------------------------ startup
    def _startup_db(self) -> None:
        cfg = self.config
        log.info("TAM Command Center %s starting: mode=%s channel=%s build_channel=%s port=%s",
                 cfg.version, cfg.mode, cfg.channel, cfg.build_channel, cfg.port)
        for note in cfg.notes:
            log.warning("startup: %s", note)
        log.info("database: %s (name: %s%s)", cfg.db_path, cfg.db_name, ", selected by TAM_DB_NAME" if cfg.named_db else ", default")
        from .portability.dbrestore import startup_recovery
        startup_recovery(cfg)                      # D-140: finish or undo a swap interrupted by a crash
        existed = cfg.db_path.exists() and cfg.db_path.stat().st_size > 0
        try:
            conn = open_db(cfg.db_path, channel=cfg.channel, rows=False)
        except migrate.MigrationError as exc:
            raise StartupRefused(f"Database refused: {exc}", exit_code=4) from exc
        try:
            try:
                result = migrate.migrate(conn, self.backups.hook, channel=cfg.channel)
            except migrate.MigrationError as exc:
                raise StartupRefused(f"Database refused: {exc}", exit_code=4) from exc
            fresh = not existed and result["from"] == 0
            if cfg.dev_seed and fresh and cfg.mode == "DEV":
                import seed_mock  # db/seed_mock.py; DEV only
                data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
                counts = seed_mock.load(conn, data, self.clock())
                log.info("DEV: new database seeded with mock data (%s)", counts)
            if result["applied"]:
                with transaction(conn):
                    write_audit(conn, category="system", object_type="schema", action="migrated",
                                object_id=str(result["to"]), label=f"schema {result['from']} -> {result['to']}",
                                new=result, source="Migration")
            from .bams.service import ensure_starters   # lazy: avoids an import cycle
            ensure_starters(conn)
            level = read_settings(conn)["log_level"]
            self.startup_result = result
        finally:
            conn.close()
        logsetup.set_level(level)
        log.info("schema migration result: %s", self.startup_result)
        log.info("startup complete (log level %s)", level)

    # ------------------------------------------------------------ helpers
    @contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        conn = open_db(self.config.db_path, channel=self.config.channel)
        try:
            yield conn
        finally:
            conn.close()

    def today(self) -> str:
        return self.clock().isoformat()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        shutil.rmtree(self.config.restore_tmp, ignore_errors=True)
        if self.bams is not None:
            self.bams.shutdown()
        self.lock.release()
        logsetup.teardown_logging()
