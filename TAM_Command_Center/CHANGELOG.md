# Changelog

All notable changes to the TAM Command Center rebuild. New work goes under **Unreleased** until a DEV release is cut. Nothing moves to a Production section until DEV validation explicitly passes (spec §50).

## [Unreleased] - 0.1.0-dev

### Added
- 2026-10-12, pm-agent (Phase 1.1): `docs/01_PM_SPEC.md`, covering epics E1-E12, user stories traced to spec sections, the Today ranking rules, screen layouts, component inventory, API contract list, task board T-01 to T-50, and the out-of-scope list for run 1 (spec phases 1-2).
- 2026-10-12, pm-agent (Phase 1.1): `docs/02_DESIGN_GUIDELINES.md`, covering colour, type, spacing and motion tokens with checked contrast ratios, button states, the custom Select and AccountPicker keyboard contracts, tables, the note vs system-event treatment, overlays and screen states.
- 2026-10-12, pm-agent: skeletons of `TAM_PROJECT_STATE.md` and `CHANGELOG.md`.
- 2026-10-12, data-architect-agent (Phase 1.2, T-01 to T-04):
  - `db/schema.sql`: schema v1 with all 16 §33 tables, enum CHECKs, NULL-safe date/instant CHECKs, partial indexes for Today, append-only audit triggers, and `application_id` 'TAMC'.
  - `db/migrations/0001_initial.sql` and `db/migrate.py`: reference runner. It takes a pre-migration online backup, is forward-only, and refuses newer or foreign DBs.
  - `db/queries/*.sql`: reference Today queue, Activity timeline, Recently Changed and account summary SQL.
  - `db/seed_mock.py` and `db/mock_data.json`: deterministic fixture rebased to today. It has 12 accounts, 166 tasks, 210 notes and 756 audit rows, and covers every Today tier.
  - `db/tests/test_db_contract.py`: 22 tests.
  - `docs/03_DATA_MODEL.md`.

### Decisions (Phase 1.2)
- The PM's default answers to Q-1 to Q-5 are applied as recorded (see `docs/03_DATA_MODEL.md` §1).
- `audit_events.object_label` was added so Activity sentences survive deletes.
- `bams_objects.environment` was added for the §14 environment summary.
- JSON1 and STRICT are deliberately not used, for Windows CPython portability.

### Decisions
- Decisions D-01 to D-22 are recorded in `docs/01_PM_SPEC.md` §0. The main ones:
  - Clean version line `0.1.0-dev` / schema 1.
  - The full §33 schema exists from day one.
  - Activity merges notes with read-only system events derived from audit.
  - Six-tier Today ranking.
  - Spec §34 route names, with 501 stubs for later phases.
  - Every delete requires confirmation plus a safety backup.
  - DEV on port 8766, PROD on port 8765.

