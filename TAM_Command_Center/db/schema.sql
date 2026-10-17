-- =============================================================================
-- TAM Command Center: canonical schema snapshot
-- Schema version: 1          (D-01: clean line, no in-place upgrade from legacy)
-- Owner: data-architect-agent (Phase 1.2).  Rationale: docs/03_DATA_MODEL.md
--
-- This file is the CUMULATIVE snapshot of the latest schema. Databases are
-- built and upgraded ONLY through db/migrations/NNNN_*.sql (runner: db/migrate.py).
-- `python db/migrate.py --verify-schema` proves the migration chain produces
-- exactly this schema. For v1, migrations/0001_initial.sql == this file.
--
-- Conventions (binding; see 03_DATA_MODEL.md §2):
--   * Instants (created_at, updated_at, notes.timestamp, audit timestamp,
--     BAMS times) are ISO-8601 UTC, fixed width, millisecond precision:
--         YYYY-MM-DDTHH:MM:SS.sssZ    e.g. 2026-10-12T14:05:00.123Z
--     Enforced by
--         x IS strftime('%Y-%m-%dT%H:%M:%fZ', x)        -- exact canonical text
--         AND substr(x,1,10) IS date(x, '+0 days')       -- real calendar day
--     so text comparison == chronological comparison.
--   * All-day fields (due, next_update, last_contact, next_contact,
--     scheduled_date, window dates) are YYYY-MM-DD, no timezone (D-06).
--     Enforced by  x IS date(x, '+0 days').
--   * Why IS and '+0 days': a CHECK whose expression is NULL PASSES in SQLite,
--     and date('2026-10-1') is NULL, so '=' would let garbage through. And
--     date('2026-02-30') echoes its input; only a modifier forces normalisation.
--   * Booleans are INTEGER 0/1 with CHECK.
--   * Entity ids are TEXT (application-generated UUIDs). Append-only logs
--     (audit_events, bams_metric_samples, bams_notification_log) use
--     INTEGER AUTOINCREMENT ids (monotonic, never reused).
--   * updated_at is informational (display, "Updated" column). The app sets it
--     on every UPDATE; it is NOT the concurrency token and carries no ordering
--     CHECK against created_at, so a wall-clock step back cannot make edits fail.
--   * row_version (INTEGER, starts at 1) is the D-11 optimistic-concurrency
--     token on every editable entity table; triggers guarantee each UPDATE
--     advances it by exactly 1 (section "Write-safety triggers").
--   * BANNED everywhere (03_DATA_MODEL.md §2.1): the REPLACE conflict
--     algorithm in any spelling: INSERT OR REPLACE, REPLACE INTO,
--     UPDATE OR REPLACE, ON CONFLICT REPLACE (DDL), ORM "OR REPLACE" prefixes.
--     Use plain INSERT, UPDATE ... WHERE row_version = ?, or
--     INSERT ... ON CONFLICT(<key>) DO UPDATE / DO NOTHING (both allowed).
--   * Duplicate-key error contract: every uniqueness failure, whether raised
--     by SQLite or by a guard trigger here, is an IntegrityError whose message
--     starts with 'UNIQUE constraint failed: <table>'.
--
-- Connection contract (the opener sets these; they cannot live in a migration
-- because journal_mode cannot change inside a transaction):
--   PRAGMA journal_mode = WAL;  PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;
--
-- Portability: SQLite >= 3.35 (Python 3.10 on Windows ships >= 3.35).
-- Deliberately NOT used: STRICT tables, json_valid() in CHECKs (JSON1 is not
-- guaranteed in every Windows CPython build), generated columns.
--
-- No vector index / embedding table exists or is planned: the spec replaced
-- RAG with the ChatGPT Bridge. No health score, sales or CMDB fields.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- 'TAMC' = 0x54414D43. Lets the app refuse to migrate a foreign SQLite file (§46).
PRAGMA application_id = 1413565763;

-- -----------------------------------------------------------------------------
-- app_meta: schema_version, settings (`setting.*`), migration flags
-- (`migration.*`), maintenance flags (`maintenance.*`), schedule diagnostics
-- cache (`schedule.*`, Phase 3), mock-seed stamp (`db.mock_seed`).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
    value TEXT NOT NULL
) WITHOUT ROWID;

-- -----------------------------------------------------------------------------
-- clients (accounts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
    id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    name         TEXT NOT NULL COLLATE NOCASE UNIQUE
                 CHECK (length(name) BETWEEN 1 AND 200 AND name = trim(name) AND NOT name GLOB ('*[' || char(9,10,13) || ']*')),
    status       TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
    bpid         TEXT CHECK (bpid IS NULL OR (length(bpid) BETWEEN 1 AND 32 AND bpid = trim(bpid))),
    products     TEXT CHECK (products IS NULL OR length(products) <= 500),
    contact      TEXT CHECK (contact IS NULL OR length(contact) <= 500),  -- legacy free text (§33); new code uses `contacts`
    last_contact TEXT CHECK (last_contact IS NULL OR last_contact IS date(last_contact, '+0 days')),
    next_contact TEXT CHECK (next_contact IS NULL OR next_contact IS date(next_contact, '+0 days')),
    notes        TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days')))
);

