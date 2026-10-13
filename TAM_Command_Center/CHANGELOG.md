# Changelog

All notable changes to the TAM Command Center rebuild. New work goes under **Unreleased** until a DEV release is cut. Nothing moves to a Production section until DEV validation explicitly passes (spec §50).

## [Unreleased] - 0.1.0-rc1

### Added
- 2026-10-13, backend-dev-agent: "0 of 19" ring report investigated; **no runtime bug**. `Runtime.clock` returns a `date` (not a callable result of the wrong type), so `seed_mock.load(conn, data, self.clock())` in `server/runtime.py` and in the DEV reseed route (`server/services.py`) already pass the correct `today`. A server-auto-seeded DB and a CLI-seeded DB give the same `progress` (27 / 8 / 19 / 2). The reporting DEV DB (`dev_data/tam_dev.db`) was seeded on 2026-10-12 (`db.mock_seed.rebased_to` 2026-10-12) before the T-61 seed existed, and auto-seed only runs on a fresh DB, so it has no completed-today rows. Fix: delete `dev_data/tam_dev.db` or call `POST /api/dev/reseed`. Added regression tests (auto-seed and reseed route equal the CLI seed, 27/8/19/2) in `server/tests/test_run2.py`.
- 2026-10-13, frontend-dev-agent (Run 2, T-70 to T-75): Today "Triage Split" and the approved workspace and Accounts refresh, built to the mockups as amended by D-26 to D-36 and PM §10.5 (the spec wins where they differ). Not packaged or released.
  - **Today** (`pages/TodayPage.tsx`, `pages/today/`): summary chips (Top 10, six tiers, All; full counts; `?show=top|t1..t6|all`, default not written to the URL, unknown values fall back to `top`), a strict top-10 listbox (`aria-activedescendant`; Up/Down/Home/End, Enter opens, click selects, double-click opens, no wrap; works without focusing the list; chips own Left/Right), tier headings only under All, "Showing N of M" and "View all (M)", a detail pane (why-it-is-here sentence, key facts with null facts omitted, one Open link; no steps, next action or completion control), the "N of M tasks done" ring from `progress` (M = 0 shows "No tasks due today", N = M shows "All done", `done_other` only in the tooltip, refetch when the local date changes), and Upcoming / Recently changed / Account load as tabs under the list (collapsed by default, Account load capped at 8 rows plus "All accounts (N)"). The old right column and Panels are gone. Logic is pure and tested in `lib/triage.ts`.
  - **Instruments** (`components/ui/Instruments.tsx`, `lib/instruments.ts`, `styles/instruments.css`): StackBar/MeterLegend, Sparkline, DueHistogram, TimelineTrack, ProgressRing, SummaryChips, DotRow, Avatar, DatePill, ProximityTrack; static SVG/CSS with text equivalents, no gradients, no animation. Tokens added: `--surface-warning/-danger/-accent`, `--meter-h`, `--spark-h`, `--ring-size`, `--row-h-triage`, `--r-round` (`--hover-row` already existed).
  - **Workspace**: header band (Open tasks exclusive meter, Servers dot row with real per-server alert state, Alerts with the worst alert, Next upgrade and Next client touch with proximity tracks), "Top item for this account" (D-34, no steps), due histogram, server tiles with sparklines only where samples exist ("No trend data" otherwise, solid tint surfaces for alerting tiles), 30-day upgrade timeline with edge-pinned out-of-window markers, avatars in the context rail. The infrastructure query is lifted into `WorkspacePage` and shared with the header, Overview and Infrastructure tab.
  - **Accounts**: tile strip (Portfolio, Open load by account, Next 15 days) plus Needs attention (D-33 key, max 4, no score), and table columns Account, Load (bar), Overdue, Waiting, Alerts, Servers (dots), Next upgrade and Next contact (pills), Activity (14-day sparkline from `GET /api/accounts/activity-trend`). The Next 15 days upgrade markers, the servers dots and the attention signals are derived from the same `GET /api/today` queue (tier 5 is exactly T..T+14; alert and overdue-upgrade items carry the server name).
  - **Data**: `TodayData.progress`, `Infrastructure.servers` (tiles), `ActivityTrend`, `DataSource.getActivityTrend`. `MockDataSource` ports `day_progress.sql` and `activity_trend.sql` (injectable local-midnight function and clock) and builds server tiles by contract §9.3. `ApiDataSource` maps `progress`, `server_tiles` (the integer `servers` stays the count) and the trend endpoint; `progress` is `null` against a server that predates PM-AC-1.
  - **Tests**: Vitest 120 -> 191. Parity of progress and the 14-day trend against the reference SQL on three dates (`scripts/gen_today_parity.py` now also writes `run2_parity_<date>.json`; ranking fixtures regenerated, unchanged), progress edge cases (reopened, future/no due date, Inactive, archived, deleted, UTC+10 and a 25 h DST day, N <= M), tiles, triage/instrument derivations (every D-33 tie-break), component tests, adapter tests, new guards (no animation, keyframes, gradient, blur or shadow in the Run 2 files; no steps/next-action/"Mark complete" text in Today; the three tint tokens pinned to the 12% blend), and App integration tests for Today, workspace and Accounts.
