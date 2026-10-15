"""Database contract tests (data-architect-agent, Phase 1.2; extended for QA SCHEMA_REVIEW_1).

Run:  python -m unittest discover -s TAM_Command_Center/db/tests -v
 or:  pytest TAM_Command_Center/db/tests
Stdlib only; Python 3.9+. Every test builds its own throwaway DB.
"""
from __future__ import annotations

import datetime as dt
import codecs
import io
import json
import random
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path

DB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DB_DIR))
import migrate  # noqa: E402
import seed_mock  # noqa: E402
import sql_safety_scan  # noqa: E402
import warnings  # noqa: E402
from zoneinfo import ZoneInfo  # noqa: E402

warnings.filterwarnings("ignore", message=r"migrate\(channel=None\)")

NOW = "2026-10-12T14:05:00.123Z"


def fresh(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    migrate.migrate(conn, channel=None)
    return conn


def add_client(conn, cid="c1", name="Acme Mock Capital", status="Active"):
    conn.execute("INSERT INTO clients(id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)",
                 (cid, name, status, NOW, NOW))


class SchemaConstraints(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)

    def bad(self, sql, params=()):
        with self.assertRaises(sqlite3.IntegrityError, msg=sql):
            self.c.execute(sql, params)

    def test_integrity_and_fk_clean(self):
        self.assertEqual(self.c.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.c.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.c.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0], "1")
        self.assertEqual(self.c.execute("PRAGMA application_id").fetchone()[0], migrate.APPLICATION_ID)

    def test_one_primary_contact_per_account(self):
        ins = "INSERT INTO contacts(id,client_id,name,is_primary) VALUES (?,?,?,?)"
        self.c.execute(ins, ("p1", "c1", "A Person", 1))
        self.bad(ins, ("p2", "c1", "B Person", 1))                     # second primary rejected
        self.c.execute(ins, ("p2", "c1", "B Person", 0))
        # documented switch order: clear old, then set new (one transaction)
        self.c.execute("BEGIN")
        self.c.execute("UPDATE contacts SET is_primary=0 WHERE client_id='c1' AND is_primary=1")
        self.c.execute("UPDATE contacts SET is_primary=1 WHERE id='p2'")
        self.c.execute("COMMIT")
        self.assertEqual(self.c.execute("SELECT id FROM contacts WHERE is_primary=1").fetchall(), [("p2",)])
        self.c.execute("UPDATE contacts SET is_primary=0")                # zero primaries allowed
        add_client(self.c, "c2", "Other Mock Fund")
        self.c.execute(ins, ("p3", "c2", "C Person", 1))                 # other account independent
        self.c.execute("UPDATE contacts SET is_primary=1 WHERE id='p1'")

    def test_client_name_unique_case_insensitive_and_trimmed(self):
        self.bad("INSERT INTO clients(id,name) VALUES ('c9','ACME MOCK CAPITAL')")
        self.bad("INSERT INTO clients(id,name) VALUES ('c9',' Padded ')")
        self.bad("INSERT INTO clients(id,name) VALUES ('c9','')")

    def test_enums(self):
        self.bad("INSERT INTO clients(id,name,status) VALUES ('x','X','Dormant')")
        self.bad("INSERT INTO tasks(id,task,priority) VALUES ('t','T','Urgent')")
        self.bad("INSERT INTO tasks(id,task,status) VALUES ('t','T','Done')")
        self.bad("INSERT INTO tasks(id,task,category) VALUES ('t','T','Sales')")
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp,subject) VALUES ('n','c1','Email',?,'s')", (NOW,))
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp,subject,source) VALUES ('n','c1','Call Note',?,'s','API')", (NOW,))
        self.bad("INSERT INTO audit_events(category,object_type,action,source) VALUES ('crm','task','created','Robot')")
        self.bad("INSERT INTO audit_events(category,object_type,action,source) VALUES ('crm','widget','created','GUI')")
        self.bad("INSERT INTO audit_events(category,object_type,action,source) VALUES ('crm','task','Created!','GUI')")
        self.c.execute("INSERT INTO tasks(id,task) VALUES ('t','Defaults')")
        self.assertEqual(self.c.execute("SELECT category,priority,status,archived FROM tasks").fetchone(),
                         ("Other", "Medium", "Not Started", 0))

    def test_date_and_instant_formats(self):
        self.bad("INSERT INTO tasks(id,task,due) VALUES ('t','T','2026-02-30')")
        self.bad("INSERT INTO tasks(id,task,due) VALUES ('t','T','2026-10-1')")
        self.bad("INSERT INTO tasks(id,task,due) VALUES ('t','T','2026-10-12T00:00:00.000Z')")
        self.bad("INSERT INTO tasks(id,task,due) VALUES ('t','T','soon')")          # date() -> NULL must not pass
        self.bad("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('t','T','garbage','garbage')")
        self.bad("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('t','T',?,?)",
                 ("2026-02-30T10:00:00.000Z", "2026-02-30T10:00:00.000Z"))
        self.bad("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('t','T',?,?)",
                 ("2026-10-12T25:00:00.000Z", "2026-10-12T25:00:00.000Z"))
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp,subject) VALUES ('n','c1','Call Note','yesterday','s')")
        self.bad("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('t','T','2026-10-12 14:05:00','2026-10-12 14:05:00')")
        self.bad("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('t','T','2026-10-12T14:05:00Z','2026-10-12T14:05:00Z')")
        # updated_at < created_at is ALLOWED on purpose (QA-1-3: a clock step back must not fail edits)
        self.c.execute("INSERT INTO tasks(id,task,created_at,updated_at) VALUES ('skew','T',?, '2026-10-11T00:00:00.000Z')", (NOW,))
        self.c.execute("DELETE FROM tasks WHERE id='skew'")
        self.c.execute("INSERT INTO tasks(id,task,due) VALUES ('t','T','2028-02-29')")
        ts = self.c.execute("SELECT created_at FROM tasks").fetchone()[0]
        self.assertRegex(ts, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_note_needs_subject_or_body_and_limits(self):
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp) VALUES ('n','c1','General Note',?)", (NOW,))
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp,subject) VALUES ('n','c1','General Note',?,?)",
                 (NOW, "x" * 201))
        self.c.execute("INSERT INTO notes(id,client_id,note_type,timestamp,body) VALUES ('n','c1','General Note',?,'b')", (NOW,))

    def test_task_fk_and_nullable_account(self):
        self.c.execute("INSERT INTO tasks(id,task,client_id) VALUES ('t0','Internal',NULL)")
        self.bad("INSERT INTO tasks(id,task,client_id) VALUES ('t1','Orphan','nope')")

    def test_audit_append_only(self):
        self.c.execute("INSERT INTO audit_events(category,client_id,object_type,object_id,action,source) "
                       "VALUES ('crm','c1','task','t','created','GUI')")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("UPDATE audit_events SET action='deleted'")
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("DELETE FROM audit_events")
        self.c.execute("BEGIN")
        self.assertEqual(migrate.purge_audit_events(self.c), 1)
        self.c.execute("COMMIT")

    def test_upgrade_polarity_and_release_rules(self):
        ins = ("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,schedule_year,schedule_quarter) "
               "VALUES (?,?,?,?,?,?,?)")
        self.bad(ins, ("u1", "c1", "srv", "PROD", "DEV", None, None))
        self.bad(ins, ("u1", "c1", "srv", "DEV", "East", None, None))
        self.bad(ins, ("u1", "c1", "srv", "PROD", "East", 2026, None))     # half a release
        self.bad(ins, ("u1", "c1", "srv", "PROD", "East", 2026, "Q4"))     # unknown release (FK)
        self.c.execute("INSERT INTO quarterly_upgrade_windows(schedule_year,schedule_quarter) VALUES (2026,'Q4')")
        self.c.execute(ins, ("u1", "c1", "srv-a", "PROD", "East", 2026, "Q4"))
        self.bad(ins, ("u2", "c1", "SRV-A", "PROD", "West", 2026, "Q4"))   # identity Account+Server+Release (NOCASE)
        self.c.execute(ins, ("u3", "c1", "srv-d", "DEV", "DEV", None, None))  # ad-hoc allowed
        with self.assertRaises(sqlite3.IntegrityError):                    # §20 never wipe schedule under upgrades
            self.c.execute("DELETE FROM quarterly_upgrade_windows")

    def test_bams_lifecycle(self):
        c = self.c
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','srv')")
        self.bad("INSERT INTO bams_objects(id,client_id,name) VALUES ('o2','c1','SRV')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.T.CPU')")
        self.bad("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,severity) VALUES ('r','m','fixed_threshold','>','Warning')")
        self.bad("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) VALUES ('r','m','pct_of_high','>',90,'Warning')")
        c.execute("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) VALUES ('r','m','fixed_threshold','>',85,'Warning')")
        ev = "INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at,status,recovered_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?)"
        self.bad(ev, ("e0", "m", "r", "fixed_threshold", "Warning", NOW, "recovered", None, None))
        self.bad(ev, ("e0", "m", "r", "stale", "Warning", NOW, "open", None, None))  # stale has no rule
        c.execute(ev, ("e1", "m", "r", "fixed_threshold", "Warning", NOW, "open", None, None))
        self.bad(ev, ("e2", "m", "r", "fixed_threshold", "Warning", NOW, "open", None, None))  # duplicate active
        c.execute("UPDATE bams_alert_events SET status='closed', closed_at=? WHERE id='e1'", (NOW,))
        c.execute(ev, ("e2", "m", "r", "fixed_threshold", "Warning", NOW, "open", None, None))  # new after close
        c.execute(ev, ("e3", "m", None, "stale", "Warning", NOW, "open", None, None))
        self.bad(ev, ("e4", "m", None, "stale", "Warning", NOW, "open", None, None))  # one active stale per metric
        self.bad(ev, ("e5", "m", "r", "fixed_threshold", "Warning", NOW, "closed", None, "2026-10-01T00:00:00.000Z"))

    def test_account_delete_cascades_but_audit_survives(self):
        c = self.c
        c.execute("INSERT INTO contacts(id,client_id,name) VALUES ('p','c1','P')")
        c.execute("INSERT INTO tasks(id,task,client_id) VALUES ('t','T','c1')")
        c.execute("INSERT INTO notes(id,client_id,note_type,timestamp,subject) VALUES ('n','c1','Call Note',?,'s')", (NOW,))
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity) VALUES ('u','c1','s','DEV','DEV')")
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.X')")
        c.execute("INSERT INTO bams_alert_events(id,metric_id,alert_type,severity,opened_at) VALUES ('e','m','stale','Info',?)", (NOW,))
        c.execute("INSERT INTO bams_notification_log(event_id,kind,channel,attempted_at,success) VALUES ('e','opened','in_app',?,1)", (NOW,))
        c.execute("INSERT INTO audit_events(category,client_id,object_type,object_id,action,source) VALUES ('crm','c1','client','c1','created','GUI')")
        c.execute("DELETE FROM clients WHERE id='c1'")
        for t in ("contacts", "tasks", "notes", "server_upgrades", "bams_objects", "bams_metrics",
                  "bams_alert_events", "bams_notification_log"):
            self.assertEqual(c.execute(f"SELECT count(*) FROM {t}").fetchone()[0], 0, t)
        self.assertEqual(c.execute("SELECT count(*) FROM audit_events WHERE client_id='c1'").fetchone()[0], 1)
        self.assertEqual(c.execute("PRAGMA foreign_key_check").fetchall(), [])