-- Today tier 4 (next_contact <= T) and Upcoming (T < next_contact <= T+14).
CREATE INDEX IF NOT EXISTS ix_clients_next_contact_active
    ON clients (next_contact) WHERE status = 'Active' AND next_contact IS NOT NULL;

-- -----------------------------------------------------------------------------
-- contacts: lightweight; at most one primary per account (§13)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    id         TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name = trim(name) AND NOT name GLOB ('*[' || char(9,10,13) || ']*')),
    role       TEXT CHECK (role IS NULL OR length(role) <= 200),
    email      TEXT CHECK (email IS NULL OR (length(email) <= 254 AND email LIKE '%_@_%._%'
                                             AND email NOT LIKE '% %')),
    team       TEXT CHECK (team IS NULL OR length(team) <= 200),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days')))
);

CREATE INDEX IF NOT EXISTS ix_contacts_client ON contacts (client_id, is_primary DESC, name);
-- Spec invariant "exactly one or zero primary": enforced by the database.
-- UNIQUE is checked per row, so a primary switch must clear the old flag
-- BEFORE setting the new one (two statements, one transaction).
CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_one_primary
    ON contacts (client_id) WHERE is_primary = 1;

-- -----------------------------------------------------------------------------
-- tasks (§11). client_id NULL = internal / "No account" task (D-20).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    task        TEXT NOT NULL CHECK (length(task) BETWEEN 1 AND 500 AND task = trim(task)
                     AND NOT task GLOB ('*[' || char(9,10,13) || ']*')),
    client_id   TEXT NULL REFERENCES clients (id) ON DELETE CASCADE,
    category    TEXT NOT NULL DEFAULT 'Other' CHECK (category IN (
                    'Client Follow-Up','Engineering Follow-Up','Reporting','Internal',
                    'Escalation','Onboarding','Entitlements','Usage Review','Meeting','Other')),
    priority    TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('High','Medium','Low')),
    due         TEXT CHECK (due IS NULL OR due IS date(due, '+0 days')),
    next_update TEXT CHECK (next_update IS NULL OR next_update IS date(next_update, '+0 days')),
    status      TEXT NOT NULL DEFAULT 'Not Started'
                CHECK (status IN ('Not Started','In Progress','Waiting','Complete')),
    waiting     TEXT CHECK (waiting IS NULL OR length(waiting) <= 500),
    notes       TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days')))
);

-- Account Tasks tab / Overview top tasks / Account Load counts (FK child index too).
CREATE INDEX IF NOT EXISTS ix_tasks_client_open ON tasks (client_id, archived, status, due);
-- Today queue: the single pass over open, non-archived tasks (all task tiers + Upcoming).
-- Indexes exist only where a reference query (db/queries) or an FK uses them;
-- Phase 3/4 add their own via forward migrations (QA-1-10).
CREATE INDEX IF NOT EXISTS ix_tasks_open_due
    ON tasks (due) WHERE archived = 0 AND status <> 'Complete';

-- -----------------------------------------------------------------------------
-- notes: MANUAL notes only. System events are never copied here (D-03).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    client_id    TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    note_type    TEXT NOT NULL CHECK (note_type IN ('Meeting Note','Call Note','General Note')),
    timestamp    TEXT NOT NULL CHECK ((timestamp IS strftime('%Y-%m-%dT%H:%M:%fZ', timestamp) AND substr(timestamp, 1, 10) IS date(timestamp, '+0 days'))),
    subject      TEXT CHECK (subject IS NULL OR length(subject) <= 200),
    body         TEXT CHECK (body IS NULL OR length(body) <= 50000),
    action_items TEXT CHECK (action_items IS NULL OR length(action_items) <= 10000),
    source       TEXT NOT NULL DEFAULT 'GUI'   -- no 'System': notes are manual only (D-03)
                 CHECK (source IN ('GUI','Migration','Bulk Import','ChatGPT Bridge')),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    CHECK (length(trim(coalesce(subject,''))) > 0 OR length(trim(coalesce(body,''))) > 0)
);

-- Activity timeline (per account, newest first, keyset pagination).
CREATE INDEX IF NOT EXISTS ix_notes_client_ts ON notes (client_id, timestamp DESC, id DESC);

-- -----------------------------------------------------------------------------
-- support_cases: §33 "optional but supported". No UI or API this run.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_cases (
    id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    client_id    TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    case_type    TEXT CHECK (case_type IS NULL OR length(case_type) <= 50),
    reference_id TEXT CHECK (reference_id IS NULL OR length(reference_id) <= 100),
    summary      TEXT CHECK (summary IS NULL OR length(summary) <= 2000),
    escalated    INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days')))
);
CREATE INDEX IF NOT EXISTS ix_support_cases_client ON support_cases (client_id);

