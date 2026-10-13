# Changelog

All notable changes to the TAM Command Center rebuild. New work goes under **Unreleased** until a DEV release is cut. Nothing moves to a Production section until DEV validation explicitly passes (spec §50).

## [Unreleased] - 0.1.0-dev

### Added
- 2026-10-12, frontend-dev-agent: QA-E2-3 fixed (top-bar + Capture now prefills the current account like the N key; two regression tests). T-1 fixed (`build:api` tree-shakes the mock adapter and `mock_data.json` out of `web/`).
- 2026-10-12, pm-agent (Phase 4.2): `docs/05_TRACEABILITY.md`, the requirements traceability matrix. 113 rows (mandatory checks, E1-E12 acceptance criteria, PM decisions) plus the section 52 summary: PASS 111, FAIL 0, MISSING 0, DEFERRED 2 (US-12.2, Phase 4.3). Verified by re-running `pytest server db tests` (239 passed), `tsc` and `vitest` (118 passed), and by driving the live DEV app on a scratch DB. Five Low observations (T-1 to T-5) are listed there. `TAM_PROJECT_STATE.md` validation table brought up to date.
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

- 2026-10-12, backend-dev-agent (Phase 2.1, T-10 to T-13):
  - **API contract:** `docs/04_API_CONTRACT.md` published first and frozen: routes, payloads, error codes, Today queue item shape.
  - **`server/` (FastAPI, loopback only):**
    - DEV/PROD modes, ports 8766/8765 and a build-channel guard.
    - Per-DB single-instance lock.
    - Rotating file logging. Browser-disconnect errors are logged as one debug line with no traceback.
    - Migration on start through `db/migrate.py` with a pre-migration online backup.
    - A new DEV DB is auto-seeded with the mock data.
  - **Routes:**
    - `/api/health`, `/api/state`, `/api/today`, `/api/client/{id}/activity` (keyset pagination), `/api/tasks`, `/api/client/{id}/infrastructure`, `/api/settings[/save]` and `/api/logs/recent`.
    - Client, contact, task and note CRUD, including task archive.
    - `/api/data/backup[s]`.
    - DEV-only `/api/dev/reseed`.
    - 501 stubs for operations, bams, export, import, data/reset, restore, context and chat.
  - **Rules implemented:** D-07, D-08, D-10, D-11, D-12, D-22, D-23 and D-24 (the last two through the unmodified `today_queue.sql`) and D-25.
  - **Tests:** `server/tests/` has 107 tests (`test_startup.py`, `test_writes.py`, `test_today.py`).

- 2026-10-12, frontend-dev-agent (Phases 2.2 and 2.3, T-20 to T-23): `frontend/` (React 18, TypeScript, Vite, `lucide-react`, `react-router-dom`; custom CSS only) with build output in `web/`.
  - **Design system:** `src/styles/tokens.css` (the only file with raw colours), buttons with every state, custom `Select` and `AccountPicker` combobox components, segmented control, tabs, sortable `DataTable` with sticky header and `aria-sort`, `Dialog` and `Drawer` (focus trap, Escape, focus return, scroll lock, "Discard changes?" guard), toasts, tooltips, badges, banners, skeleton rows and `RichText` (the single plain-text render path, D-16). A sandbox page at `/sandbox` renders every button state.
  - **Screens:** Today, Accounts, Account Workspace (Overview, Tasks, Activity, Infrastructure, Contacts, context rail, collapsible "Account brief" below 1100 px), global Tasks, Settings (general, runtime, backups, recent log), Operations/BAMS/Bridge placeholders, Quick Capture (Task, Client Follow-Up, Meeting/Call/General Note), account jump (`Ctrl+K`) and the `N` shortcut. Editors open from the URL (`?task=`, `?note=`, `?contact=`, `?account=`) so Back closes them and deep links work.
  - **Data layer:** one `DataSource` interface (`src/data/DataSource.ts`). `MockDataSource` (loads `db/mock_data.json` via `public/`, rebase rule with the exact BAMS offset and the frozen mock clock, Today ranking port with D-23 and D-24, CRUD, audit rows, D-07, D-08, `expected_row_version`, safety-backup records). `ApiDataSource` maps `docs/04_API_CONTRACT.md` to the domain types. A store (`DataProvider` + `useQuery`) refetches on every mutation, keeps earlier data when a refresh fails and flags it stale.
  - **Tests:** 113 Vitest tests (Select and AccountPicker keyboard matrices, Today parity with `db/queries/today_queue.sql` on three dates, rebase rules, mock CRUD and rules, adapter mapping, App integration for every in-scope [§52] UI flow, repository guards).
  - Scripts: `npm run dev|build|build:api|test|typecheck`; `scripts/gen_today_parity.py` regenerates the parity fixtures from the reference SQL; `.claude/launch.json` defines the dev and preview servers.
  - `docs/qa/API_CHANGE_REQUEST.md`: four additive, non-blocking requests (FE-AC-1 to FE-AC-4).