class MigrationContract(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / "t.db"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_schema_sql_equals_migration_chain(self):
        with redirect_stdout(io.StringIO()):
            self.assertTrue(migrate.verify_schema())

    def test_fresh_then_rerun_is_noop(self):
        conn = migrate.connect(self.db)
        self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        r1 = migrate.migrate(conn, channel=None)
        self.assertEqual((r1["from"], r1["to"], r1["applied"], r1["backup"]), (0, 1, ["0001_initial.sql"], None))
        before = conn.execute("SELECT key, value FROM app_meta ORDER BY key").fetchall()
        calls = []
        r2 = migrate.migrate(conn, backup_hook=lambda c, why: calls.append(why), channel=None)
        self.assertEqual((r2["from"], r2["to"], r2["applied"]), (1, 1, []))
        self.assertEqual(calls, [])  # no backup when nothing is pending
        self.assertEqual(conn.execute("SELECT key, value FROM app_meta ORDER BY key").fetchall(), before)
        # executing 0001 directly a second time is also harmless (IF NOT EXISTS / guarded upsert)
        conn.executescript((migrate.MIGRATIONS_DIR / "0001_initial.sql").read_text())
        self.assertEqual(conn.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0], "1")

    def _with_extra_migration(self, body: str) -> Path:
        mdir = self.tmp / "migrations"
        mdir.mkdir()
        shutil.copy(migrate.MIGRATIONS_DIR / "0001_initial.sql", mdir)
        (mdir / "0002_test.sql").write_text(body)
        return mdir

    def test_existing_db_backup_hook_contract(self):
        conn = migrate.connect(self.db)
        migrate.migrate(conn, channel=None)
        add_client(conn)
        orig = migrate.MIGRATIONS_DIR
        try:
            migrate.MIGRATIONS_DIR = self._with_extra_migration(
                "CREATE INDEX IF NOT EXISTS ix_test ON tasks(updated_at);\n"
                "UPDATE app_meta SET value='2' WHERE key='schema_version';\n")
            with self.assertRaises(migrate.MigrationError):           # no hook -> refuse
                migrate.migrate(conn, channel=None)

            def failing(c, why):
                raise OSError("disk full")
            with self.assertRaises(OSError):                          # failing backup -> abort, untouched
                migrate.migrate(conn, failing, channel=None)
            self.assertEqual(migrate.current_version(conn), 1)
            res = migrate.migrate(conn, migrate.make_backup_hook(self.tmp / "backups"), channel=None)
            self.assertEqual((res["from"], res["to"]), (1, 2))
            b = sqlite3.connect(res["backup"])
            self.assertEqual(b.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(b.execute("SELECT value FROM app_meta WHERE key='schema_version'").fetchone()[0], "1")
            self.assertEqual(b.execute("SELECT count(*) FROM clients").fetchone()[0], 1)
            b.close()
        finally:
            migrate.MIGRATIONS_DIR = orig

    def test_failing_migration_rolls_back(self):
        conn = migrate.connect(self.db)
        migrate.migrate(conn, channel=None)
        orig = migrate.MIGRATIONS_DIR
        try:
            migrate.MIGRATIONS_DIR = self._with_extra_migration(
                "CREATE TABLE half_done(x);\nINSERT INTO nope VALUES (1);\n"
                "UPDATE app_meta SET value='2' WHERE key='schema_version';\n")
            with self.assertRaises(sqlite3.OperationalError):
                migrate.migrate(conn, lambda c, why: self.tmp / "unused", channel=None)
            self.assertEqual(migrate.current_version(conn), 1)
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE name='half_done'").fetchone())
        finally:
            migrate.MIGRATIONS_DIR = orig

    def test_refuses_newer_and_foreign_db(self):
        conn = migrate.connect(self.db)
        migrate.migrate(conn, channel=None)
        conn.execute("UPDATE app_meta SET value='99' WHERE key='schema_version'")
        with self.assertRaisesRegex(migrate.MigrationError, "newer"):
            migrate.migrate(conn, channel=None)
        other = sqlite3.connect(str(self.tmp / "foreign.db"), isolation_level=None)
        other.execute("CREATE TABLE stuff(x)")
        with self.assertRaisesRegex(migrate.MigrationError, "not a TAM"):
            migrate.migrate(other, channel=None)

    def test_online_backup_under_concurrent_wal_writes(self):
        conn = migrate.connect(self.db)
        migrate.migrate(conn, channel=None)
        add_client(conn)
        stop = threading.Event()
        written = []

        def writer():
            w = migrate.connect(self.db)
            i = 0
            while not stop.is_set() and i < 3000:
                w.execute("INSERT INTO tasks(id,task,client_id) VALUES (?,?, 'c1')", (f"t{i}", f"task {i}"))
                written.append(i)
                i += 1
            w.close()
        th = threading.Thread(target=writer)
        th.start()
        deadline = dt.datetime.now() + dt.timedelta(seconds=30)
        while len(written) < 200:
            self.assertTrue(th.is_alive() and dt.datetime.now() < deadline, "writer thread died or stalled")
            threading.Event().wait(0.001)
        committed_before = len(written)
        dest = migrate.online_backup(migrate.connect(self.db), self.tmp / "b" / "snap.db")
        stop.set()
        th.join()
        b = sqlite3.connect(str(dest))
        self.assertEqual(b.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertGreaterEqual(b.execute("SELECT count(*) FROM tasks").fetchone()[0], committed_before)
        self.assertEqual(b.execute("PRAGMA foreign_key_check").fetchall(), [])


class MockSeed(unittest.TestCase):
    def test_generate_is_deterministic(self):
        a = json.dumps(seed_mock.Gen().build(), sort_keys=True)
        b = json.dumps(seed_mock.Gen().build(), sort_keys=True)
        self.assertEqual(a, b)

    def test_committed_json_matches_generator(self):
        on_disk = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        self.assertEqual(on_disk, json.loads(json.dumps(seed_mock.Gen().build())),
                         "mock_data.json is stale: run `python db/seed_mock.py generate`")

    def test_load_and_verify_for_several_todays(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        for today in (dt.date(2026, 10, 12), dt.date(2027, 3, 3), dt.date(2026, 12, 31), dt.date(2030, 2, 28)):
            with self.subTest(today=today):
                conn = sqlite3.connect(":memory:", isolation_level=None)
                conn.execute("PRAGMA foreign_keys = ON")
                seed_mock.load(conn, data, today)
                with redirect_stdout(io.StringIO()) as out:
                    ok = seed_mock.verify(conn, today)
                self.assertTrue(ok, out.getvalue())

    def test_reference_queries(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        seed_mock.load(conn, data, dt.date(2026, 10, 12))
        conn.row_factory = sqlite3.Row
        q = lambda f: (DB_DIR / "queries" / f).read_text(encoding="utf-8")  # noqa: E731
        cid = conn.execute("SELECT id FROM clients WHERE name LIKE 'Northwind%'").fetchone()[0]
        base = dict(client_id=cid, q_like=None, before_ts=None, before_key=None, limit=100)
        expected = {"meeting": {"Meeting Note"}, "call": {"Call Note"}, "general": {"General Note"}}
        for f, types in expected.items():
            rows = conn.execute(q("activity_timeline.sql"), dict(base, filter=f)).fetchall()
            self.assertTrue(rows)
            self.assertEqual({r["event_type"] for r in rows}, types)
        sysrows = conn.execute(q("activity_timeline.sql"), dict(base, filter="system")).fetchall()
        self.assertTrue(sysrows and all(r["entry_kind"] == "system" for r in sysrows))
        self.assertIn("contact.primary_changed", {r["event_type"] for r in sysrows})
        self.assertIn("note.deleted", {r["event_type"] for r in sysrows})
        p1 = conn.execute(q("activity_timeline.sql"), dict(base, filter="all", limit=50)).fetchall()
        p2 = conn.execute(q("activity_timeline.sql"), dict(base, filter="all", limit=50,
                                                            before_ts=p1[-1]["ts"], before_key=p1[-1]["entry_key"])).fetchall()
        self.assertEqual(len(p1), 50)
        self.assertFalse({r["entry_key"] for r in p1} & {r["entry_key"] for r in p2})
        rc = conn.execute(q("recent_changes.sql"), {"limit": 20}).fetchall()
        self.assertEqual(len(rc), 20)
        self.assertTrue(all(r["client_id"] for r in rc))
        summ = conn.execute(q("account_summary.sql"), {"today": "2026-10-12", "status": "Active"}).fetchall()
        self.assertEqual(len(summ), 10)
        nwh = next(r for r in summ if r["id"] == cid)
        self.assertEqual(nwh["servers"], 4)  # BAMS 'NWH-BPIPE-NY-01' == upgrade 'nwh-bpipe-ny-01'

    def test_reset_reload(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        first = seed_mock.load(conn, data, dt.date(2026, 10, 12))
        with self.assertRaises(seed_mock.SeedRefused):
            seed_mock.load(conn, data, dt.date(2026, 10, 12))
        second = seed_mock.load(conn, data, dt.date(2026, 10, 12), reset=True)
        self.assertEqual(first, second)
        self.assertEqual(conn.execute("SELECT count(*) FROM audit_events").fetchone()[0], first["audit_events"])



# =============================================================================
# QA SCHEMA_REVIEW_1 regression tests (one class per finding)
# =============================================================================

def audit_row(conn, aid=None, label="t"):
    conn.execute("INSERT INTO audit_events(id,category,client_id,object_type,object_id,object_label,action,source) "
                 "VALUES (?,'crm','c1','task','t',?,'created','GUI')", (aid, label))


class QA_1_1_AuditReplace(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)
        audit_row(self.c, label="original")

    def test_replace_and_insert_or_replace_are_refused(self):
        for sql in ("INSERT OR REPLACE INTO audit_events(id,category,object_type,action,source,new_value) "
                    "VALUES (1,'crm','task','created','GUI','{\"task\":\"FORGED\"}')",
                    "REPLACE INTO audit_events(id,category,object_type,action,source) VALUES (1,'crm','task','deleted','GUI')"):
            with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
                self.c.execute(sql)
        self.assertEqual(self.c.execute("SELECT id, action, object_label, new_value FROM audit_events").fetchall(),
                         [(1, "created", "original", None)])

    def test_upsert_update_path_also_refused_and_normal_inserts_work(self):
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("INSERT INTO audit_events(id,category,object_type,action,source) VALUES (1,'crm','task','x','GUI') "
                           "ON CONFLICT(id) DO UPDATE SET action='forged'")
        audit_row(self.c)            # autoincrement id
        audit_row(self.c, aid=50)    # explicit new id is fine
        self.assertEqual(self.c.execute("SELECT count(*) FROM audit_events").fetchone()[0], 3)


class QA_1_2_and_2_1_2_2_ReplaceDesign(unittest.TestCase):
    """REPLACE ban (QA-1-2, QA-2-2) without breaking legitimate upserts (QA-2-1). See 03 §2.1."""

    def setUp(self):
        c = self.c = fresh()
        add_client(c)
        c.execute("INSERT INTO contacts(id,client_id,name,is_primary) VALUES ('a','c1','A',0),('b','c1','B',1)")
        c.execute("INSERT INTO tasks(id,task,client_id) VALUES ('t','T','c1')")
        c.execute("INSERT INTO quarterly_upgrade_windows(schedule_year,schedule_quarter) VALUES (2026,'Q4'),(2027,'Q1')")
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,schedule_year,schedule_quarter,current_version) "
                  "VALUES ('u1','c1','srv','PROD','East',2026,'Q4','7.1.4'),('u1b','c1','srv','PROD','East',2027,'Q1','7.2.0')")
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,scheduled_date) "
                  "VALUES ('u2','c1','adhoc','PROD','East','2026-11-01'),('u3','c1','adhoc','PROD','East','2026-12-01')")
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','obj'),('o2','c1','obj2')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.T'),('m2','o','MEM','MOCK.U')")
        c.execute("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) VALUES ('r','m','fixed_threshold','>',1,'Info')")
        c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at) VALUES ('e','m','r','fixed_threshold','Info',?)", (NOW,))
        c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at,status,closed_at) "
                  "VALUES ('e_old','m','r','fixed_threshold','Info',?,'closed',?)", (NOW, NOW))
        c.execute("INSERT INTO bams_alert_configs(id,name,metric_match,rule_type,operator,threshold,severity) "
                  "VALUES ('k','Cfg','CPU*','fixed_threshold','>',1,'Info'),('k2','Other','x','fixed_threshold','>',1,'Info')")
        c.execute("INSERT INTO bams_notification_log(event_id,kind,channel,attempted_at,success) VALUES "
                  "('e','opened','in_app',?,1),('e','opened','desktop',?,1)", (NOW, NOW))

    def counts(self):
        return {t: self.c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in seed_mock.TABLE_ORDER}

    # ---------------- QA-2-1: legitimate natural-key idioms work natively
    def test_2_1_section25_reimport_upsert_and_do_nothing(self):
        c = self.c
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,schedule_year,schedule_quarter,current_version) "
                  "VALUES ('new','c1','SRV','PROD','East',2026,'Q4','7.1.9') "
                  "ON CONFLICT(client_id,server_name,schedule_year,schedule_quarter) DO UPDATE SET current_version=excluded.current_version")
        self.assertEqual(c.execute("SELECT id, current_version, row_version FROM server_upgrades WHERE schedule_year=2026").fetchall(),
                         [("u1", "7.1.9", 2)])
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,schedule_year,schedule_quarter) "
                  "VALUES ('new2','c1','srv','PROD','East',2026,'Q4') ON CONFLICT DO NOTHING")
        c.execute("INSERT OR IGNORE INTO server_upgrades(id,client_id,server_name,environment,polarity,scheduled_date) "
                  "VALUES ('new3','c1','ADHOC','PROD','East','2026-11-01')")
        self.assertEqual(c.execute("SELECT count(*) FROM server_upgrades").fetchone()[0], 4)

    def test_2_1_notification_insert_once(self):
        c = self.c
        c.execute("INSERT INTO bams_notification_log(event_id,kind,channel,attempted_at,success) "
                  "VALUES ('e','opened','in_app',?,0) ON CONFLICT(event_id,kind,channel) DO NOTHING", (NOW,))
        c.execute("INSERT OR IGNORE INTO bams_notification_log(event_id,kind,channel,attempted_at,success) "
                  "VALUES ('e','opened','desktop',?,0)", (NOW,))
        self.assertEqual(c.execute("SELECT count(*), sum(success) FROM bams_notification_log").fetchone(), (2, 2))

    def test_2_1_name_and_ticker_upserts(self):
        c = self.c
        c.execute("INSERT INTO clients(id,name,notes) VALUES ('cX','ACME MOCK CAPITAL','imported') "
                  "ON CONFLICT(name) DO UPDATE SET notes=excluded.notes")
        self.assertEqual(c.execute("SELECT id, notes FROM clients").fetchall(), [("c1", "imported")])
        c.execute("INSERT OR IGNORE INTO clients(id,name) VALUES ('cY','acme mock capital')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker,current_value) VALUES ('mX','o','CPU','MOCK.T',42) "
                  "ON CONFLICT(ticker) DO UPDATE SET current_value=excluded.current_value")
        c.execute("INSERT OR IGNORE INTO bams_objects(id,client_id,name) VALUES ('oX','c1','OBJ')")
        c.execute("INSERT INTO bams_alert_configs(id,name,metric_match,rule_type,operator,threshold,severity) "
                  "VALUES ('kX','CFG','CPU*','fixed_threshold','>',2,'Info') ON CONFLICT(name) DO UPDATE SET threshold=excluded.threshold")
        # §27 "repeated breach updates the open event": upsert on the partial expression index
        c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at,last_triggered_at) "
                  "VALUES ('eX','m','r','fixed_threshold','Info',?,?) "
                  "ON CONFLICT(metric_id, coalesce(rule_id,'')) WHERE status <> 'closed' "
                  "DO UPDATE SET last_triggered_at=excluded.last_triggered_at", (NOW, NOW))
        self.assertEqual(c.execute("SELECT current_value FROM bams_metrics WHERE id='m'").fetchone(), (42.0,))
        self.assertEqual(c.execute("SELECT threshold FROM bams_alert_configs WHERE id='k'").fetchone(), (2.0,))
        self.assertEqual(c.execute("SELECT count(*) FROM bams_alert_events WHERE status<>'closed'").fetchone(), (1,))
        self.assertEqual(c.execute("SELECT count(*) FROM bams_objects").fetchone(), (2,))

    def test_2_1_duplicate_error_text_contract(self):
        c = self.c
        for sql in ("INSERT INTO clients(id,name) VALUES ('c2','Acme Mock Capital')",
                    "INSERT INTO contacts(id,client_id,name,is_primary) VALUES ('z','c1','Z',1)"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, r"^UNIQUE constraint failed: (clients|contacts)\b"):
                c.execute(sql)
        add_client(c, "c2", "Other Fund")
        with self.assertRaisesRegex(sqlite3.IntegrityError, r"^UNIQUE constraint failed: clients\.name"):
            c.execute("UPDATE clients SET name='acme mock capital' WHERE id='c2'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, r"^UNIQUE constraint failed: contacts\.client_id"):
            c.execute("UPDATE contacts SET is_primary=1 WHERE id='a'")

    # ---------------- QA-2-2: UPDATE OR REPLACE / id changes blocked, nothing deleted
    def test_2_2_update_or_replace_is_blocked_everywhere(self):
        c = self.c
        add_client(c, "c3", "Gamma")
        c.execute("INSERT INTO tasks(id,task,client_id) VALUES ('t3','T3','c3')")
        cases = [
            "UPDATE OR REPLACE contacts SET is_primary=1 WHERE id='a'",
            "UPDATE OR REPLACE clients SET name='GAMMA' WHERE id='c1'",
            "UPDATE OR REPLACE server_upgrades SET schedule_year=2027, schedule_quarter='Q1' WHERE id='u1'",
            "UPDATE OR REPLACE server_upgrades SET scheduled_date='2026-12-01' WHERE id='u2'",
            "UPDATE OR REPLACE bams_objects SET name='OBJ2' WHERE id='o'",
            "UPDATE OR REPLACE bams_metrics SET ticker='MOCK.U' WHERE id='m'",
            "UPDATE OR REPLACE bams_metrics SET metric_name='MEM' WHERE id='m'",
            "UPDATE OR REPLACE bams_alert_events SET status='open', closed_at=NULL WHERE id='e_old'",
            "UPDATE OR REPLACE bams_alert_configs SET name='other' WHERE id='k'",
            "UPDATE OR REPLACE bams_notification_log SET channel='desktop' WHERE channel='in_app'",
            "UPDATE OR REPLACE quarterly_upgrade_windows SET schedule_year=2027, schedule_quarter='Q1' WHERE schedule_year=2026",
            "UPDATE OR REPLACE clients SET id='c3' WHERE id='c1'",
            "UPDATE OR REPLACE tasks SET id='t3' WHERE id='t'",
            "UPDATE OR REPLACE contacts SET id='b' WHERE id='a'",
        ]
        before = self.counts()
        for sql in cases:
            with self.assertRaises(sqlite3.IntegrityError, msg=sql):
                c.execute(sql)
        self.assertEqual(self.counts(), before)
        self.assertEqual(c.execute("SELECT id FROM contacts WHERE is_primary=1").fetchall(), [("b",)])

    def test_2_2_id_immutable_on_all_entity_tables(self):
        names = {r[0] for r in self.c.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
        for t in ["clients", "contacts", "tasks", "notes", "support_cases", "server_upgrades", "bams_objects",
                  "bams_metrics", "bams_alert_rules", "bams_alert_events", "bams_alert_configs",
                  "bams_metric_samples", "bams_notification_log"]:
            self.assertIn(f"trg_{t}_id_immutable", names)

    def test_insert_side_pk_and_secondary_replace_hazard_is_real(self):
        """Why the scan exists: INSERT-side REPLACE cannot be trigger-blocked without breaking
        ON CONFLICT DO UPDATE / DO NOTHING / INSERT OR IGNORE (QA-2-1), and it destroys data."""
        c = self.c
        c.execute("INSERT OR REPLACE INTO clients(id,name,notes) VALUES ('c1','Acme Mock Capital','edited')")
        self.assertEqual(c.execute("SELECT count(*) FROM tasks").fetchone()[0], 0)       # children cascaded away
        # the one INSERT-side guard that stays: no keyed upsert of a primary contact is ever legitimate
        add_client(c, "c9", "Nine")
        c.execute("INSERT INTO contacts(id,client_id,name,is_primary) VALUES ('p9','c9','P',1)")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "UNIQUE constraint failed: contacts.client_id"):
            c.execute("INSERT OR REPLACE INTO contacts(id,client_id,name,is_primary) VALUES ('q9','c9','Q',1)")

    # ---------------- QA-2-2: the scanner
    POSITIVE = [
        (".py", 'conn.execute("INSERT OR REPLACE INTO clients VALUES (?)")'),
        (".py", 'conn.execute("insert   or\n   replace into clients VALUES (?)")'),
        (".py", 'conn.execute("INSERT OR "\n             "REPLACE INTO t VALUES (1)")'),
        (".py", 'sql = "UPDATE OR " + "REPLACE contacts SET is_primary=1"'),
        (".py", 'q = "REPLACE INTO t(a) VALUES (1)"'),
        (".py", "stmt = insert(t).prefix_with('OR REPLACE')"),
        (".py", 'stmt = insert(t).prefix_with("OR", "REPLACE")'),
        (".py", "Column('n', String, unique=True, sqlite_on_conflict_unique='REPLACE')"),
        (".sql", "CREATE TABLE x (a TEXT UNIQUE ON CONFLICT REPLACE);"),
        (".sql", "INSERT\nOR\nREPLACE INTO x VALUES (1);"),
        (".ts", "db.run(`UPDATE OR REPLACE t SET a = 1`)"),
        (".mjs", "db.exec('REPLACE INTO t VALUES (1)')"),
        (".cjs", "db.exec('INSERT OR REPLACE INTO t VALUES (1)')"),
        # review 3 (QA-3-1): comment markers inside strings, ORMs, pandas, escapes
        (".py", 'x = "a #b"; c.execute("REPLACE INTO t VALUES(1)")'),
        (".sql", "INSERT INTO t VALUES('--'); REPLACE INTO t VALUES(2);"),
        (".ts", 'const u = "a //b"; db.run("REPLACE INTO t VALUES (1)")'),
        (".py", "stmt = insert(t).prefix_with(text('OR REPLACE'))"),
        (".py", "Model.insert(**row).on_conflict_replace().execute()"),
        (".py", "Model.insert(**row).on_conflict('replace').execute()"),
        (".py", "Model.insert(**row).on_conflict(action='REPLACE').execute()"),
        (".py", "df.to_sql('clients', conn, if_exists='replace')"),
        (".py", 'q = "UPDATE OR\\nREPLACE contacts SET a=1"'),
        (".py", 'q = "UPDATE OR \\\nREPLACE contacts SET a=1"'),
        (".pyw", 'c.execute("INSERT OR REPLACE INTO clients VALUES (?)")'),
        (".py", '"""\nSQL = "INSERT OR REPLACE INTO t VALUES (1)"\n"""'),
    ]
    NEGATIVE = [
        (".py", "name = raw.replace('a', 'b')"),
        (".py", "# never use INSERT OR REPLACE INTO t VALUES (1) here"),
        (".py", 'c.execute("INSERT INTO t VALUES (1) ON CONFLICT(id) DO UPDATE SET a=1")'),
        (".py", 'c.execute("INSERT OR IGNORE INTO t VALUES (1)")'),
        (".sql", "-- REPLACE INTO t VALUES (1) is banned\nINSERT INTO t VALUES (1) ON CONFLICT DO NOTHING;"),
        (".sql", "/* UPDATE OR REPLACE t SET a=1 */ SELECT replace(name, 'a', 'b') FROM t;"),
        (".ts", "// INSERT OR REPLACE INTO t VALUES (1)\nconst label = 'Edit or replace the file';"),
        (".tsx", "<p>Upload or replace your logo</p>"),
        # review 3 (QA-3-2): legitimate code that tripped the old scanner
        (".sql", "SELECT id FROM clients WHERE bpid = ? OR replace(name, ' ', '') = ?;"),
        (".py", 'q = q.replace("INTO", "INTO main.")'),
        (".ts", "const s = label.replace(' into ', ' ');"),
        (".tsx", "<Button>Replace into template</Button>"),
        (".tsx", "<p>Update or replace your logo</p>"),
        (".py", '"""Never use INSERT OR REPLACE here; use ON CONFLICT DO UPDATE."""'),
        (".py", "df.to_sql('staging_import', conn, if_exists='append')"),
        (".py", 'EXAMPLE = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow (doc example)'),
    ]

    def test_2_2_scanner_catches_every_spelling(self):
        for suffix, text in self.POSITIVE:
            self.assertTrue(sql_safety_scan.find_violations(text, suffix), f"missed {suffix}: {text!r}")
        for suffix, text in self.NEGATIVE:
            self.assertEqual(sql_safety_scan.find_violations(text, suffix), [], f"false positive {suffix}: {text!r}")

    def test_2_2_scanner_scans_files_and_suffixes(self):
        tmp = Path(tempfile.mkdtemp())
        bad = 'SQL = ("INSERT OR "\n       "REPLACE INTO clients VALUES (?)")\n'
        try:
            files = {
                "server/repo.py": bad,                          # scanned
                "server/ok.py": 'SQL = "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING"\n',
                "server/web/routes.py": bad,                    # QA-3-1a: nested 'web' IS scanned
                "server/api/tests/fixtures.py": bad,            # QA-3-1a: nested 'tests' IS scanned
                "server/legacy.pyw": bad,                       # QA-3-1a: .pyw scanned
                "server/build/dist/x.py": bad,                  # nested 'dist' IS scanned
                "x.mjs": "db.exec('UPDATE OR REPLACE t SET a=1')\n",
                "web/assets/app.js": "db.exec('REPLACE INTO t VALUES (1)')\n",          # top-level web/: skipped
                "frontend/dist/app.js": "db.exec('REPLACE INTO t VALUES (1)')\n",       # build output: skipped
                "db/tests/test_x.py": bad,                                               # anchored db/tests: skipped
                "frontend/node_modules/dep/index.js": "db.exec('REPLACE INTO t VALUES (1)')\n",  # vendor: skipped
                "server/allowed.py": 'X = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow (example)\n',
            }
            for rel, body in files.items():
                f = tmp / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(body)
            found = sorted({f.split(":")[0] for f in sql_safety_scan.scan(tmp)})
            self.assertEqual(found, ["server/api/tests/fixtures.py", "server/build/dist/x.py",
                                     "server/legacy.pyw", "server/repo.py", "server/web/routes.py", "x.mjs"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_3_1_line_numbers_and_allow_marker_on_later_lines(self):
        text = ('import x\n'
                '# a comment line\n'
                'A = "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING"\n'
                'B = "INSERT OR REPLACE INTO t VALUES (1)"\n'
                'C = "REPLACE INTO t VALUES (2)"  # sql-safety: allow (documented example)\n'
                'D = ("UPDATE OR "\n'
                '     "REPLACE t SET a = 1")\n')
        hits = sql_safety_scan.find_violations(text, ".py")
        self.assertEqual([h.split(":")[0] for h in hits], ["line 4", "line 6"])
        sql = "SELECT 1;\n-- REPLACE INTO t VALUES (1)\n/* multi\nline */\nREPLACE INTO t VALUES (2);\n"
        self.assertEqual([h.split(":")[0] for h in sql_safety_scan.find_violations(sql, ".sql")], ["line 5"])

    def test_2_2_codebase_contains_no_replace(self):
        """QA 3.2 grep, automated: covers db/ now and server/ + frontend/ once they exist."""
        self.assertEqual(sql_safety_scan.scan(DB_DIR.parent), [])


class QA_1_3_RowVersion(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)

    def rv(self):
        return self.c.execute("SELECT row_version FROM clients WHERE id='c1'").fetchone()[0]

    def test_every_update_advances_by_exactly_one(self):
        self.assertEqual(self.rv(), 1)
        self.c.execute("UPDATE clients SET notes='a' WHERE id='c1'")                         # app forgot the token
        self.assertEqual(self.rv(), 2)
        self.c.execute("UPDATE clients SET notes='b', row_version=row_version+1 WHERE id='c1'")  # explicit bump
        self.assertEqual(self.rv(), 3)
        for bad in (3 + 5, 1):
            with self.assertRaisesRegex(sqlite3.DatabaseError, "advance by 1"):
                self.c.execute("UPDATE clients SET row_version=? WHERE id='c1'", (bad,))
        self.assertEqual(self.rv(), 3)

    def test_optimistic_concurrency_two_writers(self):
        expected = self.rv()
        sql = "UPDATE clients SET notes=? WHERE id='c1' AND row_version=?"
        first = self.c.execute(sql, ("writer A", expected)).rowcount
        second = self.c.execute(sql, ("writer B", expected)).rowcount   # stale token
        self.assertEqual((first, second), (1, 0))                        # backend: 0 -> 409 stale_write
        self.assertEqual(self.c.execute("SELECT notes FROM clients").fetchone()[0], "writer A")

    def test_clock_step_back_does_not_break_edits(self):
        self.c.execute("UPDATE clients SET notes='x', updated_at='2020-01-01T00:00:00.000Z' WHERE id='c1'")
        self.assertEqual(self.rv(), 2)

    def test_all_editable_tables_have_the_triggers(self):
        names = {r[0] for r in self.c.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
        for t in seed_mock.ROW_VERSION_TABLES:
            self.assertIn(f"trg_{t}_row_version_bump", names)
            self.assertIn(f"trg_{t}_row_version_guard", names)
            cols = [r[1] for r in self.c.execute(f"PRAGMA table_info({t})")]
            self.assertIn("row_version", cols)

    def test_fk_set_null_bumps_without_error(self):
        c = self.c
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.X')")
        c.execute("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) VALUES ('r','m','fixed_threshold','>',1,'Info')")
        c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at,status,closed_at) "
                  "VALUES ('e','m','r','fixed_threshold','Info',?, 'closed', ?)", (NOW, NOW))
        c.execute("DELETE FROM bams_alert_rules WHERE id='r'")
        self.assertEqual(c.execute("SELECT rule_id, row_version FROM bams_alert_events").fetchone(), (None, 2))


class QA_1_4_AuditPurge(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)
        audit_row(self.c)

    def test_persistent_flag_no_longer_enables_deletes(self):
        self.c.execute("INSERT INTO app_meta VALUES ('maintenance.audit_purge_allowed','1')")   # autocommit
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("DELETE FROM audit_events")

    def test_purge_requires_a_transaction(self):
        with self.assertRaises(migrate.MigrationError):
            migrate.purge_audit_events(self.c)

    def test_purge_rollback_restores_rows_and_guard(self):
        self.c.execute("BEGIN")
        self.assertEqual(migrate.purge_audit_events(self.c), 1)
        self.c.execute("ROLLBACK")
        self.assertEqual(self.c.execute("SELECT count(*) FROM audit_events").fetchone()[0], 1)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("DELETE FROM audit_events")

    def test_purge_commit_leaves_guard_in_place(self):
        self.c.execute("BEGIN")
        migrate.purge_audit_events(self.c)
        self.c.execute("COMMIT")
        audit_row(self.c)
        with self.assertRaisesRegex(sqlite3.DatabaseError, "append-only"):
            self.c.execute("DELETE FROM audit_events")
        migrate.assert_guards(self.c)

    def test_missing_guard_is_refused_on_open(self):
        self.c.execute("DROP TRIGGER trg_audit_events_no_delete")   # e.g. a crashed autocommit job
        with self.assertRaisesRegex(migrate.MigrationError, "guard triggers missing"):
            migrate.migrate(self.c, channel=None)


class QA_1_5_BamsFreshness(unittest.TestCase):
    def test_states_survive_any_load_time(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        for now in (dt.datetime(2026, 10, 12, 0, 0, 1), dt.datetime(2027, 3, 3, 23, 59, 59)):
            with self.subTest(now=now):
                conn = sqlite3.connect(":memory:", isolation_level=None)
                conn.execute("PRAGMA foreign_keys = ON")
                seed_mock.load(conn, data, now.date(), now=now)
                n = seed_mock.fmt_instant(now)
                ages = [None if r[0] is None else
                        (seed_mock.parse_instant(n) - seed_mock.parse_instant(r[0])).total_seconds()
                        for r in conn.execute("SELECT last_received FROM bams_metrics")]
                states = {"nodata" if a is None else "live" if a <= 75 else "delayed" if a <= 120 else "stale"
                          for a in ages}
                self.assertEqual(states, {"live", "delayed", "stale", "nodata"})
                self.assertTrue(all(a is None or a >= 0 for a in ages))
                nd = conn.execute("SELECT count(*) FROM bams_metrics WHERE last_received IS NULL "
                                  "AND current_value IS NULL AND high_30 IS NULL").fetchone()[0]
                self.assertGreaterEqual(nd, 1)


class QA_Lows(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def bad(self, sql, params=()):
        with self.assertRaises(sqlite3.DatabaseError, msg=sql):
            self.c.execute(sql, params)

    def _bams(self):
        c = self.c
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.X')")
        c.execute("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) VALUES ('r','m','fixed_threshold','>',1,'Warning')")

    def test_1_6_closed_not_before_recovered(self):
        self._bams()
        self.bad("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at,recovered_at,closed_at,status) "
                 "VALUES ('e','m','r','fixed_threshold','Info','2026-10-01T00:00:00.000Z','2026-10-05T00:00:00.000Z',"
                 "'2026-10-02T00:00:00.000Z','closed')")

    def test_1_7_adhoc_identity(self):
        ins = ("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,scheduled_date) "
               "VALUES (?,?,?,?,?,?)")
        self.c.execute(ins, ("u1", "c1", "srv", "PROD", "East", "2026-11-01"))
        self.bad(ins, ("u2", "c1", "SRV", "PROD", "East", "2026-11-01"))
        self.c.execute(ins, ("u3", "c1", "srv", "PROD", "East", "2026-12-01"))   # another date is another upgrade

    def test_1_8_rule_delete_requires_closed_events(self):
        self._bams()
        c = self.c
        c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at) "
                  "VALUES ('e','m','r','fixed_threshold','Warning',?)", (NOW,))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "close this rule"):
            c.execute("DELETE FROM bams_alert_rules WHERE id='r'")
        c.execute("UPDATE bams_alert_events SET status='closed', closed_at=? WHERE id='e'", (NOW,))
        c.execute("DELETE FROM bams_alert_rules WHERE id='r'")
        c.execute("INSERT INTO bams_alert_events(id,metric_id,alert_type,severity,opened_at) VALUES ('s','m','stale','Info',?)", (NOW,))

    def test_1_8_cascade_from_account_still_works_with_open_alert(self):
        self._bams()
        self.c.execute("INSERT INTO bams_alert_events(id,metric_id,rule_id,alert_type,severity,opened_at) "
                       "VALUES ('e','m','r','fixed_threshold','Warning',?)", (NOW,))
        self.c.execute("DELETE FROM clients WHERE id='c1'")
        self.assertEqual(self.c.execute("SELECT count(*) FROM bams_alert_rules").fetchone()[0], 0)

    def test_1_9_cheap_gaps_closed(self):
        self.bad("INSERT INTO notes(id,client_id,note_type,timestamp,subject,source) VALUES ('n','c1','Call Note',?,'s','System')", (NOW,))
        self.bad("INSERT INTO clients(id,name) VALUES ('c2', 'Bob' || char(10))")
        self.bad("INSERT INTO contacts(id,client_id,name) VALUES ('p','c1', 'A' || char(9) || 'B')")
        self.bad("INSERT INTO tasks(id,task) VALUES ('t', 'line1' || char(13) || char(10) || 'line2')")
        self.bad("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity) VALUES ('u','c1','s' || char(10),'DEV','DEV')")

    def test_1_11_today_null_dates_last_and_disabled_alerts_excluded(self):
        c = self.c
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,status,scheduled_date) VALUES "
                  "('u_null','c1','a','DEV','DEV','Validation Required',NULL),"
                  "('u_dated','c1','b','DEV','DEV','Scheduled','2026-10-15')")
        c.execute("INSERT INTO bams_objects(id,client_id,name,enabled) VALUES ('o','c1','off',0)")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.OFF')")
        c.execute("INSERT INTO bams_alert_events(id,metric_id,alert_type,severity,opened_at) VALUES ('e','m','stale','Warning',?)", (NOW,))
        c.row_factory = sqlite3.Row
        rows = c.execute((DB_DIR / "queries" / "today_queue.sql").read_text(), {"today": "2026-10-12"}).fetchall()
        t5 = [r["id"] for r in rows if r["tier"] == 5]
        self.assertEqual(t5, ["u_dated", "u_null"])
        self.assertNotIn("e", [r["id"] for r in rows])
        summ = c.execute((DB_DIR / "queries" / "account_summary.sql").read_text(),
                         {"today": "2026-10-12", "status": "All"}).fetchone()
        self.assertEqual(summ["active_alerts"], 0)

    def test_1_14_channel_and_seed_guards(self):
        # (c) channel stamped on first open; a mismatch is refused
        dev = migrate.connect(self.tmp / "dev.db")
        migrate.migrate(dev, channel="dev")
        self.assertEqual(dev.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()[0], "dev")
        with self.assertRaisesRegex(migrate.MigrationError, "channel"):
            migrate.migrate(dev, channel="prod")
        prod = migrate.connect(self.tmp / "p.db")
        migrate.migrate(prod, channel="prod")
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(migrate.MigrationError, "channel"):
            seed_mock.load(prod, data, dt.date(2026, 10, 12))          # seeding a PROD DB refused
        # PROD open of a mock-seeded DB refused
        seed_mock.load(dev, data, dt.date(2026, 10, 12))
        dev.execute("UPDATE app_meta SET value='prod' WHERE key='db.channel'")
        with self.assertRaisesRegex(migrate.MigrationError, "mock-seeded"):
            migrate.assert_channel(dev, "prod")
        # (a) guard inside load(), not only in the CLI
        named = migrate.connect(self.tmp / "tam_command_center.db")
        with self.assertRaises(seed_mock.SeedRefused):
            seed_mock.load(named, data, dt.date(2026, 10, 12))
        # (d) empty file with a foreign application_id is not adopted
        foreign = sqlite3.connect(str(self.tmp / "f.db"), isolation_level=None)
        foreign.execute("PRAGMA application_id = 12345")
        with self.assertRaisesRegex(migrate.MigrationError, "foreign application_id"):
            migrate.migrate(foreign, channel=None)

    def test_1_14b_reseed_keeps_user_settings(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        seed_mock.load(conn, data, dt.date(2026, 10, 12))
        conn.execute("UPDATE app_meta SET value='gmt' WHERE key='setting.time_display'")
        seed_mock.load(conn, data, dt.date(2026, 10, 12), reset=True)
        self.assertEqual(conn.execute("SELECT value FROM app_meta WHERE key='setting.time_display'").fetchone()[0], "gmt")




# =============================================================================
# QA SCHEMA_REVIEW_2 regression tests
# =============================================================================

class QA_1_5_FrozenMockClock(unittest.TestCase):
    """Freshness must hold against REAL elapsed time, not only at load (QA-1-5 reopened)."""

    def setUp(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        self.c = sqlite3.connect(":memory:", isolation_level=None)
        self.c.execute("PRAGMA foreign_keys = ON")
        self.load_now = dt.datetime(2026, 10, 12, 15, 0, 0)
        seed_mock.load(self.c, data, self.load_now.date(), now=self.load_now)
        self.sql = (DB_DIR / "queries" / "metric_freshness.sql").read_text(encoding="utf-8")

    def states(self, elapsed_s: float, provider_running: int, channel: str = "dev") -> dict:
        wall = seed_mock.fmt_instant(self.load_now + dt.timedelta(seconds=elapsed_s))
        out: dict = {}
        for r in self.c.execute(self.sql, {"wall_now": wall, "provider_running": provider_running,
                                           "channel": channel}):
            out[r[-1]] = out.get(r[-1], 0) + 1
        return out

    def test_states_hold_after_clock_advances(self):
        at_load = self.states(0, 0)
        for elapsed in (130, 86400, 30 * 86400):
            with self.subTest(elapsed=elapsed):
                st = self.states(elapsed, 0)
                self.assertEqual(st, at_load)
                for band in ("Live", "Delayed", "Stale", "No Data", "Disabled"):
                    self.assertGreaterEqual(st.get(band, 0), 1, band)

    def test_wall_clock_applies_when_a_provider_runs(self):
        st = self.states(130, 1)
        self.assertEqual(st.get("Live", 0), 0)
        self.assertEqual(st.get("Delayed", 0), 0)

    def test_verifier_uses_real_wall_time(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        # loaded "yesterday at noon" relative to the real clock: hours of real elapsed time
        today = dt.date.today()
        seed_mock.load(conn, data, today, now=dt.datetime.combine(today, dt.time(0, 0)) - dt.timedelta(hours=12))
        with redirect_stdout(io.StringIO()) as out:
            ok = seed_mock.verify(conn, today)
        self.assertTrue(ok, out.getvalue())
        self.assertIn("frozen mock clock rule", out.getvalue())


class QA_Review2_Lows(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_1_7_adhoc_null_date_duplicates_refused(self):
        ins = "INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity) VALUES (?,?,?,?,?)"
        self.c.execute(ins, ("a3", "c1", "srv", "DEV", "DEV"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "UNIQUE constraint failed"):
            self.c.execute(ins, ("a4", "c1", "SRV", "DEV", "DEV"))

    def test_2_3_explicit_bump_returns_fresh_token(self):
        c = self.c
        implicit = c.execute("UPDATE clients SET notes='a' WHERE id='c1' RETURNING row_version").fetchall()
        stored = c.execute("SELECT row_version FROM clients").fetchone()[0]
        self.assertEqual((implicit, stored), ([(1,)], 2))   # documented trap: RETURNING sees the pre-trigger value
        explicit = c.execute("UPDATE clients SET notes='b', row_version=row_version+1 WHERE id='c1' "
                             "RETURNING row_version").fetchall()
        self.assertEqual(explicit, [(3,)])
        self.assertEqual(c.execute("SELECT row_version FROM clients").fetchone()[0], 3)

    def test_2_4_refused_prod_open_writes_nothing(self):
        data = json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8"))
        conn = migrate.connect(self.tmp / "dev.db")
        seed_mock.load(conn, data, dt.date(2026, 10, 12))
        conn.execute("DELETE FROM app_meta WHERE key='db.channel'")          # an unstamped mock DB
        with self.assertRaisesRegex(migrate.MigrationError, "mock-seeded"):
            migrate.migrate(conn, channel="prod")
        self.assertIsNone(conn.execute("SELECT 1 FROM app_meta WHERE key='db.channel'").fetchone())
        migrate.migrate(conn, channel="dev")                                  # DEV is NOT stranded
        self.assertEqual(conn.execute("SELECT value FROM app_meta WHERE key='db.channel'").fetchone()[0], "dev")

    def test_2_4_channel_is_a_required_argument(self):
        with self.assertRaises(TypeError):
            migrate.migrate(self.c)  # type: ignore[call-arg]
        with self.assertWarns(UserWarning):
            with warnings.catch_warnings():
                warnings.simplefilter("always")
                migrate.migrate(self.c, channel=None)

    def test_2_5_neutered_guard_with_same_name_is_refused(self):
        self.c.execute("DROP TRIGGER trg_audit_events_no_delete")
        self.c.execute("CREATE TRIGGER trg_audit_events_no_delete BEFORE DELETE ON audit_events WHEN 0 BEGIN SELECT 1; END")
        with self.assertRaisesRegex(migrate.MigrationError, "guard triggers altered"):
            migrate.migrate(self.c, channel=None)

    def test_2_6_monitor_writes_do_not_advance_user_token(self):
        c = self.c
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.X')")
        c.execute("INSERT INTO bams_alert_rules(id,metric_id,rule_type,operator,threshold,severity) "
                  "VALUES ('r','m','fixed_threshold','>',1,'Info')")
        c.execute("UPDATE bams_metrics SET current_value=5, last_received=?, high_30=9 WHERE id='m'", (NOW,))
        c.execute("UPDATE bams_alert_rules SET breach_count=breach_count+1, suppress_until_clear=1 WHERE id='r'")
        self.assertEqual(c.execute("SELECT row_version FROM bams_metrics").fetchone()[0], 1)
        self.assertEqual(c.execute("SELECT row_version FROM bams_alert_rules").fetchone()[0], 1)
        c.execute("UPDATE bams_metrics SET stale_after_seconds=300 WHERE id='m'")      # user config edit
        c.execute("UPDATE bams_alert_rules SET threshold=2 WHERE id='r'")
        self.assertEqual(c.execute("SELECT row_version FROM bams_metrics").fetchone()[0], 2)
        self.assertEqual(c.execute("SELECT row_version FROM bams_alert_rules").fetchone()[0], 2)

    def test_2_7_recent_changes_tie_break_is_deterministic(self):
        c = self.c
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m','o','CPU','MOCK.X')")
        for i in range(5):  # five events with IDENTICAL timestamps
            c.execute("INSERT INTO bams_alert_events(id,metric_id,alert_type,severity,opened_at,status,closed_at) "
                      "VALUES (?,'m','stale','Info',?, 'closed', ?)", (f"e{i}", NOW, NOW))
        c.row_factory = sqlite3.Row
        sql = (DB_DIR / "queries" / "recent_changes.sql").read_text(encoding="utf-8")
        runs = {tuple(r["entry_key"] for r in c.execute(sql, {"limit": 3}).fetchall()) for _ in range(5)}
        self.assertEqual(runs, {("b:e4:opened", "b:e4:closed", "b:e3:opened")})




# =============================================================================
# QA SCHEMA_REVIEW_3 regression tests + PM D-23 / D-24
# =============================================================================

class QA_Review3(unittest.TestCase):
    def setUp(self):
        self.c = fresh()
        add_client(self.c)

    def test_3_3_prod_refuses_mock_clock_without_mock_seed(self):
        self.c.execute("INSERT INTO app_meta VALUES ('bams.mock_clock', ?)", (NOW,))
        with self.assertRaisesRegex(migrate.MigrationError, "bams.mock_clock"):
            migrate.migrate(self.c, channel="prod")
        self.assertIsNone(self.c.execute("SELECT 1 FROM app_meta WHERE key='db.channel'").fetchone())

    def test_3_3_freshness_ignores_mock_clock_outside_dev(self):
        c = self.c
        c.execute("INSERT INTO app_meta VALUES ('bams.mock_clock', '2026-10-12T12:00:00.000Z')")
        c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o','c1','s')")
        c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker,current_value,last_received) "
                  "VALUES ('m','o','CPU','MOCK.X',1,'2026-10-12T11:59:30.000Z')")
        sql = (DB_DIR / "queries" / "metric_freshness.sql").read_text(encoding="utf-8")
        p = {"wall_now": "2026-10-13T12:00:00.000Z", "provider_running": 0}
        self.assertEqual(c.execute(sql, dict(p, channel="dev")).fetchone()[-1], "Live")
        self.assertEqual(c.execute(sql, dict(p, channel="prod")).fetchone()[-1], "Stale")

    def test_3_4_undeclared_trigger_refused(self):
        self.c.execute("CREATE TRIGGER trg_extra AFTER INSERT ON tasks BEGIN DELETE FROM notes; END")
        with self.assertRaisesRegex(migrate.MigrationError, r"undeclared triggers present: \['trg_extra'\]"):
            migrate.migrate(self.c, channel=None)


class PM_D23_D24_TodayQueue(unittest.TestCase):
    T = "2026-10-12"

    def setUp(self):
        c = self.c = fresh()
        c.row_factory = sqlite3.Row
        c.execute("INSERT INTO clients(id,name,next_contact) VALUES "
                  "('a1','Same Day Fund','2026-10-12'),('a2','Upcoming Same','2026-10-20'),"
                  "('a3','Different Dates','2026-10-11'),('a4','Done Task','2026-10-12')")
        c.execute("INSERT INTO tasks(id,task,client_id,category,due,status,archived) VALUES "
                  "('t1','Follow up A1','a1','Client Follow-Up','2026-10-12','Not Started',0),"
                  "('t2','Follow up A2','a2','Client Follow-Up','2026-10-20','In Progress',0),"
                  "('t3','Follow up A3','a3','Client Follow-Up','2026-10-15','Not Started',0),"
                  "('t4','Follow up A4','a4','Client Follow-Up','2026-10-12','Complete',0),"
                  "('t5','Other cat A1','a1','Reporting','2026-10-12','Not Started',0)")
        c.execute("INSERT INTO server_upgrades(id,client_id,server_name,environment,polarity,status,validation_status,scheduled_date) VALUES "
                  "('x_far','a1','s1','DEV','DEV','Exception','Pending','2026-12-31'),"
                  "('x_nodate','a1','s2','DEV','DEV','Exception','Pending',NULL),"
                  "('x_past','a1','s3','DEV','DEV','Exception','Pending','2026-10-01'),"
                  "('d_soon','a1','s4','DEV','DEV','Deferred','Pending','2026-10-15'),"
                  "('d_fail','a1','s5','DEV','DEV','Deferred','Failed','2026-10-14'),"
                  "('d_upc','a1','s6','DEV','DEV','Deferred','Pending','2026-11-01')")
        self.rows = c.execute((DB_DIR / "queries" / "today_queue.sql").read_text(encoding="utf-8"),
                              {"today": self.T}).fetchall()
        self.by = {(r["kind"], r["id"]): r for r in self.rows}

    def test_d23_matching_follow_up_suppresses_touch_in_queue_and_upcoming(self):
        self.assertNotIn(("client_follow_up", "a1"), self.by)          # queue (tier 4) suppressed
        self.assertNotIn(("client_follow_up", "a2"), self.by)          # Upcoming suppressed
        self.assertEqual(self.by[("task", "t1")]["context"], "Next Client Touch")
        self.assertEqual(self.by[("task", "t1")]["tier"], 2)
        self.assertEqual(self.by[("task", "t2")]["context"], "Next Client Touch")
        self.assertIsNone(self.by[("task", "t5")]["context"])           # other category: no tag

    def test_d23_different_dates_or_completed_task_keep_both(self):
        self.assertEqual(self.by[("client_follow_up", "a3")]["tier"], 4)
        self.assertIsNone(self.by[("task", "t3")]["context"])
        self.assertEqual(self.by[("client_follow_up", "a4")]["tier"], 4)  # completed task does not suppress

    def test_d24_exception_any_date_and_deferred_out_of_queue(self):
        self.assertEqual(self.by[("server_upgrade", "x_far")]["tier"], 5)
        self.assertEqual(self.by[("server_upgrade", "x_nodate")]["tier"], 5)
        self.assertEqual(self.by[("server_upgrade", "x_past")]["tier"], 1)
        self.assertNotIn(("server_upgrade", "d_soon"), self.by)
        self.assertNotIn(("server_upgrade", "d_fail"), self.by)         # Deferred + Failed stays out too
        self.assertEqual(self.by[("server_upgrade", "d_upc")]["section"], "upcoming")




# =============================================================================
# QA SCHEMA_REVIEW_4: broad adversarial corpus for sql_safety_scan (QA-4-1/2/3)
# =============================================================================

SQL_IDIOMS_BANNED = [
    "INSERT OR REPLACE INTO {T} (id, name) VALUES (?, ?)",
    "insert or replace into {T} values (?)",
    "Insert Or Replace Into {T} SELECT * FROM staging",
    "REPLACE INTO {T} (id) VALUES (?)",
    "replace into {T} values (?)",
    "REPLACE INTO {T} AS c VALUES (?)",
    "REPLACE INTO {T} SELECT * FROM staging",
    "REPLACE INTO {T} DEFAULT VALUES",
    "WITH s AS (SELECT 1 AS id) REPLACE INTO {T} SELECT id FROM s",
    "UPDATE OR REPLACE {T} SET name = ? WHERE id = ?",
    "update or replace {T} set name = ?",
]


def _split_mid(sql: str):
    words = sql.split(" ")
    k = max(1, len(words) // 2)
    return " ".join(words[:k]) + " ", " ".join(words[k:])


def banned_corpus():
    """(suffix, text, label) for every banned idiom x table form x language wrapper."""
    out = []
    for idiom in SQL_IDIOMS_BANNED:
        def put(sfx, text, how):
            out.append((sfx, text, f"{how}: {idiom}"))
        # ---------------- Python
        for t in ("clients", "main.clients", "[clients]", "`clients`"):
            q = idiom.replace("{T}", t)
            put(".py", f'c.execute("{q}", row)', "py dq " + t)
            put(".py", f"c.execute('{q}', row)", "py sq " + t)
            put(".py", f'c.execute(r"{q}", row)', "py raw " + t)
            put(".py", f'c.execute(b"{q}".decode(), row)', "py bytes " + t)
        for t in ("{table}", "{self.table}", "{TABLES[kind]}"):
            put(".py", 'c.execute(f"' + idiom.replace("{T}", t) + '", vals)', "py f-string " + t)
        put(".py", 'c.execute("' + idiom.replace("{T}", "%s") + '" % table, row)', "py percent")
        put(".py", 'c.execute("' + idiom.replace("{T}", "%(t)s") + '" % {"t": table}, row)', "py percent-dict")
        for t in ("{}", "{0}", "{name}"):
            put(".py", 'c.execute("' + idiom.replace("{T}", t) + '".format(t), row)', "py format " + t)
        before, after = idiom.split("{T}")
        put(".py", f'c.execute("{before}" + table + "{after}", row)', "py concat var")
        a, b = _split_mid(idiom.replace("{T}", "clients"))
        put(".py", f'SQL = ("{a}"\n       "{b}")', "py implicit concat")
        put(".py", 'SQL = """\n    ' + idiom.replace("{T}", "clients").replace(" ", "\n    ") + '\n"""', "py triple multiline")
        put(".py", f'SQL = "{a}" \\\n    "{b}"', "py backslash continuation")
        # ---------------- JS / TS
        for sfx in (".ts", ".js", ".mjs", ".cjs", ".tsx"):
            put(sfx, 'db.run("' + idiom.replace("{T}", "clients") + '", row)', "js dq")
            put(sfx, "db.run('" + idiom.replace("{T}", "clients") + "', row)", "js sq")
        put(".ts", "db.run(`" + idiom.replace("{T}", "${table}") + "`, row)", "ts template ${table}")
        put(".ts", "db.run(`" + idiom.replace("{T}", "${t.name}").replace(" ", "\n  ") + "`, row)", "ts template multiline")
        put(".ts", f'db.run("{before}" + table + "{after}", row)', "ts concat var")
        put(".js", "const q = [\"" + a + "\", \"" + b + "\"].join(\"\");", "js array join")
        # ---------------- SQL files
        q = idiom.replace("{T}", "clients")
        put(".sql", q + ";", "sql plain")
        put(".sql", q.replace(" ", "\n") + ";", "sql multiline")
        w = q.split(" ")
        put(".sql", " /* c */ ".join(w) + ";", "sql block comments between words")
        put(".sql", " -- c\n".join(w) + ";", "sql line comments between words")
        put(".sql", "INSERT INTO log VALUES('it''s -- fine');\n" + q + ";", "sql after literal with -- and ''")
        # ---------------- launcher / shell scripts
        dq = idiom.replace("{T}", "clients").replace("?", "1")
        put(".sh", f'sqlite3 "$DB" "{dq};"', "sh")
        put(".bash", f"sqlite3 \"$DB\" '{dq};'", "bash sq")
        put(".bat", f'sqlite3 %DB% "{dq};"', "bat")
        put(".cmd", f'@sqlite3 "%DB%" "{dq};"', "cmd")
        put(".ps1", f'& sqlite3 $db "{dq};"', "ps1")
    return out


ORM_AND_OTHER_BANNED = [
    # SQLAlchemy
    (".py", "stmt = insert(t).prefix_with('OR REPLACE')"),
    (".py", 'stmt = insert(t).prefix_with("OR REPLACE", dialect="sqlite")'),
    (".py", 'stmt = insert(t).prefix_with(text("OR REPLACE"))'),
    (".py", 'stmt = (insert(t)\n        .prefix_with(\n            "OR REPLACE"\n        ))'),
    (".py", 'stmt = insert(t).prefix_with("OR", "REPLACE")'),
    (".py", "Column('n', String, unique=True, sqlite_on_conflict_unique='REPLACE')"),
    (".py", "UniqueConstraint('a', 'b', sqlite_on_conflict='REPLACE')"),
    (".py", 'PrimaryKeyConstraint("id", sqlite_on_conflict="replace")'),
    (".py", "Column('id', Integer, primary_key=True, sqlite_on_conflict_primary_key='REPLACE')"),
    # peewee
    (".py", "Client.insert(**row).on_conflict_replace().execute()"),
    (".py", "Client.insert_many(rows).on_conflict_replace().execute()"),
    (".py", "Client.insert(**row).on_conflict('REPLACE').execute()"),
    (".py", "Client.insert(**row).on_conflict(action='replace').execute()"),
    (".py", "Client.replace(**row).execute()"),
    (".py", "Client.replace(id=1, name='x').execute()"),
    (".py", "Client.replace_many(rows).execute()"),
    (".py", "Client.replace_many(rows, fields=[Client.id, Client.name]).execute()"),
    (".py", "models.Client.replace(**row).execute()"),
    # pandas
    (".py", "df.to_sql('clients', con, if_exists='replace')"),
    (".py", 'df.to_sql("clients", con, if_exists="replace", index=False)'),
    (".py", "df.to_sql('clients', con, if_exists = 'replace')"),
    (".py", 'df.to_sql("clients", con, **{"if_exists": "replace"})'),
    (".py", 'opts = {"if_exists": "replace"}\ndf.to_sql("clients", con, **opts)'),
    (".py", "opts = dict(if_exists='replace')"),
    # sqlite-utils
    (".py", 'db["clients"].insert(row, pk="id", replace=True)'),
    (".py", 'db["clients"].insert_all(rows, pk="id", replace = True)'),
    # Kysely
    (".ts", "await db.insertInto('clients').orReplace().values(row).execute()"),
    (".ts", "await db\n  .insertInto('clients')\n  .orReplace()\n  .values(row)"),
    # DDL
    (".sql", "CREATE TABLE t (a TEXT UNIQUE ON CONFLICT REPLACE);"),
    (".sql", "CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE);"),
    (".sql", "CREATE TABLE t (a, b, UNIQUE (a, b) ON CONFLICT REPLACE);"),
    (".sql", "create table t (a text not null on conflict replace);"),
    (".py", 'c.executescript("CREATE TABLE t (a UNIQUE ON CONFLICT REPLACE)")'),
    # escapes inside strings
    (".py", 'q = "UPDATE OR\\nREPLACE contacts SET a=1"'),
    (".py", 'q = "INSERT OR\\tREPLACE INTO t VALUES (1)"'),
    (".js", 'const q = "INSERT OR \\\nREPLACE INTO t VALUES (1)";'),
    # comment markers inside strings must not hide code (QA-3-1b)
    (".py", 'x = "a #b"; c.execute("REPLACE INTO t VALUES(1)")'),
    (".ts", 'const u = "a //b"; db.run("REPLACE INTO t VALUES (1)")'),
    (".ts", 'const u = "/* not a comment"; db.run("REPLACE INTO t VALUES (1)") // */'),
    (".sql", "INSERT INTO t VALUES('--'); REPLACE INTO t VALUES(2);"),
    (".sql", "INSERT INTO t VALUES('/*'); REPLACE INTO t VALUES(2); -- */"),
    (".sh", 'echo "a # b"; sqlite3 db "REPLACE INTO t VALUES (1)"'),
    # bare allow marker (no reason) does NOT exempt (QA-4-2 E11)
    (".py", 'X = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow'),
    (".py", 'X = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow ()'),
]

LEGIT_NOT_FLAGGED = [
    # Python string / datetime / os / pandas / dataclasses replace
    (".py", "name = raw.replace('a', 'b')"),
    (".py", "s = s.replace('a', 'b', count=1)"),
    (".py", 'q = q.replace("INTO", "INTO main.")'),
    (".py", "key = name.replace(' ', '').lower()"),
    (".py", "d = dt.replace(hour=0, minute=0, second=0)"),
    (".py", "t = datetime.now(timezone.utc).replace(tzinfo=None)"),
    (".py", "d2 = d.replace(year=2027)"),
    (".py", "os.replace(tmp_path, final_path)"),
    (".py", "Path(p).replace(target)"),
    (".py", "cfg = dataclasses.replace(cfg, debug=True)"),
    (".py", "df = df.replace(to_replace={'a': 'b'})"),
    (".py", "out = pd.DataFrame.replace(df, to_replace=1, value=2)"),
    (".py", "df.to_sql('staging_import', con, if_exists='append')"),
    (".py", "df.to_sql('staging_import', con, if_exists='fail')"),
    (".py", 'db["clients"].upsert(row, pk="id")'),
    (".py", 'db["clients"].insert(row, pk="id", ignore=True, replace=False)'),
    (".py", "Client.insert(**row).on_conflict(conflict_target=[Client.id], update={Client.name: 'x'}).execute()"),
    (".py", "Client.insert(**row).on_conflict_ignore().execute()"),
    # allowed SQL idioms
    (".py", 'c.execute("INSERT OR IGNORE INTO t VALUES (1)")'),
    (".py", 'c.execute("INSERT INTO t VALUES (?) ON CONFLICT(id) DO UPDATE SET a = excluded.a")'),
    (".py", 'c.execute("INSERT INTO t VALUES (?) ON CONFLICT DO NOTHING")'),
    (".py", 'c.execute("UPDATE OR IGNORE t SET a = 1")'),
    (".py", "c.execute(\"UPDATE t SET name = replace(name, 'a', 'b')\")"),
    (".py", 'c.execute(f"INSERT INTO {table} (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET id = excluded.id")'),
    # comments / prose / docstrings
    (".py", "# never use INSERT OR REPLACE INTO t VALUES (1) here"),
    (".py", '"""Never use INSERT OR REPLACE; use ON CONFLICT DO UPDATE."""'),
    (".py", 'help_text = "Replace the existing file?"'),
    (".py", 'log.info("Replacing into cache")'),
    (".py", 'EXAMPLE = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow (documentation example)'),
    # JS / TS
    (".ts", "const s = label.replace(' into ', ' ');"),
    (".ts", "const s = text.replace(/OR REPLACE/g, '');"),
    (".ts", "const s = text.replaceAll('a', 'b');"),
    (".ts", "router.replace('/accounts');"),
    (".tsx", "navigate(path, { replace: true });"),
    (".tsx", "<Button>Replace into template</Button>"),
    (".tsx", "<p>Update or replace your logo</p>"),
    (".tsx", "<p>Upload or replace your logo</p>"),
    (".ts", "// INSERT OR REPLACE INTO t VALUES (1)\nconst label = 'Edit or replace the file';"),
    (".ts", "/* REPLACE INTO t VALUES (1) */ const x = 1;"),
    (".ts", 'db.prepare("INSERT INTO t VALUES (?) ON CONFLICT(id) DO UPDATE SET a = excluded.a")'),
    (".ts", "await db.insertInto('t').values(row).onConflict((oc) => oc.column('id').doUpdateSet(row))"),
    (".ts", "await db.insertInto('t').orIgnore().values(row)"),
    # SQL files
    (".sql", "SELECT replace(name, ' ', '') FROM clients;"),
    (".sql", "SELECT id FROM clients WHERE bpid = ? OR replace(name, ' ', '') = ?;"),
    (".sql", "UPDATE t SET a = replace(a, 'x', 'y');"),
    (".sql", "INSERT INTO notes VALUES('Do not REPLACE INTO prod (seriously)');"),
    (".sql", "INSERT INTO t VALUES ('it''s INSERT OR REPLACE INTO x VALUES (1)');"),
    (".sql", "-- REPLACE INTO t VALUES (1)\nSELECT 1;"),
    (".sql", "/* UPDATE OR REPLACE t SET a = 1 */ SELECT 1;"),
    (".sql", "CREATE TABLE t (a TEXT UNIQUE ON CONFLICT ABORT);"),
    (".sql", "INSERT OR IGNORE INTO t VALUES (1);"),
    # scripts
    (".sh", "# sqlite3 db 'REPLACE INTO t VALUES (1)'\necho done"),
    (".sh", 'echo "replace into the file"'),
    (".bat", 'REM sqlite3 db "REPLACE INTO t VALUES (1)"\necho done'),
    (".bat", ':: REPLACE INTO t VALUES (1)\necho done'),
    (".ps1", "<# REPLACE INTO t VALUES (1) #>\nWrite-Host done"),
    (".ps1", "# REPLACE INTO t VALUES (1)\nWrite-Host done"),
]

# Accepted false positives (fail closed; documented in 03 §2.1). They must stay
# flagged without a marker and clear with a reasoned marker.
ACCEPTED_FALSE_POSITIVES = [
    (".tsx", "<li>Insert or replace into the list</li>"),
    (".tsx", "<p>Replace into list (3 items)</p>"),
    (".py", 'msg = "Do not REPLACE INTO prod (seriously)"'),
]


# ----------------------------------------------------------------------------- T-61

PROGRESS_SQL = (DB_DIR / "queries" / "day_progress.sql").read_text(encoding="utf-8")
TREND_SQL = (DB_DIR / "queries" / "activity_trend.sql").read_text(encoding="utf-8")
TIMELINE_SQL = (DB_DIR / "queries" / "activity_timeline.sql").read_text(encoding="utf-8")
UTC = dt.timezone.utc
NY = ZoneInfo("America/New_York")
TOKYO = ZoneInfo("Asia/Tokyo")


def seeded(today: dt.date) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    seed_mock.load(conn, json.loads(seed_mock.MOCK_JSON.read_text(encoding="utf-8")), today,
                   now=dt.datetime(today.year, today.month, today.day, 12))
    return conn


def progress(conn, day: dt.date, tz=UTC) -> dict:
    cur = conn.execute(PROGRESS_SQL, seed_mock.progress_params(day, tz))
    return dict(zip([c[0] for c in cur.description], cur.fetchone()))


class T61_DayProgress(unittest.TestCase):
    """D-29 / 01_PM_SPEC section 10.2: the 'done today N of M' ring."""
    DAY = dt.date(2026, 10, 12)

    def setUp(self):
        self.c = fresh()
        add_client(self.c, "act", "Active Mock Fund")
        add_client(self.c, "ina", "Dormant Mock Fund", "Inactive")

    def task(self, tid, due="2026-10-10", status="Not Started", client="act", archived=0):
        self.c.execute("INSERT INTO tasks(id,task,client_id,due,status,archived) VALUES (?,?,?,?,?,?)",
                       (tid, tid, client, due, status, archived))

    def event(self, tid, action, at, source="GUI", object_type="task"):
        self.c.execute("INSERT INTO audit_events(timestamp,category,client_id,object_type,object_id,object_label,action,source) "
                       "VALUES (?,?,?,?,?,?,?,?)", (at, "crm", None, object_type, tid, tid, action, source))

    def done(self, tid, at="2026-10-12T14:00:00.000Z", **kw):
        self.task(tid, status="Complete", **kw)
        self.event(tid, "completed", at)

    def test_empty_day_has_no_ring(self):
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=0, done=0, open=0, done_other=0))

    def test_open_only_and_all_done(self):
        self.task("a"); self.task("b", due="2026-10-12")
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=2, done=0, open=2, done_other=0))
        for t in ("a", "b"):
            self.c.execute("UPDATE tasks SET status='Complete' WHERE id=?", (t,))
            self.event(t, "completed", "2026-10-12T10:00:00.000Z")
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=2, done=2, open=0, done_other=0))  # N = M

    def test_reopened_task_lowers_n_and_not_m(self):
        self.done("a", "2026-10-12T09:00:00.000Z"); self.done("b", "2026-10-12T09:30:00.000Z"); self.task("c")
        before = progress(self.c, self.DAY)
        self.assertEqual((before["done"], before["total"]), (2, 3))
        self.c.execute("UPDATE tasks SET status='In Progress' WHERE id='b'")
        self.event("b", "reopened", "2026-10-12T11:00:00.000Z")
        after = progress(self.c, self.DAY)
        self.assertEqual((after["done"], after["open"], after["total"]), (1, 2, 3))     # N-1, R+1, M unchanged

    def test_completed_yesterday_reopened_and_completed_today_counts_today(self):
        self.done("a", "2026-10-12T09:00:00.000Z")
        self.event("a", "completed", "2026-10-11T15:00:00.000Z"); self.event("a", "reopened", "2026-10-11T16:00:00.000Z")
        self.assertEqual(progress(self.c, self.DAY)["done"], 1)

    def test_many_completions_count_once_and_source_is_ignored(self):
        self.done("a", "2026-10-12T09:00:00.000Z")
        self.event("a", "completed", "2026-10-12T10:00:00.000Z", source="System")
        self.event("a", "completed", "2026-10-12T11:00:00.000Z", source="Bulk Import")
        self.assertEqual(progress(self.c, self.DAY)["done"], 1)

    def test_completed_only_yesterday_is_neither_done_nor_plan(self):
        self.done("a", "2026-10-11T20:00:00.000Z")
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=0, done=0, open=0, done_other=0))

    def test_archived_open_task_excluded_but_archived_done_task_counts(self):
        self.task("x", archived=1)
        self.done("a", archived=1)
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=1, done=1, open=0, done_other=0))

    def test_inactive_account_excluded_from_every_term(self):
        self.task("x", client="ina")
        self.done("a", client="ina"); self.done("b", client="ina", due=None); self.done("c", client="ina", due="2026-12-01")
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=0, done=0, open=0, done_other=0))

    def test_done_other_future_due_null_due_and_no_account(self):
        self.done("f", due="2026-10-20"); self.done("n", due=None)
        self.done("u", client=None, due="2026-10-01")                      # no account is eligible, in the plan
        self.assertEqual(progress(self.c, self.DAY), dict(day="2026-10-12", total=1, done=1, open=0, done_other=2))

    def test_open_tasks_without_due_or_in_the_future_are_not_plan(self):
        self.task("n", due=None); self.task("f", due="2026-10-13"); self.task("t", due="2026-10-12")
        self.assertEqual(progress(self.c, self.DAY)["total"], 1)

    def test_deleted_task_is_not_counted(self):
        self.done("a")
        self.c.execute("DELETE FROM tasks WHERE id='a'")                     # audit rows remain
        self.assertEqual(progress(self.c, self.DAY)["done"], 0)
        self.assertEqual(self.c.execute("SELECT count(*) FROM audit_events WHERE object_id='a'").fetchone()[0], 1)

    def test_other_object_types_never_count(self):
        self.task("a")
        self.event("a", "completed", "2026-10-12T10:00:00.000Z", object_type="server_upgrade")
        self.assertEqual(progress(self.c, self.DAY)["done"], 0)

    def test_utc_window_is_half_open(self):
        self.done("s", "2026-10-12T00:00:00.000Z"); self.done("e", "2026-10-13T00:00:00.000Z")
        self.done("l", "2026-10-11T23:59:59.999Z")
        self.assertEqual(progress(self.c, self.DAY)["done"], 1)

    def test_local_midnight_in_a_non_utc_zone(self):
        # Tokyo (UTC+9): local day Oct 12 = [Oct 11 15:00Z, Oct 12 15:00Z)
        self.done("late_yesterday", "2026-10-11T14:30:00.000Z")             # 23:30 local Oct 11
        self.done("early_today", "2026-10-11T15:30:00.000Z")                # 00:30 local Oct 12
        self.done("late_today", "2026-10-12T14:59:59.999Z")                 # 23:59:59 local Oct 12
        self.done("tomorrow", "2026-10-12T15:00:00.000Z")                   # 00:00 local Oct 13
        self.assertEqual(progress(self.c, self.DAY, TOKYO)["done"], 2)
        self.assertEqual(progress(self.c, self.DAY, UTC)["done"], 2)        # UTC counts a different pair

    def test_dst_spring_forward_day_is_23_hours(self):
        day = dt.date(2026, 3, 8)                                           # New York: 23-hour day
        p = seed_mock.progress_params(day, NY)
        self.assertEqual((p["day_start_utc"], p["day_end_utc"]), ("2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"))
        self.done("before", "2026-03-08T04:59:59.999Z", due="2026-03-01")   # 23:59:59 EST Mar 7
        self.done("first", "2026-03-08T05:00:00.000Z", due="2026-03-01")    # 00:00 EST Mar 8
        self.done("last", "2026-03-09T03:59:59.999Z", due="2026-03-01")     # 23:59:59 EDT Mar 8
        self.done("after", "2026-03-09T04:00:00.000Z", due="2026-03-01")    # 00:00 EDT Mar 9
        self.assertEqual(progress(self.c, day, NY)["done"], 2)

    def test_dst_fall_back_day_is_25_hours(self):
        day = dt.date(2026, 11, 1)                                          # New York: 25-hour day
        p = seed_mock.progress_params(day, NY)
        self.assertEqual((p["day_start_utc"], p["day_end_utc"]), ("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"))
        self.done("naive_24h_would_miss", "2026-11-02T04:30:00.000Z", due="2026-10-01")   # 23:30 EST Nov 1
        self.done("first", "2026-11-01T04:00:00.000Z", due="2026-10-01")
        self.done("next_day", "2026-11-02T05:00:00.000Z", due="2026-10-01")
        self.assertEqual(progress(self.c, day, NY)["done"], 2)

    def test_property_done_never_exceeds_total(self):
        rnd = random.Random(61)
        for round_ in range(40):
            self.c.execute("DELETE FROM tasks")
            for i in range(rnd.randint(0, 12)):
                due = rnd.choice([None, "2026-10-01", "2026-10-12", "2026-10-30"])
                client = rnd.choice([None, "act", "ina"])
                status = rnd.choice(["Not Started", "Complete", "Complete", "Waiting"])
                self.task(f"p{round_}_{i}", due, status, client, rnd.choice([0, 0, 1]))
                if rnd.random() < 0.7:
                    self.event(f"p{round_}_{i}", rnd.choice(["completed", "reopened"]),
                               rnd.choice(["2026-10-11T23:00:00.000Z", "2026-10-12T09:00:00.000Z", "2026-10-12T20:00:00.000Z"]))
            r = progress(self.c, self.DAY)
            self.assertEqual(r["total"], r["done"] + r["open"])
            self.assertLessEqual(r["done"], r["total"])
            self.assertTrue(all(v >= 0 for k, v in r.items() if k != "day"))

    def test_uses_ix_audit_ts(self):
        plan = " ".join(str(row[-1]) for row in self.c.execute("EXPLAIN QUERY PLAN " + PROGRESS_SQL,
                                                               seed_mock.progress_params(self.DAY, UTC)))
        self.assertIn("USING INDEX ix_audit_ts", plan)
        self.assertNotIn("SCAN a", plan)

    def test_seed_hand_computed_table(self):
        """The doc table in 03_DATA_MODEL section 17 is this assertion, for any rebased 'today'."""
        for day in (dt.date(2026, 10, 12), dt.date(2026, 11, 3), dt.date(2027, 3, 3)):
            with self.subTest(day=day):
                c = seeded(day)
                self.assertEqual(progress(c, day), dict(day=day.isoformat(), total=27, done=8, open=19, done_other=2))
                title = lambda ids: sorted(r[0] for r in c.execute(  # noqa: E731
                    f"SELECT task FROM tasks WHERE id IN ({','.join('?' * len(ids))})", list(ids)))
                done_ids = [r[0] for r in c.execute(
                    "SELECT DISTINCT a.object_id FROM audit_events a JOIN tasks t ON t.id=a.object_id "
                    "LEFT JOIN clients c ON c.id=t.client_id WHERE a.action='completed' AND a.object_type='task' "
                    "AND a.timestamp >= ? AND a.timestamp < ? AND t.status='Complete' AND (t.client_id IS NULL OR c.status='Active') "
                    "AND t.due IS NOT NULL AND t.due <= ?", (*(seed_mock.progress_params(day, UTC)[k] for k in ("day_start_utc", "day_end_utc")), day.isoformat()))]
                self.assertEqual(title(done_ids), sorted([
                    "Archive superseded capacity worksheet", "Close out API migration questionnaire",
                    "Collect server inventory addendum", "Confirm DR contact escalation path",
                    "File weekly coverage summary", "Reconcile September usage report",
                    "Send Q3 entitlement recap to desk heads", "Share B-PIPE failover runbook with client"]))
                reopened = c.execute("SELECT status FROM tasks WHERE task='Re-check West upgrade ticket after reopen'").fetchone()
                self.assertEqual(reopened[0], "In Progress")
                c.close()

    def test_seed_does_not_change_the_today_queue(self):
        """Completed tasks never reach the queue: only the reopened one (open, due in the past) does."""
        day = dt.date(2026, 10, 12)
        c = seeded(day)
        c.row_factory = sqlite3.Row
        titles = {r["title"] for r in c.execute((DB_DIR / "queries" / "today_queue.sql").read_text(encoding="utf-8"),
                                                {"today": day.isoformat()})}
        self.assertIn("Re-check West upgrade ticket after reopen", titles)
        self.assertNotIn("Reconcile September usage report", titles)
        self.assertNotIn("Hand over final entitlement list", titles)