-- -----------------------------------------------------------------------------
-- audit_events: centralized, append-only history (§35, US-1.5).
-- client_id has NO foreign key on purpose (D-12): history must survive an
-- account delete. Rows are immutable (trigger below).
-- old_value / new_value: JSON objects of the CHANGED fields (app-validated).
-- object_label: denormalised display label (see 03_DATA_MODEL.md §7).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                CHECK ((timestamp IS strftime('%Y-%m-%dT%H:%M:%fZ', timestamp) AND substr(timestamp, 1, 10) IS date(timestamp, '+0 days'))),
    category    TEXT NOT NULL CHECK (category IN ('crm','operations','bams','settings','data','system')),
    client_id   TEXT NULL,
    object_type TEXT NOT NULL CHECK (object_type IN (
                    'client','contact','task','note','support_case',
                    'server_upgrade','quarterly_upgrade_window',
                    'bams_object','bams_metric','bams_alert_rule','bams_alert_event','bams_alert_config',
                    'setting','backup','schema','import','bridge')),
    object_id   TEXT CHECK (object_id IS NULL OR length(object_id) BETWEEN 1 AND 200),
    -- Display snapshot taken at write time (task title, contact name, note
    -- subject, server name, account name, setting key). Lets Activity render
    -- "Task completed: <title>" even after the object or account is deleted.
    object_label TEXT CHECK (object_label IS NULL OR length(object_label) <= 500),
    action      TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40
                                     AND action NOT GLOB '*[^a-z_]*'),
    old_value   TEXT,
    new_value   TEXT,
    reason      TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
    source      TEXT NOT NULL CHECK (source IN ('GUI','System','Migration','Bulk Import','ChatGPT Bridge'))
);

-- Activity timeline system events (per account, newest first).
CREATE INDEX IF NOT EXISTS ix_audit_client_ts ON audit_events (client_id, timestamp DESC, id DESC)
    WHERE client_id IS NOT NULL;
-- Recently Changed (global, newest first) and audit log browsing.
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_events (timestamp DESC, id DESC);
-- "History of this object" lookups (task drawer, upgrade history, deleted-note lookups).
CREATE INDEX IF NOT EXISTS ix_audit_object ON audit_events (object_type, object_id, timestamp);

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- Deletes: refused for rows newer than 14 days (schema 2, user decision 2026-10-16; the 14-day prune job is the only
-- caller that can delete, and only past the window). UPDATE stays refused. The other purge path (DEV reseed) is
-- migrate.purge_audit_events(), which DROPs this trigger, deletes and re-CREATEs it inside ONE transaction (DDL is
-- transactional), so no persistent flag can leave audit deletes enabled. migrate.assert_guards() refuses to open a
-- DB where any guard trigger is missing or altered.
-- REPLACE / INSERT OR REPLACE resolve a PK conflict by deleting the old row
-- WITHOUT firing delete triggers (recursive_triggers is off by default), so
-- an insert that reuses an existing id is refused outright.
CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_replace
BEFORE INSERT ON audit_events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN OLD.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
BEGIN
    SELECT RAISE(ABORT, 'audit_events rows newer than 14 days cannot be deleted');
END;

-- -----------------------------------------------------------------------------
-- Operations (Phase 3; read by Today/Infrastructure this run, D-02)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quarterly_upgrade_windows (
    schedule_year        INTEGER NOT NULL CHECK (schedule_year BETWEEN 2000 AND 2100),
    schedule_quarter     TEXT NOT NULL CHECK (schedule_quarter IN ('Q1','Q2','Q3','Q4')),
    notification_date    TEXT CHECK (notification_date IS NULL OR notification_date IS date(notification_date, '+0 days')),
    dev_upgrade_date     TEXT CHECK (dev_upgrade_date IS NULL OR dev_upgrade_date IS date(dev_upgrade_date, '+0 days')),
    east_prod_date       TEXT CHECK (east_prod_date IS NULL OR east_prod_date IS date(east_prod_date, '+0 days')),
    west_prod_date       TEXT CHECK (west_prod_date IS NULL OR west_prod_date IS date(west_prod_date, '+0 days')),
    apics_version        TEXT CHECK (apics_version IS NULL OR length(apics_version) <= 50),
    cd_rules_version     TEXT CHECK (cd_rules_version IS NULL OR length(cd_rules_version) <= 50),
    mfa_software_version TEXT CHECK (mfa_software_version IS NULL OR length(mfa_software_version) <= 50),
    mfa_rules_version    TEXT CHECK (mfa_rules_version IS NULL OR length(mfa_rules_version) <= 50),
    maintenance_window   TEXT CHECK (maintenance_window IS NULL OR length(maintenance_window) <= 200),
    source_url           TEXT CHECK (source_url IS NULL OR length(source_url) <= 2000),
    source_sync_at       TEXT CHECK (source_sync_at IS NULL OR (source_sync_at IS strftime('%Y-%m-%dT%H:%M:%fZ', source_sync_at) AND substr(source_sync_at, 1, 10) IS date(source_sync_at, '+0 days'))),
    source_sync_method   TEXT CHECK (source_sync_method IS NULL OR source_sync_method IN
                                     ('live','bundled_fallback','manual','mock')),
    source_fingerprint   TEXT CHECK (source_fingerprint IS NULL OR length(source_fingerprint) <= 128),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                         CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    PRIMARY KEY (schedule_year, schedule_quarter)
);