- Found, not fixed (outside frontend scope): `server/runtime.py` auto-seeds a fresh DEV DB with `seed_mock.load(conn, data, self.clock())`, passing a clock where `load` expects a date, so the auto-seeded DEV DB has no done-today rows (ring shows 0 of 19) and instants are not rebased to today. Seeding the scratch DB with `db/seed_mock.py load` gives the documented 8 of 27.
- 2026-10-13, backend-dev-agent (Run 2, T-62 to T-64; PM-AC-1..3 done). Additive, no schema change; `docs/04_API_CONTRACT.md` §9 holds the shapes.
  - `GET /api/today` gains `progress {day,total,done,open,done_other}` (executes `day_progress.sql` unmodified; the two local midnights of the window are converted to UTC separately, DST-exact; `Runtime.tz` is injectable for tests).
  - New `GET /api/accounts/activity-trend?days=14[&include_inactive=true]` -> `{ok,today,days,series:{client_id:[14 ints, oldest first]}}` (`activity_trend.sql` unmodified; `days` other than 14 is a 422).
  - `GET /api/client/{id}/infrastructure` gains `server_tiles` (name, environment, version, alert_severity, spark) with a 7-day, at most 28-point sparkline from `bams_metric_samples` (one metric, one time range; null when no samples). Named `server_tiles` because `servers` is the frozen integer count.
  - New `server/localtime.py`, `server/trends.py`; 24 new tests in `server/tests/test_run2.py`. `pytest server db tests/e2e`: 323 passed; `sql_safety_scan.py`: 0 violations. No existing test needed changing (none pins the queue contents against the new seed row).
- 2026-10-13, data-architect-agent (Run 2, T-61): DB-layer support for the progress ring, activity trend and sparklines. **No schema change** (`docs/qa/SCHEMA_CHANGE_REQUEST.md` not needed).
  - New reference queries `db/queries/day_progress.sql` (D-29; `:today`, `:day_start_utc`, `:day_end_utc`; plan/done/open/done_other; `ix_audit_ts`) and `db/queries/activity_trend.sql` (14 daily points per account from the same union as `activity_timeline.sql`; 15 local-midnight UTC bounds so DST days are exact; `ix_notes_client_ts`, `ix_audit_client_ts`). `seed_mock.progress_params()` / `trend_params()` build the parameters.
  - Seed: `Gen.build_done_today()` adds 14 tasks and 36 audit rows with tasks completed today (08:30Z to 10:45Z) covering every §10.2 case (N = 8, M = 27, done_other = 2 on the seed), and `bams_metric_samples` now span 7 days (60 per sampled metric, 1440 rows; was 24 hourly). Own RNG stream, so every other seeded row is unchanged; `mock_data.json` regenerated, byte-identical on repeat. Verifier gains 14 checks; the "nothing in the future" check now allows the done-today rows (nothing after today 12:00Z).
  - Tests: 32 new in `db/tests/test_db_contract.py` (109 total), including reopened/inactive/archived/deleted edge cases, Tokyo local midnight, 23 h and 25 h New York DST days and parity with `activity_timeline.sql`.
  - Frontend `today_parity_*.json` fixtures regenerated from `today_queue.sql` (the reopened seed task is one new queue row, 117 rows).
  - `docs/03_DATA_MODEL.md` §17 documents all of it, with the hand-computed table.