def bounds(day, tz=UTC):
    return seed_mock.trend_params(day, tz)


class T61_ActivityTrend(unittest.TestCase):
    """01_PM_SPEC section 10.4 #18: 14 daily activity points per account."""
    DAY = dt.date(2026, 10, 12)

    def rows(self, conn, tz=UTC, inactive=False):
        return conn.execute(TREND_SQL, seed_mock.trend_params(self.DAY, tz, inactive)).fetchall()

    def setUp(self):
        self.c = fresh()
        add_client(self.c, "a1", "Alpha Mock Fund"); add_client(self.c, "a2", "Beta Mock Fund")
        add_client(self.c, "in", "Dormant Mock Fund", "Inactive")

    def note(self, nid, client, at):
        self.c.execute("INSERT INTO notes(id,client_id,note_type,timestamp,subject) VALUES (?,?,?,?,?)",
                       (nid, client, "General Note", at, nid))

    def audit(self, client, otype, action, at):
        self.c.execute("INSERT INTO audit_events(timestamp,category,client_id,object_type,object_id,object_label,action,source) "
                       "VALUES (?,?,?,?,?,?,?,?)", (at, "crm", client, otype, "o", "o", action, "GUI"))

    def series(self, conn=None, tz=UTC, inactive=False):
        out = {}
        for cid, _name, idx, day, n in self.rows(conn or self.c, tz, inactive):
            out.setdefault(cid, []).append((idx, day, n))
        return out

    def test_shape_14_points_zero_filled_and_days_ascending(self):
        s = self.series()
        self.assertEqual(sorted(s), ["a1", "a2"])                          # Inactive excluded by default
        for pts in s.values():
            self.assertEqual([p[0] for p in pts], list(range(14)))
            self.assertEqual(pts[0][1], "2026-09-29"); self.assertEqual(pts[13][1], "2026-10-12")
            self.assertEqual([p[2] for p in pts], [0] * 14)                # no activity -> 14 zeros
        self.assertEqual(sorted(self.series(inactive=True)), ["a1", "a2", "in"])

    def test_rows_are_ordered_by_name_then_day(self):
        names = [r[1] for r in self.rows(self.c)]
        self.assertEqual(names, sorted(names))

    def test_counts_all_three_sources_and_only_listed_system_events(self):
        self.note("n1", "a1", "2026-10-12T10:00:00.000Z")
        self.audit("a1", "task", "completed", "2026-10-12T11:00:00.000Z")
        self.audit("a1", "task", "updated", "2026-10-12T11:30:00.000Z")        # not a timeline event
        self.audit("a1", "bams_object", "created", "2026-10-12T11:40:00.000Z")  # not a timeline event
        self.audit("a1", "server_upgrade", "updated", "2026-10-12T12:00:00.000Z")
        self.c.execute("INSERT INTO bams_objects(id,client_id,name) VALUES ('o1','a1','srv')")
        self.c.execute("INSERT INTO bams_metrics(id,object_id,metric_name,ticker) VALUES ('m1','o1','CPU','T1')")
        self.c.execute("INSERT INTO bams_alert_events(id,metric_id,alert_type,severity,message,opened_at,recovered_at,closed_at,status,"
                       "trigger_value) VALUES ('e1','m1','fixed_threshold','Warning','x','2026-10-11T10:00:00.000Z',"
                       "'2026-10-11T12:00:00.000Z','2026-10-12T09:00:00.000Z','closed',90)")
        s = self.series()["a1"]
        self.assertEqual((s[13][2], s[12][2]), (4, 2))                      # note+task+upgrade+closed / opened+recovered
        self.assertEqual(sum(p[2] for p in s), 6)

    def test_deleted_note_vanishes_but_its_audit_event_counts(self):
        self.note("n1", "a1", "2026-10-12T10:00:00.000Z")
        self.assertEqual(self.series()["a1"][13][2], 1)
        self.c.execute("DELETE FROM notes WHERE id='n1'")
        self.audit("a1", "note", "deleted", "2026-10-12T10:30:00.000Z")
        self.assertEqual(self.series()["a1"][13][2], 1)                     # the deletion event, as in Activity
        self.audit("a1", "note", "created", "2026-10-12T10:31:00.000Z")     # notes appear as notes, never twice
        self.assertEqual(self.series()["a1"][13][2], 1)

    def test_accounts_are_independent_and_unassigned_audit_ignored(self):
        self.note("n1", "a1", "2026-10-12T10:00:00.000Z")
        self.audit(None, "task", "completed", "2026-10-12T10:00:00.000Z")   # no account
        s = self.series()
        self.assertEqual(s["a1"][13][2], 1); self.assertEqual(s["a2"][13][2], 0)

    def test_window_edges_utc(self):
        self.note("lo_out", "a1", "2026-09-28T23:59:59.999Z"); self.note("lo_in", "a1", "2026-09-29T00:00:00.000Z")
        self.note("hi_in", "a1", "2026-10-12T23:59:59.999Z"); self.note("hi_out", "a1", "2026-10-13T00:00:00.000Z")
        s = self.series()["a1"]
        self.assertEqual((s[0][2], s[13][2], sum(p[2] for p in s)), (1, 1, 2))

    def test_local_day_buckets_and_dst(self):
        # New York, window Oct 12 minus 13 days .. spans no DST change: day 13 = [Oct 12 04:00Z, Oct 13 04:00Z)
        self.note("a", "a1", "2026-10-12T03:59:59.999Z"); self.note("b", "a1", "2026-10-12T04:00:00.000Z")
        s = self.series(tz=NY)["a1"]
        self.assertEqual((s[12][2], s[13][2]), (1, 1))
        # A window that contains the fall-back day: today = Nov 3 2026; Nov 1 (index 11) is 25 hours long.
        self.DAY = dt.date(2026, 11, 3)
        self.note("c", "a2", "2026-11-02T04:30:00.000Z")                     # 23:30 EST Nov 1 -> index 11, not Nov 2
        self.note("d", "a2", "2026-11-02T05:00:00.000Z")                     # 00:00 EST Nov 2 -> index 12
        s = self.series(tz=NY)["a2"]
        self.assertEqual(s[11][1], "2026-11-01"); self.assertEqual((s[11][2], s[12][2]), (1, 1))

    def test_all_zero_account_in_a_busy_seed_and_parity_with_activity_timeline(self):
        c = seeded(self.DAY)
        c.execute("INSERT INTO clients(id,name,status) VALUES ('quiet','Quiet Mock Fund','Active')")
        p = seed_mock.trend_params(self.DAY, UTC)
        series = {}
        for cid, _n, idx, _d, n in c.execute(TREND_SQL, p):
            series.setdefault(cid, [0] * 14)[idx] = n
        self.assertEqual(series["quiet"], [0] * 14)
        inactive_ids = {r[0] for r in c.execute("SELECT id FROM clients WHERE status='Inactive'")}
        self.assertTrue(inactive_ids and not (inactive_ids & set(series)))
        edges = [p[f"b{i}"] for i in range(15)]
        busy = 0
        for cid, pts in series.items():
            entries = c.execute(TIMELINE_SQL, dict(client_id=cid, filter="all", q_like=None, before_ts=None,
                                                   before_key=None, limit=100000)).fetchall()
            expect = [0] * 14
            for e in entries:
                ts_ = e[0]
                for i in range(14):
                    if edges[i] <= ts_ < edges[i + 1]:
                        expect[i] += 1
            self.assertEqual(pts, expect, cid)
            busy += sum(pts)
        self.assertGreater(busy, 40)

    def test_uses_per_account_indexes(self):
        plan = " ".join(str(r[-1]) for r in self.c.execute("EXPLAIN QUERY PLAN " + TREND_SQL,
                                                           seed_mock.trend_params(self.DAY, UTC)))
        self.assertIn("ix_notes_client_ts", plan)
        self.assertIn("ix_audit_client_ts", plan)