### Known gaps and deviations (frontend, 2026-10-12)
- `Select`: Escape on a **closed** select is not consumed (the guideline says it is a no-op that does not bubble), so an enclosing dialog or drawer still closes. Escape on an open select is consumed as specified.
- At 1440 px the account Tasks table (8 columns plus actions, beside the 320 px context rail) scrolls horizontally inside its container. This is allowed by spec §44 but is not ideal.
- `?note=<id>` deep links find the note by paging the Activity timeline (see FE-AC-1).
- The default build is the mock build: `web/mock_data.json` is copied into `web/`. Use `npm run build:api` for any release build.
- `ApiDataSource` was exercised by hand against the live DEV backend (Python 3.12) but there is no automated end-to-end suite yet (QA 3.2). The `?data=api` URL switch is lost on a full page reload.
- Not tested on Windows or on the Bloomberg workstation. Contrast ratios come from the token table in `02_DESIGN_GUIDELINES.md`; no automated contrast or axe scan was run.
- Recharts is not installed (D-19: no charts this run).

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
- 2026-10-12, backend-dev-agent (QA-E2-1, QA-E2-2):
  - **QA-E2-1:** a CORS-rejected preflight now returns a structured 400 `cors_rejected` JSON error, and responses answered by `CORSMiddleware` carry the security headers/CSP (new `PreflightGuard` ASGI middleware in `server/app.py`, outside CORS).
  - **QA-E2-2:** `GET /api/note/save|delete` 405 now sends `Allow: POST`.
  - Strict-xfail marks removed from `tests/e2e/test_gate32_retest_e2e.py`.
- 2026-10-12, backend-dev-agent (Phase 4.1):
  - **FE-AC-1:** `GET /api/note/{id}` returns `{"ok": true, "item": <Note>}`; unknown id is 404 `not_found`; `GET /api/note/save|delete` is 405.
  - **FE-AC-2:** activity note entries carry `client_id` and `created_at`.
  - **FE-AC-3:** `server_name` on activity system entries and `recent_changes` rows (BAMS object name for alerts, server name for upgrades, else null).
  - **FE-AC-4:** `next_upgrade: {date, server} | null` on every `infrastructure[client_id]` in `/api/state` and on the per-account infrastructure response. Same rule as `account_summary.sql`.
  - **QA-E1-2:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a restrictive CSP (self-only scripts; inline styles allowed for React/Recharts) on every response. The built `web/` bundle loads and navigates with no CSP violations.
  - **QA-E1-3:** a known path with the wrong method returns 405 `method_not_allowed` with `Allow`. `HEAD /` works.
  - **QA-E1-4:** 2 MiB request-body cap (declared and chunked bodies) returns 413 `payload_too_large`.
  - **QA-E1-7 (part):** `server/requirements.txt` pinned to the venv versions. pip-audit: no known vulnerabilities (after upgrading the venv's pip 24.0 to 26.2.1). bandit on `server/` excluding tests: 0 High, 8 Medium (B608 on f-strings built from fixed fragments and allow-listed column names, false positives), 1 Low (B101 assert).
  - Tests: `server/tests/test_phase41.py` (11 new). `pytest server` 118, `pytest db` 77, e2e 44, scanner 0 violations. `docs/04_API_CONTRACT.md` updated.
- 2026-10-12, frontend-dev-agent (Phase 4.1):
  - **QA-E1-1:** `DEFAULT_SOURCE` is now `api`. `?data=mock` still selects the mock adapter for DEV/demo and is remembered for the tab session in `sessionStorage` (try/catch). A production build (`npm run build:api`, `VITE_DATA_SOURCE=api`) ignores `?data=mock` and does not ship `mock_data.json`. Regression test: `src/data/index.test.ts`.
  - **FE-AC-1..4 consumed in `ApiDataSource`** (backend routes and fields exist in `server/`; `docs/04_API_CONTRACT.md` did not yet document them when re-read): `GET /api/note/{id}` replaces the 12-page activity paging for `?note=` deep links (new `DataSource.getNote`), note activity entries use wire `client_id` and `created_at`, system entries and recent changes use wire `server_name`, and the infrastructure summary uses the server-computed `next_upgrade`. The client-side derivations were removed.
  - Verified against the live DEV backend on a scratch DB (Today, account workspace, note create/edit/delete, `?note=` deep link on a cold load, Quick Capture call note, primary contact switch): no console errors, no failed requests. Vitest 113 -> 118.
- none