- 2026-10-12, pm-agent: **the user confirmed Q-1 to Q-5 (the defaults)**. D-01, D-04, D-07, D-08, D-12 and D-22 are now final.
- 2026-10-12, pm-agent: **D-11 revised.** The optimistic-concurrency request field is `expected_row_version` (integer, compared with the schema's `row_version`), replacing `expected_updated_at`.
- 2026-10-12, pm-agent: **D-23 (QA-1-12a).** When an open Client Follow-Up task's `due` equals the account's `next_contact`, Today and Upcoming show only the task and suppress the account-level follow-up item.
- 2026-10-12, pm-agent: **D-24 (QA-1-12b).** Exception upgrades always qualify for queue tier 5, whatever their date. Deferred upgrades stay out of the queue.
- 2026-10-12, pm-agent: **D-25 contracts.**
  - DB writes never use REPLACE in any spelling; upserts use `ON CONFLICT … DO UPDATE` only.
  - `channel` is a required argument on every DB open and migrate call.
  - The release must ship `db/schema.sql`, `db/migrations/` and `db/queries/`.

### Changed
- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_1` (REJECTED). `0001_initial.sql` was edited in place because v1 is unreleased.
  - **QA-1-1:** audit rows can no longer be rewritten by REPLACE (`trg_audit_events_no_replace`).
  - **QA-1-2:** `INSERT OR REPLACE` / `REPLACE INTO` are banned by contract (03 §2.1). Guard triggers block secondary-key REPLACE, and a codebase scan test enforces the ban.
  - **QA-1-3:** `row_version` is the D-11 token on 12 tables, with guard and auto-bump triggers. The `updated_at >= created_at` CHECK was removed.
  - **QA-1-4:** the persistent purge flag is removed. `migrate.purge_audit_events()` purges transactionally, and `assert_guards()` checks the guard triggers on every open.
  - **QA-1-5:** BAMS freshness fields now rebase to load time. The seed covers Live, Delayed, Stale and No Data.
  - **Lows:**
    - `closed_at >= recovered_at`
    - ad-hoc upgrade identity index
    - a rule with active alerts cannot be deleted
    - `notes.source` excludes System
    - no control characters in identity text
    - three unused indexes dropped; Recently Changed uses `ix_audit_ts`
    - Today: NULL dates sort last, alert `days_delta` is local, disabled monitoring is excluded
    - fictional release versions
    - seed guards moved into `load()`; reseed keeps settings
    - `db.channel` stamp and check
    - foreign `application_id` refused
  - Added `queries/object_history.sql`.
  - Tests: 22 → 47.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_2` (REJECTED). `0001_initial.sql` was edited in place because v1 is still unreleased.
  - **QA-2-1:** removed the INSERT-side secondary-key guards that broke `ON CONFLICT DO UPDATE` / `DO NOTHING` and `INSERT OR IGNORE`. The §25 re-import, notification insert-once and name/ticker upserts now work. Duplicate errors now always read `UNIQUE constraint failed: <table>...`.
  - **QA-2-2:**
    - Added BEFORE UPDATE guards on every secondary unique key and id immutability on 13 tables, which blocks `UPDATE OR REPLACE`.
    - Added `db/sql_safety_scan.py`: a whole-file, string-seam-aware scan for every REPLACE spelling, including ORM and DDL forms and `.mjs`/`.cjs`.
  - **QA-1-5:** added the frozen mock clock rule (`app_meta['bams.mock_clock']` plus `queries/metric_freshness.sql`). The verifier now uses real wall time.
  - **Lows:**
    - NULL-safe ad-hoc identity
    - explicit-bump and RETURNING contract
    - channel refusal checked before stamping, and `channel` is now required
    - trigger SQL compared, not just names
    - poller writes no longer bump `row_version`; alert close is status-conditional
    - deterministic Recently Changed tie-break
  - Tests: 47 → 63.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_3` (REJECTED) and the PM follow-ups.
  - **QA-3-1:** rebuilt `db/sql_safety_scan.py`:
    - a comment-aware lexer, so comment markers inside strings no longer hide code
    - root-anchored skips, so `server/web/`, nested `tests/` and `dist/`, and `.pyw`/`.pyi` files are scanned
    - new patterns for SQLAlchemy `text('OR REPLACE')`, peewee `on_conflict_replace` / `on_conflict('replace')` and pandas `if_exists='replace'`
  - **QA-3-2:** contextual patterns (no false hits on SQL `replace()`, `.replace("INTO"…)` or UI copy) and a `sql-safety: allow` per-line marker.
  - **QA-3-3:** PROD refuses a DB with `bams.mock_clock` present; `metric_freshness.sql` honours the mock clock only when `:channel='dev'`.
  - **QA-3-4:** `assert_guards` refuses undeclared extra triggers.
  - **PM D-23:** a Client Follow-Up task with `due == next_contact` suppresses the duplicate touch item in the queue and Upcoming, and gets the context "Next Client Touch".
  - **PM D-24:** Exception upgrades are tier 5 at any date; Deferred never enters the queue and shows in Upcoming only inside +15..+30.
  - New seed scenarios and verifier checks for D-23/D-24.
  - `03_DATA_MODEL.md` §1 now says D-11 uses `expected_row_version`.
  - Tests: 63 → 70.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_4` (REJECTED). Only the scanner and its tests changed.
  - **QA-4-1:** `REPLACE INTO` / `UPDATE OR REPLACE` now match placeholder table names (f-string, `%s`, `.format`, `${}`).
  - **QA-4-2:**
    - `AS alias`
    - peewee `replace()` / `replace_many()`
    - pandas dict-passed `if_exists`
    - BOM- and UTF-16-aware decoding
    - `.sh/.bash/.zsh/.ps1/.psm1/.bat/.cmd` are scanned
    - allow markers must carry a reason; `--list-allow` added
    - also sqlite-utils `replace=True` and Kysely `.orReplace()`
  - **QA-4-3:** `.sql` single-quoted data is no longer scanned. UI-copy false positives are accepted and documented (fail closed, reasoned marker).
  - Added a generated adversarial corpus: 572 banned cases, 44 ORM forms, 57 negatives.
  - Tests: 70 → 77.

### Removed
- Review-1 INSERT-side guards: `trg_clients_no_replace_name`, `trg_server_upgrades_no_replace_identity`, `trg_bams_objects_no_replace_name`, `trg_bams_metrics_no_replace_keys`, `trg_bams_alert_events_no_replace_active`, `trg_bams_alert_configs_no_replace_name`, `trg_bams_notification_log_no_replace` (QA-2-1). `trg_contacts_no_replace_primary` was renamed `trg_contacts_one_primary_on_insert`.
- `app_meta['maintenance.audit_purge_allowed']` (QA-1-4).
- Indexes `ix_tasks_waiting_next_update`, `ix_server_upgrades_open_date`, `ix_server_upgrades_validation`, `ix_bams_alert_events_active` (QA-1-10).

### Fixed
- none