class T61_SeedSamplesAndVerifier(unittest.TestCase):
    def test_sparkline_history_is_seven_days_deterministic_and_covers_the_cases(self):
        day = dt.date(2026, 10, 12)
        c = seeded(day)
        rows = c.execute("SELECT m.id, o.name, m.metric_name, count(*), min(s.sampled_at), max(s.sampled_at), "
                         "count(DISTINCT s.sampled_at) FROM bams_metric_samples s JOIN bams_metrics m ON m.id=s.metric_id "
                         "JOIN bams_objects o ON o.id=m.object_id GROUP BY m.id").fetchall()
        self.assertEqual(len(rows), 24)
        for _id, _o, _m, n, lo, hi, distinct in rows:
            self.assertEqual((n, distinct), (60, 60))                       # 36 four-hourly + 24 hourly, no duplicates
            span = (seed_mock.parse_instant(hi) - seed_mock.parse_instant(lo)).total_seconds() / 86400
            self.assertAlmostEqual(span, 7.0, places=3)                     # 168 h
        self.assertGreaterEqual(len({r[1] for r in rows}), 3)               # at least three servers
        no_samples = c.execute("SELECT count(*) FROM bams_objects o WHERE o.enabled=1 AND NOT EXISTS (SELECT 1 FROM bams_metrics m "
                               "JOIN bams_metric_samples s ON s.metric_id=m.id WHERE m.object_id=o.id)").fetchone()[0]
        self.assertGreaterEqual(no_samples, 1)
        nonc = c.execute("SELECT count(*) FROM bams_alert_events e JOIN bams_metrics m ON m.id=e.metric_id WHERE e.status='open' "
                         "AND e.alert_type<>'stale' AND m.metric_name NOT LIKE '%CPU%' AND EXISTS "
                         "(SELECT 1 FROM bams_metric_samples s WHERE s.metric_id=m.id)").fetchone()[0]
        self.assertGreaterEqual(nonc, 1)
        plan = " ".join(str(r[-1]) for r in c.execute(
            "EXPLAIN QUERY PLAN SELECT sampled_at, value FROM bams_metric_samples WHERE metric_id=? AND sampled_at>=? "
            "ORDER BY sampled_at", ("m", "2026-10-05T00:00:00.000Z")))
        self.assertIn("ix_bams_metric_samples_metric_ts (metric_id=? AND sampled_at>?)", plan)
        # the final sample of each metric equals the metric's current reading's timestamp (rebase is now-relative)
        self.assertEqual(c.execute("SELECT count(*) FROM bams_metrics m WHERE (SELECT max(sampled_at) FROM bams_metric_samples s "
                                   "WHERE s.metric_id=m.id) > m.last_received").fetchone()[0], 0)

    def test_seed_is_additive_only_for_the_untouched_tables(self):
        data = seed_mock.Gen().build()["tables"]
        self.assertEqual(len(data["clients"]), 12)
        self.assertEqual(len(data["notes"]), 210)
        self.assertEqual(len(data["server_upgrades"]), 82)

    def test_verifier_fails_when_the_done_today_history_is_missing(self):
        day = dt.date(2026, 10, 12)
        c = seeded(day)
        c.execute("PRAGMA foreign_keys = OFF")
        triggers = c.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events'").fetchall()
        for (name,) in triggers:
            c.execute(f'DROP TRIGGER "{name}"')
        c.execute("DELETE FROM audit_events WHERE object_type='task' AND action='completed' AND timestamp >= ?",
                  ("2026-10-12T00:00:00.000Z",))
        with redirect_stdout(io.StringIO()) as out:
            ok = seed_mock.verify(c, day)
        self.assertFalse(ok)
        self.assertIn("[FAIL] progress: several plan tasks done today", out.getvalue())