- 2026-10-12, deployment-agent (Phase 4.3, T-42): Windows release scaffolding. NOT production-ready; nothing was run on Windows or against Bloomberg.
  - **Launchers** (CRLF, static-linted only): `Launch_TAM_Command_Center.bat` (PROD, 8765, clears test flags), `Launch_DEV_Preview.bat` (DEV, 8766, sets `TAM_DEV_MODE=1` and `TAM_BAMS_TEST_MODE=1`), `Install_Dependency.bat` (app-local `.venv`, optional `wheelhouse\` offline install), `Check_PROD_Environment.bat`, `Check_DEV_Environment.bat`, and the helper `tools/_resolve_python.bat` (TAM_PYTHON, `.venv`, `python`, `py -3`; 3.10+ required; an invalid TAM_PYTHON fails with no fallback).
  - **Helpers:** `tools/env_check.py` (read-only preflight: Python, modules, files, channel vs mode, flags, data folder, port, BLPAPI import; PROD fails closed without BLPAPI, `--core-only` is used by the PROD launcher because the BAMS monitor does not exist yet; DEV warns only) and `tools/open_when_ready.py` (honours the stored `open_browser_on_start` setting, reads the DB read-only).
  - **Build:** `tools/build_release.py` (zip with SHA-256 `BUILD_MANIFEST.txt`, refuses DBs/dev_data/.venv/node_modules/frontend/mock data in a prod archive, rewrites `VERSION.txt` to `channel=prod`, `--channel dev` makes a DEV-preview package with the seed data) and `tools/smoke_release.py` (unpack, fresh venv, boot PROD and DEV, assert no auto-seed in PROD), `tools/lint_bat.py` (static lint of the .bat files).
  - `README.txt`, `VALIDATION.txt` (honest: untested on Windows and Bloomberg, not production-ready, deferred phases 3-5).
- `VERSION.txt` is now `0.1.0-rc1` (channel dev in the source tree; the release archive rewrites it to prod).

### Changed
- 2026-10-13, pm-agent (Run 2 planning, T-60): the user approved the mockups in `mockups/` (Today direction C "Triage Split", account workspace, accounts). No code or mockup was changed; documents only.
  - `docs/01_PM_SPEC.md`: new binding decisions **D-26 to D-36** (Triage Split layout; strict top-10 default list with View all and chips; no steps / next-action field / Mark complete in the Today detail pane; the "done today N of M" ring defined as tasks only, live, `N <= M`, via `progress` on `GET /api/today`, no schema change; Upcoming / Recently changed / Account load as tabs; approved visual refresh limited to schema-free derived data; tier 1 upgrade ranking rule; Needs attention rule with no score; workspace "Top item" panel; mockups are illustrative; design amendments). New §10 with details, the derived-data rulings, the mockup deviation register, API additions (PM-AC-1 to PM-AC-3), acceptance criteria (US-3.6 to US-3.9, US-4.2, US-5.6) and Run 2 tasks T-60 to T-77 (no packaging tasks). D-04 clarified (no behaviour change).
  - `docs/02_DESIGN_GUIDELINES.md`: new §15 (panel types, grouped panels, inset tiles, instruments, tokens, calm checklist). The Run 1 rules "single continuous context rail" and "no card-in-card" are superseded (§2, §14 updated).
  - `docs/qa/API_CHANGE_REQUEST.md`: PM-AC-1 to PM-AC-3 (additive).
  - No `docs/qa/SCHEMA_CHANGE_REQUEST.md` was created: none of D-26 to D-36 requires a schema change.

### Fixed
- 2026-10-12, backend-dev-agent: requirements split. `server/requirements.txt` is now runtime-only (fastapi, uvicorn, pydantic and their pinned transitive deps; no optional uvicorn extras, no test/audit tools) and installs cleanly on Python 3.10-3.12 on Linux/macOS/Windows. New `server/requirements-dev.txt` (`-r requirements.txt` plus pytest, httpx, pip-audit, bandit and the optional extras; uvloop is skipped on win32 and websockets only on Python 3.11+). Audited pins unchanged; `exceptiongroup==1.3.1` added for Python < 3.11 (anyio dependency). `tools/build_release.py` docstring/header updated; its filter is kept as a guard. Verified on Python 3.10.14: fresh venv `pip install -r server/requirements.txt`, `pip check` clean, DEV server on a scratch DB answers `/api/state` 200, `pytest server db tests` 267 passed, `tools/smoke_release.py` PASS.

### Found (reported, not fixed; application logic untouched)
- `server/requirements.txt` pins `websockets==17.2` (Python 3.11+) and `uvloop` (no Windows wheels), so `pip install -r server/requirements.txt` fails on the supported minimum Python 3.10. The release requirements omit the optional uvicorn[standard] extras. FIXED by the requirements split above.
- A DEV preview cannot run from a prod-channel release by design (TAM_DEV_MODE is ignored there); DEV needs the `--channel dev` package.
- CRM and Operations guides and the Operations/Bulk Upload/BAMS screenshots required by spec section 56 do not exist yet (phases 3-5).

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