CREATE TABLE IF NOT EXISTS server_upgrades (
    id                 TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    client_id          TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    server_name        TEXT NOT NULL COLLATE NOCASE
                       CHECK (length(server_name) BETWEEN 1 AND 200 AND server_name = trim(server_name)
                            AND NOT server_name GLOB ('*[' || char(9,10,13) || ']*')),
    environment        TEXT NOT NULL CHECK (environment IN ('PROD','DEV')),
    polarity           TEXT NOT NULL CHECK (polarity IN ('East','West','DEV')),
    schedule_year      INTEGER,
    schedule_quarter   TEXT,
    current_version    TEXT CHECK (current_version IS NULL OR length(current_version) <= 50),
    target_version     TEXT CHECK (target_version IS NULL OR length(target_version) <= 50),
    scheduled_date     TEXT CHECK (scheduled_date IS NULL OR scheduled_date IS date(scheduled_date, '+0 days')),
    maintenance_window TEXT CHECK (maintenance_window IS NULL OR length(maintenance_window) <= 200),
    status             TEXT NOT NULL DEFAULT 'Planned' CHECK (status IN (
                           'Planned','Awaiting Client','Scheduled','In Progress',
                           'Validation Required','Completed','Deferred','Exception')),
    validation_status  TEXT NOT NULL DEFAULT 'Pending'
                       CHECK (validation_status IN ('Pending','Passed','Failed','Not Required')),
    waiting_on         TEXT CHECK (waiting_on IS NULL OR length(waiting_on) <= 500),
    reference          TEXT CHECK (reference IS NULL OR length(reference) <= 200),
    notes              TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    source_url         TEXT CHECK (source_url IS NULL OR length(source_url) <= 2000),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                       CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                       CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    -- §22: PROD requires East or West; DEV normalizes polarity to DEV.
    CHECK ((environment = 'PROD' AND polarity IN ('East','West'))
        OR (environment = 'DEV'  AND polarity = 'DEV')),
    -- A release is identified by both columns or neither (ad-hoc upgrade).
    CHECK ((schedule_year IS NULL) = (schedule_quarter IS NULL)),
    -- §20: schedule rows must never be wiped out from under upgrade records.
    FOREIGN KEY (schedule_year, schedule_quarter)
        REFERENCES quarterly_upgrade_windows (schedule_year, schedule_quarter)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- §25 import identity: Account + Server + Release (re-import = update).
CREATE UNIQUE INDEX IF NOT EXISTS ux_server_upgrades_identity
    ON server_upgrades (client_id, server_name, schedule_year, schedule_quarter);
-- Ad-hoc (no release) identity: Account + Server + scheduled_date, with a NULL
-- date counting as one value (coalesce), because NULLs are otherwise distinct.
CREATE UNIQUE INDEX IF NOT EXISTS ux_server_upgrades_adhoc_identity
    ON server_upgrades (client_id, server_name, coalesce(scheduled_date, '')) WHERE schedule_year IS NULL;
-- Infrastructure tab / next-upgrade per account (FK child index via leading client_id).
CREATE INDEX IF NOT EXISTS ix_server_upgrades_client_date ON server_upgrades (client_id, scheduled_date);
-- FK child index for the composite release reference.
CREATE INDEX IF NOT EXISTS ix_server_upgrades_release ON server_upgrades (schedule_year, schedule_quarter);

-- -----------------------------------------------------------------------------
-- BAMS (Phase 4; seeded and read-only this run, D-02)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bams_objects (
    id          TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    client_id   TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 200 AND name = trim(name) AND NOT name GLOB ('*[' || char(9,10,13) || ']*')),
    region      TEXT CHECK (region IS NULL OR length(region) <= 100),
    location    TEXT CHECK (location IS NULL OR length(location) <= 200),
    environment TEXT CHECK (environment IS NULL OR environment IN ('PROD','DEV')),  -- addition: §14 environment summary
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    UNIQUE (client_id, name)
);