class QA_4_ScannerAdversarialCorpus(unittest.TestCase):
    def test_4_1_generated_banned_corpus_all_flagged(self):
        corpus = banned_corpus()
        self.assertGreater(len(corpus), 500)
        missed = [f"{sfx} [{label}] {text!r}" for sfx, text, label in corpus
                  if not sql_safety_scan.find_violations(text, sfx)]
        self.assertEqual(missed, [], f"{len(missed)} of {len(corpus)} missed")

    def test_4_1_qa_cases_e1_to_e5(self):
        for sfx, text in [
            (".py", 'c.execute(f"REPLACE INTO {table} ({cols}) VALUES ({qs})", vals)'),
            (".py", 'c.execute("REPLACE INTO %s (id, name) VALUES (?, ?)" % table, row)'),
            (".py", 'c.execute("REPLACE INTO {} (id) VALUES (?)".format(t), row)'),
            (".ts", "db.run(`REPLACE INTO ${table} (id) VALUES (?)`, row)"),
            (".sql", "REPLACE INTO clients AS c VALUES (1, 'x');"),
        ]:
            self.assertTrue(sql_safety_scan.find_violations(text, sfx), text)

    def test_4_2_orm_and_other_banned(self):
        missed = [f"{sfx} {t!r}" for sfx, t in ORM_AND_OTHER_BANNED if not sql_safety_scan.find_violations(t, sfx)]
        self.assertEqual(missed, [])

    def test_4_3_legit_code_not_flagged(self):
        fps = [f"{sfx} {t!r} -> {sql_safety_scan.find_violations(t, sfx)}"
               for sfx, t in LEGIT_NOT_FLAGGED if sql_safety_scan.find_violations(t, sfx)]
        self.assertEqual(fps, [])

    def test_4_3_accepted_false_positives_need_a_reasoned_marker(self):
        for sfx, text in ACCEPTED_FALSE_POSITIVES:
            self.assertTrue(sql_safety_scan.find_violations(text, sfx), text)
            marker = "  // sql-safety: allow UI copy, not SQL" if sfx != ".py" else "  # sql-safety: allow user-facing message"
            self.assertEqual(sql_safety_scan.find_violations(text + marker, sfx), [], text)
            bare = "  // sql-safety: allow" if sfx != ".py" else "  # sql-safety: allow"
            hits = sql_safety_scan.find_violations(text + bare, sfx)
            self.assertTrue(hits and "reason is required" in hits[0])

    def test_4_2_encodings_and_scripts_in_a_scratch_tree(self):
        tmp = Path(tempfile.mkdtemp())
        stmt = "REPLACE INTO clients VALUES (1, 'x');\n"
        try:
            files = {
                "db/u16le_bom.sql": codecs.BOM_UTF16_LE + stmt.encode("utf-16-le"),
                "db/u16be_bom.sql": codecs.BOM_UTF16_BE + stmt.encode("utf-16-be"),
                "db/u16le_nobom.sql": stmt.encode("utf-16-le"),
                "db/u8_bom.sql": codecs.BOM_UTF8 + stmt.encode("utf-8"),
                "db/latin1.sql": ("-- café\n" + stmt).encode("latin-1"),
                "launch/run.sh": b'sqlite3 "$DB" "INSERT OR REPLACE INTO t VALUES (1)"\n',
                "launch/run.bat": b'@echo off\r\nsqlite3 %DB% "REPLACE INTO t VALUES (1)"\r\n',
                "launch/run.CMD": b'sqlite3 %DB% "REPLACE INTO t VALUES (1)"\r\n',
                "launch/run.ps1": b'& sqlite3 $db "UPDATE OR REPLACE t SET a = 1"\n',
                "server/repo_helper.py": b'def upsert(c, table, row):\n'
                                         b'    c.execute(f"REPLACE INTO {table} ({cols}) VALUES ({qs})", vals)\n',
                "server/ok.py": b'c.execute(f"INSERT INTO {table} VALUES (?) ON CONFLICT(id) DO NOTHING")\n',
                "server/allowed.py": b'X = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow docs example\n',
                "server/bare.py": b'X = "INSERT OR REPLACE INTO t VALUES (1)"  # sql-safety: allow\n',
                "launch/clean.bat": b'REM never REPLACE INTO t VALUES (1)\r\necho ok\r\n',
            }
            for rel, body in files.items():
                f = tmp / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(body)
            found = sorted({f.split(":")[0] for f in sql_safety_scan.scan(tmp)})
            self.assertEqual(found, sorted([
                "db/u16le_bom.sql", "db/u16be_bom.sql", "db/u16le_nobom.sql", "db/u8_bom.sql", "db/latin1.sql",
                "launch/run.sh", "launch/run.bat", "launch/run.CMD", "launch/run.ps1",
                "server/repo_helper.py", "server/bare.py"]))
            markers = sql_safety_scan.list_allow_markers(tmp)
            self.assertEqual(len(markers), 2)
            self.assertTrue(any("allowed.py" in m and "docs example" in m for m in markers))
            self.assertTrue(any("bare.py" in m and "MISSING" in m for m in markers))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_4_real_tree_clean_and_no_allow_markers(self):
        self.assertEqual(sql_safety_scan.scan(DB_DIR.parent), [])
        self.assertEqual(sql_safety_scan.list_allow_markers(DB_DIR.parent), [])


if __name__ == "__main__":
    unittest.main()


class T122_BamsImportFixtures(unittest.TestCase):
    """Fixture rows for the Run 4 BAMS import (D-63..D-69). No schema change: the existing
    UNIQUE (client_id, name NOCASE), UNIQUE (object_id, metric_name) and ticker UNIQUE carry the exact rules."""
    FIX = Path(seed_mock.DB_DIR) / "fixtures" / "bams_import_rows.json"

    def setUp(self):
        self.rows = json.loads(self.FIX.read_text(encoding="utf-8"))["rows"]
        self.c = seeded(dt.date(2026, 10, 12))

    def by(self, prefix):
        return [r for r in self.rows if r["_expect"].startswith(prefix)]

    def acct(self, r):
        got = self.c.execute("SELECT id, status FROM clients WHERE name = ?", (r["Account"],)).fetchone()
        return got

    def test_fixture_covers_every_case_and_resolves_against_seed(self):
        tags = {r["_expect"] for r in self.rows}
        for need in ("new_appliance", "exact_existing_noop", "new_metric_on_existing", "near_duplicate_of_existing",
                     "near_duplicate_in_file", "same_name_other_account_not_flagged", "invalid_ticker_conflict",
                     "invalid_unknown_account", "invalid_bpid_name_mismatch", "inactive_account_accepted"):
            self.assertIn(need, tags)
        for r in self.rows:
            if r["_expect"] != "invalid_unknown_account":
                self.assertIsNotNone(self.acct(r), r["Account"])
        self.assertIsNone(self.acct(self.by("invalid_unknown_account")[0]))
        self.assertEqual(self.c.execute("SELECT status FROM clients WHERE bpid='3862618'").fetchone()[0], "Inactive")
        mismatch = self.by("invalid_bpid_name_mismatch")[0]
        self.assertNotEqual(self.c.execute("SELECT id FROM clients WHERE bpid=?", (mismatch["BPID"],)).fetchone()[0],
                            self.acct(mismatch)[0])

    def test_db_enforces_exact_rules_the_fixtures_target(self):
        c = self.c
        def has_obj(r):
            return c.execute("SELECT 1 FROM bams_objects WHERE client_id=? AND name=?", (self.acct(r)[0], r["Appliance"])).fetchone()
        self.assertTrue(has_obj(self.by("exact_existing_noop")[0]))                      # NOCASE exact
        for r in self.by("near_duplicate_of_existing"):
            self.assertFalse(has_obj(r), r["Appliance"])                                 # similar, not exact
        a, b = self.by("near_duplicate_in_file")
        self.assertEqual(self.acct(a)[0], self.acct(b)[0])
        self.assertNotEqual(a["Appliance"].lower(), b["Appliance"].lower())
        other = self.by("same_name_other_account_not_flagged")[0]
        self.assertFalse(has_obj(other))
        self.assertEqual(c.execute("SELECT count(*) FROM bams_objects WHERE name=?", (other["Appliance"],)).fetchone()[0], 1)
        tick = self.by("invalid_ticker_conflict")[0]["Ticker"]
        self.assertEqual(c.execute("SELECT count(*) FROM bams_metrics WHERE ticker=?", (tick,)).fetchone()[0], 1)

    def test_valid_rows_insert_and_invalid_rows_are_rejected_by_schema(self):
        c = self.c
        def put(r):
            cid = self.acct(r)[0]
            row = c.execute("SELECT id FROM bams_objects WHERE client_id=? AND name=?", (cid, r["Appliance"])).fetchone()
            oid = row[0] if row else f"fx-o-{abs(hash((cid, r['Appliance']))) % 10**9}"
            if not row:
                c.execute("INSERT INTO bams_objects (id, client_id, name, region, location, environment) VALUES (?,?,?,?,?,?)",
                          (oid, cid, r["Appliance"], r["Region"] or None, r["Location"] or None, (r["Environment"].upper() or None)))
            c.execute("INSERT INTO bams_metrics (id, object_id, metric_name, ticker, stale_after_seconds) VALUES (?,?,?,?,?)",
                      (f"fx-m-{r['Ticker']}", oid, r["Metric"], r["Ticker"], int(r["Stale after (s)"] or 120)))
        before = c.execute("SELECT (SELECT count(*) FROM bams_objects), (SELECT count(*) FROM bams_metrics)").fetchone()
        ok = [r for r in self.rows if r["_expect"] in ("new_appliance", "new_appliance_first_account", "new_metric_on_existing",
              "near_duplicate_of_existing", "near_duplicate_in_file", "same_name_other_account_not_flagged", "inactive_account_accepted")]
        for r in ok:
            c.execute("SAVEPOINT s"); put(r); c.execute("RELEASE s")
        after = c.execute("SELECT (SELECT count(*) FROM bams_objects), (SELECT count(*) FROM bams_metrics)").fetchone()
        self.assertEqual((after[0] - before[0], after[1] - before[1]), (8, len(ok)))      # 8 new appliances (hfa-03 has 2 rows; kmc-01 already exists)
        for tag in ("exact_existing_noop",):
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("SAVEPOINT s"); put(self.by(tag)[0])
            c.execute("ROLLBACK TO s"); c.execute("RELEASE s")
        for tag in ("invalid_ticker_conflict", "invalid_ticker_repeated_in_file", "invalid_environment",
                    "invalid_stale_after", "invalid_over_limit"):
            with self.subTest(tag):
                with self.assertRaises(sqlite3.IntegrityError):
                    c.execute("SAVEPOINT s"); put(self.by(tag)[0])
                c.execute("ROLLBACK TO s"); c.execute("RELEASE s")
        self.assertEqual(c.execute("PRAGMA foreign_key_check").fetchall(), [])