CREATE TABLE IF NOT EXISTS bams_metrics (
    id                  TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    object_id           TEXT NOT NULL REFERENCES bams_objects (id) ON DELETE CASCADE,
    metric_name         TEXT NOT NULL CHECK (length(metric_name) BETWEEN 1 AND 200),
    ticker              TEXT NOT NULL UNIQUE CHECK (length(ticker) BETWEEN 1 AND 200 AND ticker = trim(ticker)),
    current_value       REAL,
    last_source_update  TEXT CHECK (last_source_update IS NULL OR (last_source_update IS strftime('%Y-%m-%dT%H:%M:%fZ', last_source_update) AND substr(last_source_update, 1, 10) IS date(last_source_update, '+0 days'))),
    last_received       TEXT CHECK (last_received IS NULL OR (last_received IS strftime('%Y-%m-%dT%H:%M:%fZ', last_received) AND substr(last_received, 1, 10) IS date(last_received, '+0 days'))),
    high_30             REAL,
    high_30_date        TEXT CHECK (high_30_date IS NULL OR high_30_date IS date(high_30_date, '+0 days')),
    high_60             REAL,
    high_60_date        TEXT CHECK (high_60_date IS NULL OR high_60_date IS date(high_60_date, '+0 days')),
    high_90             REAL,
    high_90_date        TEXT CHECK (high_90_date IS NULL OR high_90_date IS date(high_90_date, '+0 days')),
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    stale_after_seconds INTEGER NOT NULL DEFAULT 120 CHECK (stale_after_seconds > 0),
    stale_suppressed    INTEGER NOT NULL DEFAULT 0 CHECK (stale_suppressed IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                        CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                        CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    UNIQUE (object_id, metric_name)
);

CREATE TABLE IF NOT EXISTS bams_alert_rules (
    id                   TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    metric_id            TEXT NOT NULL REFERENCES bams_metrics (id) ON DELETE CASCADE,
    rule_type            TEXT NOT NULL CHECK (rule_type IN ('fixed_threshold','pct_of_high','exceeds_high')),
    operator             TEXT NOT NULL CHECK (operator IN ('>','>=','<','<=')),
    threshold            REAL,
    reference_period     TEXT CHECK (reference_period IS NULL OR reference_period IN ('30d','60d','90d')),
    consecutive_updates  INTEGER NOT NULL DEFAULT 1 CHECK (consecutive_updates >= 1),
    severity             TEXT NOT NULL CHECK (severity IN ('Info','Warning','Critical')),
    cooldown_minutes     INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_minutes >= 0),
    enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    breach_count         INTEGER NOT NULL DEFAULT 0 CHECK (breach_count >= 0),
    suppress_until_clear INTEGER NOT NULL DEFAULT 0 CHECK (suppress_until_clear IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                         CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                         CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    -- fixed: absolute threshold, no reference; pct: % of a historical high;
    -- exceeds: value vs the historical high itself (threshold unused).
    CHECK ((rule_type = 'fixed_threshold' AND threshold IS NOT NULL AND reference_period IS NULL)
        OR (rule_type = 'pct_of_high'     AND threshold > 0       AND reference_period IS NOT NULL)
        OR (rule_type = 'exceeds_high'    AND reference_period IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_bams_alert_rules_metric ON bams_alert_rules (metric_id);

CREATE TABLE IF NOT EXISTS bams_alert_events (
    id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    metric_id         TEXT NOT NULL REFERENCES bams_metrics (id) ON DELETE CASCADE,
    rule_id           TEXT NULL REFERENCES bams_alert_rules (id) ON DELETE SET NULL,
    alert_type        TEXT NOT NULL CHECK (alert_type IN ('fixed_threshold','pct_of_high','exceeds_high','stale')),
    severity          TEXT NOT NULL CHECK (severity IN ('Info','Warning','Critical')),
    message           TEXT CHECK (message IS NULL OR length(message) <= 1000),
    opened_at         TEXT NOT NULL CHECK ((opened_at IS strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) AND substr(opened_at, 1, 10) IS date(opened_at, '+0 days'))),
    last_triggered_at TEXT CHECK (last_triggered_at IS NULL OR (last_triggered_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_triggered_at) AND substr(last_triggered_at, 1, 10) IS date(last_triggered_at, '+0 days'))),
    recovered_at      TEXT CHECK (recovered_at IS NULL OR (recovered_at IS strftime('%Y-%m-%dT%H:%M:%fZ', recovered_at) AND substr(recovered_at, 1, 10) IS date(recovered_at, '+0 days'))),
    closed_at         TEXT CHECK (closed_at IS NULL OR (closed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) AND substr(closed_at, 1, 10) IS date(closed_at, '+0 days'))),
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','recovered','closed')),
    current_value     REAL,
    trigger_value     REAL,
    peak_value        REAL,
    closed_note       TEXT CHECK (closed_note IS NULL OR length(closed_note) <= 2000),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                      CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                      CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    -- §27 lifecycle: open -> recovered (awaiting close) -> closed; recovery
    -- never closes; a close while still breaching has no recovered_at.
    CHECK ((status = 'open'      AND recovered_at IS NULL     AND closed_at IS NULL)
        OR (status = 'recovered' AND recovered_at IS NOT NULL AND closed_at IS NULL)
        OR (status = 'closed'    AND closed_at IS NOT NULL)),
    CHECK (recovered_at IS NULL OR recovered_at >= opened_at),
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
    CHECK (closed_at IS NULL OR recovered_at IS NULL OR closed_at >= recovered_at),
    CHECK (last_triggered_at IS NULL OR last_triggered_at >= opened_at),
    CHECK (alert_type <> 'stale' OR rule_id IS NULL)  -- stale alerts are not rule-driven
);

-- §27 "repeated breaches update the existing event": at most one non-closed
-- event per (metric, rule). Stale alerts (rule_id NULL) get one per metric.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bams_alert_events_one_active
    ON bams_alert_events (metric_id, coalesce(rule_id, '')) WHERE status <> 'closed';
-- Per-metric history and Activity BAMS entries (FK child index).
CREATE INDEX IF NOT EXISTS ix_bams_alert_events_metric ON bams_alert_events (metric_id, opened_at);
CREATE INDEX IF NOT EXISTS ix_bams_alert_events_rule ON bams_alert_events (rule_id) WHERE rule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bams_metric_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_id     TEXT NOT NULL REFERENCES bams_metrics (id) ON DELETE CASCADE,
    sampled_at    TEXT NOT NULL CHECK ((sampled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', sampled_at) AND substr(sampled_at, 1, 10) IS date(sampled_at, '+0 days'))),
    source_update TEXT CHECK (source_update IS NULL OR (source_update IS strftime('%Y-%m-%dT%H:%M:%fZ', source_update) AND substr(source_update, 1, 10) IS date(source_update, '+0 days'))),
    value         REAL NOT NULL
);
-- Trend queries are always "one metric, time range" (§45: never load all samples).
CREATE INDEX IF NOT EXISTS ix_bams_metric_samples_metric_ts ON bams_metric_samples (metric_id, sampled_at);

CREATE TABLE IF NOT EXISTS bams_alert_configs (
    id                  TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
    name                TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
    metric_match        TEXT NOT NULL CHECK (length(metric_match) BETWEEN 1 AND 200),  -- GLOB on metric_name
    rule_type           TEXT NOT NULL CHECK (rule_type IN ('fixed_threshold','pct_of_high','exceeds_high')),
    operator            TEXT NOT NULL CHECK (operator IN ('>','>=','<','<=')),
    threshold           REAL,
    reference_period    TEXT CHECK (reference_period IS NULL OR reference_period IN ('30d','60d','90d')),
    consecutive_updates INTEGER NOT NULL DEFAULT 1 CHECK (consecutive_updates >= 1),
    severity            TEXT NOT NULL CHECK (severity IN ('Info','Warning','Critical')),
    cooldown_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_minutes >= 0),
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    starter             INTEGER NOT NULL DEFAULT 0 CHECK (starter IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),  -- D-11 concurrency token
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                        CHECK ((created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AND substr(created_at, 1, 10) IS date(created_at, '+0 days'))),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                        CHECK ((updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND substr(updated_at, 1, 10) IS date(updated_at, '+0 days'))),
    CHECK ((rule_type = 'fixed_threshold' AND threshold IS NOT NULL AND reference_period IS NULL)
        OR (rule_type = 'pct_of_high'     AND threshold > 0       AND reference_period IS NOT NULL)
        OR (rule_type = 'exceeds_high'    AND reference_period IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS bams_notification_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT NOT NULL REFERENCES bams_alert_events (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('opened','recovered','closed','reminder')),
    channel      TEXT NOT NULL CHECK (channel IN ('in_app','desktop')),
    attempted_at TEXT NOT NULL CHECK ((attempted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) AND substr(attempted_at, 1, 10) IS date(attempted_at, '+0 days'))),
    success      INTEGER NOT NULL CHECK (success IN (0,1)),
    detail       TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
    UNIQUE (event_id, kind, channel)
);

-- -----------------------------------------------------------------------------
-- Write-safety triggers (QA reviews 1-2: QA-1-2, QA-1-3, QA-1-8, QA-2-1, QA-2-2)
-- -----------------------------------------------------------------------------
-- (a) REPLACE protection without breaking legitimate upserts (QA-2-1, QA-2-2).
--
--     INSERT path: NO secondary-key guards, on purpose. A BEFORE INSERT
--     RAISE fires before conflict resolution, so it would also abort the
--     legitimate natural-key idioms: §25 re-import ON CONFLICT(identity) DO
--     UPDATE, notification-log insert-once (DO NOTHING / INSERT OR IGNORE),
--     ticker and account-name upserts. INSERT OR REPLACE / REPLACE INTO are
--     therefore banned by contract and caught by db/sql_safety_scan.py,
--     which a contract test runs over the whole codebase. Single exception: the
--     primary contact, where no keyed upsert is ever legitimate.
--
--     UPDATE path: UPDATE OR REPLACE fires no INSERT trigger and silently
--     deletes the OTHER row that holds the key. A legitimate UPDATE never
--     moves a key onto another row's value (it would fail UNIQUE anyway), so a
--     BEFORE UPDATE guard costs nothing legitimate. Every secondary unique key
--     is guarded, and ids are immutable (which closes PK UPDATE OR REPLACE).
--     Messages copy SQLite's own 'UNIQUE constraint failed: ...' wording so
--     the backend maps every duplicate to 409 conflict the same way.

CREATE TRIGGER IF NOT EXISTS trg_contacts_one_primary_on_insert
BEFORE INSERT ON contacts
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM contacts WHERE client_id = NEW.client_id AND is_primary = 1 AND id IS NOT NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: contacts.client_id (one primary contact per account)');
END;

CREATE TRIGGER IF NOT EXISTS trg_contacts_one_primary_on_update
BEFORE UPDATE OF is_primary, client_id ON contacts
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM contacts WHERE client_id = NEW.client_id AND is_primary = 1 AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: contacts.client_id (one primary contact per account)');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_unique_name_on_update
BEFORE UPDATE OF name ON clients
WHEN EXISTS (SELECT 1 FROM clients WHERE name = NEW.name AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: clients.name');
END;

CREATE TRIGGER IF NOT EXISTS trg_upgrade_windows_unique_on_update
BEFORE UPDATE OF schedule_year, schedule_quarter ON quarterly_upgrade_windows
WHEN EXISTS (SELECT 1 FROM quarterly_upgrade_windows WHERE schedule_year = NEW.schedule_year AND schedule_quarter = NEW.schedule_quarter AND rowid <> OLD.rowid)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: quarterly_upgrade_windows.schedule_year, quarterly_upgrade_windows.schedule_quarter');
END;

CREATE TRIGGER IF NOT EXISTS trg_server_upgrades_unique_on_update
BEFORE UPDATE OF client_id, server_name, schedule_year, schedule_quarter, scheduled_date ON server_upgrades
WHEN (NEW.schedule_year IS NOT NULL AND EXISTS (SELECT 1 FROM server_upgrades
        WHERE client_id = NEW.client_id AND server_name = NEW.server_name
          AND schedule_year = NEW.schedule_year AND schedule_quarter = NEW.schedule_quarter AND id <> OLD.id))
  OR (NEW.schedule_year IS NULL AND EXISTS (SELECT 1 FROM server_upgrades
        WHERE client_id = NEW.client_id AND server_name = NEW.server_name AND schedule_year IS NULL
          AND coalesce(scheduled_date, '') = coalesce(NEW.scheduled_date, '') AND id <> OLD.id))
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: server_upgrades identity (account + server + release)');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_objects_unique_on_update
BEFORE UPDATE OF client_id, name ON bams_objects
WHEN EXISTS (SELECT 1 FROM bams_objects WHERE client_id = NEW.client_id AND name = NEW.name AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: bams_objects.client_id, bams_objects.name');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_metrics_unique_on_update
BEFORE UPDATE OF ticker, object_id, metric_name ON bams_metrics
WHEN EXISTS (SELECT 1 FROM bams_metrics WHERE (ticker = NEW.ticker
          OR (object_id = NEW.object_id AND metric_name = NEW.metric_name)) AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: bams_metrics.ticker / bams_metrics.object_id, bams_metrics.metric_name');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_alert_events_one_active_on_update
BEFORE UPDATE OF metric_id, rule_id, status ON bams_alert_events
WHEN NEW.status <> 'closed' AND EXISTS (SELECT 1 FROM bams_alert_events WHERE metric_id = NEW.metric_id
          AND coalesce(rule_id, '') = coalesce(NEW.rule_id, '') AND status <> 'closed' AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: index ux_bams_alert_events_one_active');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_alert_configs_unique_on_update
BEFORE UPDATE OF name ON bams_alert_configs
WHEN EXISTS (SELECT 1 FROM bams_alert_configs WHERE name = NEW.name AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: bams_alert_configs.name');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_notification_log_unique_on_update
BEFORE UPDATE OF event_id, kind, channel ON bams_notification_log
WHEN EXISTS (SELECT 1 FROM bams_notification_log WHERE event_id = NEW.event_id AND kind = NEW.kind AND channel = NEW.channel AND id <> OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'UNIQUE constraint failed: bams_notification_log.event_id, bams_notification_log.kind, bams_notification_log.channel');
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_id_immutable
BEFORE UPDATE OF id ON clients
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'clients.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_contacts_id_immutable
BEFORE UPDATE OF id ON contacts
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'contacts.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_id_immutable
BEFORE UPDATE OF id ON tasks
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'tasks.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_id_immutable
BEFORE UPDATE OF id ON notes
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'notes.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_cases_id_immutable
BEFORE UPDATE OF id ON support_cases
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'support_cases.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_server_upgrades_id_immutable
BEFORE UPDATE OF id ON server_upgrades
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'server_upgrades.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_objects_id_immutable
BEFORE UPDATE OF id ON bams_objects
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_objects.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_metrics_id_immutable
BEFORE UPDATE OF id ON bams_metrics
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_metrics.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_alert_rules_id_immutable
BEFORE UPDATE OF id ON bams_alert_rules
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_rules.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_alert_events_id_immutable
BEFORE UPDATE OF id ON bams_alert_events
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_events.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_alert_configs_id_immutable
BEFORE UPDATE OF id ON bams_alert_configs
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_configs.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_metric_samples_id_immutable
BEFORE UPDATE OF id ON bams_metric_samples
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_metric_samples.id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_bams_notification_log_id_immutable
BEFORE UPDATE OF id ON bams_notification_log
WHEN NEW.id IS NOT OLD.id
BEGIN
    SELECT RAISE(ABORT, 'bams_notification_log.id is immutable');
END;

-- (b) §27 / Phase 4 contract enforced: a rule with non-closed events cannot be
--     deleted directly (close them first). Otherwise SET NULL would move the
--     open event into the metric's 'stale' slot of ux_bams_alert_events_one_active.
--     Cascades from a deleted metric/object/account are allowed: the parent row
--     is already gone when this fires, and the events cascade away too.
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_rules_no_delete_active
BEFORE DELETE ON bams_alert_rules
WHEN EXISTS (SELECT 1 FROM bams_alert_events WHERE rule_id = OLD.id AND status <> 'closed')
 AND EXISTS (SELECT 1 FROM bams_metrics WHERE id = OLD.metric_id)
BEGIN
    SELECT RAISE(ABORT, 'close this rule''s active alerts before deleting the rule');
END;

-- (c) D-11 optimistic concurrency token. Every UPDATE advances row_version by
--     exactly 1: either the statement does `row_version = row_version + 1`, or
--     the AFTER trigger bumps it. Writers use
--         UPDATE t SET ... WHERE id = :id AND row_version = :expected
--     and map rowcount 0 to 409 stale_write. Clock-independent (QA-1-3).
--     FK actions (ON DELETE SET NULL) also bump it, which is correct.
--     Exceptions (QA-2-6): bams_metrics and bams_alert_rules bump only on
--     configuration columns, so 60 s monitor writes never 409 a user's edit.
--     Alert close does not use the token at all: it is a status-conditional
--     UPDATE ... WHERE id = ? AND status IN ('open','recovered').
--     RETURNING trap (QA-2-3): RETURNING reports the pre-trigger value, so
--     writers must bump explicitly (row_version = row_version + 1) whenever
--     they echo the token back.
CREATE TRIGGER IF NOT EXISTS trg_clients_row_version_guard
BEFORE UPDATE OF row_version ON clients
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'clients.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_clients_row_version_bump
AFTER UPDATE ON clients
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE clients SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_contacts_row_version_guard
BEFORE UPDATE OF row_version ON contacts
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'contacts.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_contacts_row_version_bump
AFTER UPDATE ON contacts
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE contacts SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_tasks_row_version_guard
BEFORE UPDATE OF row_version ON tasks
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'tasks.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_tasks_row_version_bump
AFTER UPDATE ON tasks
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE tasks SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_notes_row_version_guard
BEFORE UPDATE OF row_version ON notes
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'notes.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_notes_row_version_bump
AFTER UPDATE ON notes
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE notes SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_support_cases_row_version_guard
BEFORE UPDATE OF row_version ON support_cases
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'support_cases.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_support_cases_row_version_bump
AFTER UPDATE ON support_cases
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE support_cases SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_quarterly_upgrade_windows_row_version_guard
BEFORE UPDATE OF row_version ON quarterly_upgrade_windows
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'quarterly_upgrade_windows.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_quarterly_upgrade_windows_row_version_bump
AFTER UPDATE ON quarterly_upgrade_windows
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE quarterly_upgrade_windows SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_server_upgrades_row_version_guard
BEFORE UPDATE OF row_version ON server_upgrades
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'server_upgrades.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_server_upgrades_row_version_bump
AFTER UPDATE ON server_upgrades
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE server_upgrades SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_objects_row_version_guard
BEFORE UPDATE OF row_version ON bams_objects
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'bams_objects.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_objects_row_version_bump
AFTER UPDATE ON bams_objects
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE bams_objects SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_metrics_row_version_guard
BEFORE UPDATE OF row_version ON bams_metrics
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'bams_metrics.row_version may only advance by 1');
END;
-- QA-2-6: provider polls (current_value, last_*, high_*) must not advance the
-- user's token, so the bump is scoped to user-editable configuration columns.
CREATE TRIGGER IF NOT EXISTS trg_bams_metrics_row_version_bump
AFTER UPDATE OF object_id, metric_name, ticker, enabled, stale_after_seconds, stale_suppressed ON bams_metrics
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE bams_metrics SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_rules_row_version_guard
BEFORE UPDATE OF row_version ON bams_alert_rules
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_rules.row_version may only advance by 1');
END;
-- QA-2-6: monitor-managed breach_count / suppress_until_clear do not bump.
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_rules_row_version_bump
AFTER UPDATE OF metric_id, rule_type, operator, threshold, reference_period, consecutive_updates,
                severity, cooldown_minutes, enabled ON bams_alert_rules
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE bams_alert_rules SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_events_row_version_guard
BEFORE UPDATE OF row_version ON bams_alert_events
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_events.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_events_row_version_bump
AFTER UPDATE ON bams_alert_events
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE bams_alert_events SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_configs_row_version_guard
BEFORE UPDATE OF row_version ON bams_alert_configs
WHEN NEW.row_version NOT IN (OLD.row_version, OLD.row_version + 1)
BEGIN
    SELECT RAISE(ABORT, 'bams_alert_configs.row_version may only advance by 1');
END;
CREATE TRIGGER IF NOT EXISTS trg_bams_alert_configs_row_version_bump
AFTER UPDATE ON bams_alert_configs
WHEN NEW.row_version = OLD.row_version
BEGIN
    UPDATE bams_alert_configs SET row_version = OLD.row_version + 1 WHERE rowid = NEW.rowid;
END;

-- -----------------------------------------------------------------------------
-- Schema version (forward-only; never lowered).
-- -----------------------------------------------------------------------------
INSERT INTO app_meta (key, value) VALUES ('schema_version', '2')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_meta.value AS INTEGER) < 2;
