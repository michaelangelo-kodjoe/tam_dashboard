# TAM Command Center: Project State

> This file is the current truth, not a transcript (spec §50). Update it on every substantive code, config, schema, deployment or behaviour change. History belongs in `CHANGELOG.md`.

Last updated: 2026-10-15 by pm-agent (Run 7 planning: legacy database import only, `docs/01_PM_SPEC.md` section 15, D-143..D-153, tasks T-186..T-192; Settings > Data wizard, no other screens; no alert history/samples/audit imported, metrics start as No data; no schema change expected; mockups waived; documents only). Previous: 2026-10-15 by data-architect-agent (Run 6 T-175: restore audit vocabulary and explicit-id insert/trigger behavior confirmed, no schema change; portability fixtures in tests/fixtures/portability; 122 db tests pass). Previous: pm-agent (Run 6 planning: Portability, `docs/01_PM_SPEC.md` section 14, D-122..D-135, US-16.1..16.6, tasks T-174..T-183; Excel export, DB copy, add-missing-only Excel restore in Settings > Data; no schema change expected; brief `docs/qa/PORTABILITY_MOCKUP_BRIEF.md`; documents only; mockup gate pending; restore accepts .xlsx or .csv files, D-135; database restore from .db/backup list D-136..D-142; Windows file replacement unverified). Previous: 2026-10-15 by data-architect-agent (T-166 Operations DEV seed extended: East/West regions, 2 DEV appliances, missing West date, date and version overrides; no schema change). Previous: frontend-dev-agent (Run 5 Operations UI built, T-171: page, dialogs, adapters, import note; user waived further mockups; QA T-172 next). Previous: backend-dev-agent (Run 5 Operations backend built: server/ops, contract section 13, import polarity additions; quarter Target version auto-applies to all appliances in the quarter; no schema change; UI T-171 and DEV seed T-166 pending). Previous: pm-agent (Run 5 mockup-v2 feedback: per-appliance manual Target version with checkbox multi-select and Set version (D-119), table grouped by account with collapse (D-120), target version in the quarter dialog (D-121); D-107..D-125, tasks T-164..T-173 amended; no schema change). Previous: pm-agent (Run 5 SCOPE RESET: user rejected the first Operations mockups as too dense. Operations is now one page tracking BAMS appliances per manually entered quarter; one upload only (the BAMS appliance import gains a Polarity/Region East-West note); no schedule parsing/sync/Diagnostics/network; no schema change; `docs/01_PM_SPEC.md` section 13 rewritten (D-107..D-118, tasks T-164..T-173; D-73..D-106 and T-133..T-163 void); brief `docs/qa/OPERATIONS_MOCKUP_BRIEF.md` v2; open questions: 13.6 (defaults apply). Superseded same-day note follows: Run 5 planning: Operations workbench, D-73 to D-100, tasks T-133 to T-162, `docs/01_PM_SPEC.md` section 13; mockup brief `docs/qa/OPERATIONS_MOCKUP_BRIEF.md`; documents only; AMENDED same day: manual paste/upload only, no network code; source URL typed by user in Settings; Operations window inferred from Environment + Region + release (D-101..D-106). Q8 answered: one DEV date per quarter, no schema change, Region only for PROD (T-143 is confirmation only); Q2/Q4/Q5/Q6/Q7 assumed, unconfirmed. MOCKUP GATE pending). Previous: 2026-10-14 by frontend-dev-agent (Run 4 BAMS UI built: T-114, T-115, T-127, T-128; QA gate next). Previous: 2026-10-14 by pm-agent (Run 4 import amendment D-63..D-72 added; Run 4 planning: BAMS dashboard, D-49 to D-62, tasks T-100 to T-117, `docs/01_PM_SPEC.md` section 12; documents only; MOCKUP GATE pending: no UI build before the user approves `mockups/bams/`). Previous: 2026-10-13 by backend-dev-agent (Run 3 T-80..T-86 done: account import xlsx+csv, duplicate engine, contract section 10 FINAL; frontend T-87+ builds against it). Previous: 2026-10-13 by pm-agent (Run 3 planning: account bulk import with duplicate detection, D-37 to D-48, tasks T-80 to T-95; documents only). Previous: 2026-10-13 by frontend-dev-agent (Run 2 T-70 to T-75: Triage Split, instruments, workspace and Accounts refresh; mock and API adapters; 191 Vitest tests). Previous: 2026-10-13 by data-architect-agent (Run 2 T-61: seed and reference queries for the progress ring, activity trend and 7-day sparklines; no schema change). Previous: 2026-10-13 by pm-agent (Run 2 planning, D-26 to D-36; documents only). Previous: 2026-10-12 by deployment-agent (Phase 4.3 release scaffolding). Previous: pm-agent (Phase 4.2 traceability); before that frontend-dev-agent (Phases 2.2 and 2.3: React UI and mock adapter built and tested). Previous update: backend-dev-agent (Phase 2.1).

## Current release
| | |
|---|---|
| App version | `0.1.0-rc5` (rc5: launcher split (Install_and_Launch = setup only, import-based install decision; Launch_TAM_Command_Center = daily, database chooser via tools/choose_db.py + TAM_DB_NAME), UNVALIDATED on Windows; rc4: release requirements.txt uses ranges for the lagging Bloomberg mirror, UNVALIDATED; rc3 archive built 2026-10-15 with one-click `Install_and_Launch.bat`, UNVALIDATED; rc1-rc3 zips kept in dist/). A release archive can now be built (`tools/build_release.py`); it has not been validated on Windows or Bloomberg. |
| Channel | dev in the source tree; the release archive is rewritten to `channel=prod` (`validation=UNVALIDATED`) |
| Schema version | 1, built in `db/schema.sql` and `db/migrations/0001_initial.sql`. Unreleased. Revised for QA reviews 1 to 4; awaiting `SCHEMA_REVIEW_5`. |
| Production status | **Not production-ready.** Nothing has been validated on the target Bloomberg Windows workstation (spec §56). |

## Architecture (locked; see `docs/TEAM_LOOP.md`)
- **Backend:** Python 3.10+, FastAPI, SQLite (WAL, foreign keys on), bound to 127.0.0.1 only.
- **Frontend:** React, TypeScript and Vite, compiled to static assets in `web/` and served by the backend. Custom CSS tokens. lucide-react icons. Recharts is reserved for BAMS (Phase 4).
- **Packaging:** Windows `.bat` launchers and a release zip with a SHA-256 manifest. No Node is needed at runtime.
- **Data access:** the frontend goes through a single `DataSource` adapter (mock or HTTP).

## Environment separation
| | DEV | PROD |
|---|---|---|
| Trigger | `TAM_DEV_MODE=1` | default |
| DB | `<app>/dev_data/tam_dev.db` | `%LOCALAPPDATA%\TAM_Command_Center\tam_command_center.db` |
| Port | 8766 | 8765 |
| DEV routes (`/api/dev/*`) | registered | absent |
| A dev-channel build in PROD mode | n/a | refuses to start |

Status: **implemented and tested in `server/`** (`server/config.py`, `locking.py`, `runtime.py`). A dev-channel build (`VERSION.txt` says `channel=dev`; a tree with no `VERSION.txt` counts as dev) exits 3 with a clear message unless `TAM_DEV_MODE=1`. A prod-channel build ignores and logs `TAM_DEV_MODE` / `TAM_BAMS_TEST_MODE`. `/api/dev/*` is not registered in PROD and `/openapi.json` is DEV only. A second process on the same DB exits 2 naming the holder's PID and port. A brand-new DEV DB is auto-seeded with the mock data (`TAM_DEV_SEED=0` disables). Untested on Windows (`msvcrt.locking` path and `%LOCALAPPDATA%` are unexercised).

## Schema
Built in Phase 1.2, then revised after QA `SCHEMA_REVIEW_1` to `_4` (all REJECTED). PM decisions D-23 and D-24 are implemented in the Today query. The schema has all 16 tables from spec §33, 19 indexes and 51 triggers. The triggers cover:
- audit append-only: no update, no delete, no id reuse
- UPDATE-side unique-key guards and id immutability (these block `UPDATE OR REPLACE`)
- one primary contact on every path
- the BAMS rule-delete guard
- `row_version` guard and bump, scoped to config columns on monitor-written tables

The INSERT-side REPLACE ban is enforced by `db/sql_safety_scan.py`, which the tests run over the whole tree. Review 3 rebuilt it around a comment-aware lexer, root-anchored skips and contextual patterns that cover the ORM and pandas forms. Review 4 added placeholder table names, encodings, launcher scripts and reasoned allow markers, and a 572-case generated adversarial corpus now guards it. BAMS freshness follows the frozen mock clock rule (`bams.mock_clock` plus `queries/metric_freshness.sql`).

Validation (macOS, SQLite 3.38.2):
- `integrity_check` ok
- `foreign_key_check` empty
- 77 of 77 contract tests pass
- the seed verifier passes 62 of 62 checks
- the scanner finds 0 violations

Every finding has a disposition in `docs/03_DATA_MODEL.md` §13 to §16. **Awaiting QA re-review (`SCHEMA_REVIEW_5`).**

## Source manifest
| Path | Purpose | Status |
|---|---|---|
| `docs/SPEC.md` | Product spec (authoritative) | present |
| `docs/TEAM_LOOP.md` | Build process | present |
| `docs/01_PM_SPEC.md` | Epics, stories, screens, API list, task board, scope | present |
| `docs/02_DESIGN_GUIDELINES.md` | Tokens and component rules | present |
| `docs/03_DATA_MODEL.md` | Data model | present (1.2) |
| `TAM_Command_Center/db/` | `schema.sql`, `migrations/0001_initial.sql`, `migrate.py` (reference runner and online backup), `queries/*.sql` (reference Today, Activity, Recent and Summary SQL), `seed_mock.py`, `mock_data.json`, `tests/test_db_contract.py` | present (1.2) |
| `TAM_Command_Center/server/` | FastAPI backend: `config`, `locking`, `logsetup`, `dbkit` (the only DB opener), `backups`, `audit`, `schemas`, `reads` + `infra` + `today` (read repository), `services` (writes and rules), `app` (routes, thin), `runtime`. Run: `python -m server` from `TAM_Command_Center/`. Tests: `pytest server` (118). Deps: `server/requirements.txt`. | present (2.1) |
| `docs/04_API_CONTRACT.md` | Routes, payloads, error shapes, Today queue item shape | present (frozen for run 1) |
| `TAM_Command_Center/VERSION.txt` | `version=0.1.0-rc5`, `channel=dev`. `tools/build_release.py` rewrites it to `channel=prod` inside the release. | present |
| `TAM_Command_Center/*.bat`, `README.txt`, `VALIDATION.txt`, `tools/` | Phase 4.3: five Windows launchers/checks, `tools/_resolve_python.bat`, `env_check.py`, `open_when_ready.py`, `build_release.py`, `smoke_release.py`, `lint_bat.py`. Build: `python tools/build_release.py [--channel prod\|dev]` (output `dist/`). Smoke: `python tools/smoke_release.py --work <scratch dir>`. | present (4.3); .bat files never executed |
| `TAM_Command_Center/frontend/` | React + TypeScript + Vite source (Run 2 adds `pages/today/`, `components/ui/Instruments.tsx`, `lib/triage.ts`, `lib/instruments.ts`, `styles/instruments.css|today.css|refresh.css`). `src/data/` is the only data boundary: `DataSource` interface, `mock/` (`MockDataSource`, `rebase.ts`, `today.ts`, `derive.ts`) and `ApiDataSource.ts` (aligned to `docs/04_API_CONTRACT.md`). `src/components/ui` is the design system, `src/components/editors` the drawers and Quick Capture, `src/pages` the screens, `src/styles/tokens.css` the only file with raw colours. Commands: `npm run dev`, `npm test`, `npm run build`, `npm run build:api`. | present (2.2, 2.3) |
| `TAM_Command_Center/web/` | Build output of `frontend/` (`npm run build` writes here; the backend serves it). `web/` is built with `npm run build:api`: the API adapter is the default and no `mock_data.json` ships (QA-E1-1). `npm run build` still copies the mock file for DEV/demo use. | present (dev build) |

## Completed behaviour
**Phase 2.1 backend (2026-10-12):** all PM §6 routes are implemented per `docs/04_API_CONTRACT.md`: health, state, today, activity, tasks, infrastructure, settings, logs, client/contact/task/note CRUD, backups, DEV reseed. Later-phase routes return 501. It reuses `db/migrate.py` and executes `db/queries/*.sql` unmodified (the Today ranking is not reimplemented). Contracts in force:
- loopback only (Host and Origin guards, strict DEV-only CORS)
- `channel` is required on every DB open (AST test)
- no REPLACE (`sql_safety_scan.py` exits 0 on the whole tree)
- `expected_row_version` mismatch returns 409 with an explicit `row_version + 1` bump
- data and audit rows share one transaction
- an online-API `pre-delete` safety backup runs before every delete, and a backup failure aborts the delete
- structured errors
- browser-disconnect errors are one debug line with no traceback

Phase 4.1 (2026-10-12): FE-AC-1..4 implemented; security headers + CSP, 405, 2 MiB body cap; requirements pinned. See the changelog.

Verification: 107 pytest tests pass on Python 3.12 and 3.10; real server runs checked. See the changelog entry for details.

**Phases 2.2 and 2.3 frontend (2026-10-12):** every screen in `docs/01_PM_SPEC.md` §4 is built: shell with nav rail and top bar (DEV and Mock data tags, clock), Today (tiered queue, Upcoming, Recently changed, Account load), Accounts directory, Account Workspace (Overview, Tasks, Activity, Infrastructure, Contacts and the context rail), global Tasks page, Settings (general, runtime, backups, log), placeholder pages for Operations, BAMS and the ChatGPT Bridge, a component sandbox at `/sandbox`, Quick Capture (`N` or `+ Capture`), and the account jump (`Ctrl+K`). The design system is custom CSS on tokens, with a custom `Select` (WAI-ARIA select-only combobox), an `AccountPicker` (editable combobox), segmented control, tabs, data table, dialog and drawer (focus trap, Escape, focus return, dirty guard), toasts and tooltips. Edits send `expected_row_version`; a 409 `stale_write` shows a Reload / Overwrite banner. The app talks to data only through `DataSource`. `MockDataSource` loads `db/mock_data.json`, applies the rebase rule and the frozen BAMS clock, ports the Today ranking (including D-23 and D-24) and implements CRUD, audit, validation, side effects (D-07, D-08), safety-backup records and activity in memory. A parity test proves the TypeScript ranking matches `db/queries/today_queue.sql` row for row on three dates. `ApiDataSource` was exercised against the live DEV backend (read and write paths, primary switch, D-23, stale write and overwrite). Adapter selection: `?data=mock|api` in the URL (remembered in `sessionStorage`), `VITE_DATA_SOURCE`, then `DEFAULT_SOURCE` (now `api`) in `src/data/index.ts`. Phase 4.1: the UI was driven through the live DEV backend (Today, workspace, note create/edit/delete, `?note=` deep link via `GET /api/note/{id}`, Quick Capture, primary contact); FE-AC-1..4 are consumed. Known gaps are listed in the changelog.

Phase 1.1 planning is complete. Phase 1.2 database layer is done: schema v1, the migration runner contract (pre-migration online backup, no-op rerun), a deterministic relative-date mock seed that covers every Today tier, and reference queries. 

## Operations mockups (T-146)
Delivered in `mockups/operations/` (open `index.html` via `tam-mockups`, port 8780, path `/operations/`). Awaiting user approval before any Operations UI build; README lists open questions (spec D-101..D-105 vs the latest single-Dev-date instruction).

## Current work item
**FE Run 4 done (2026-10-14): T-114, T-115, T-127, T-128, built to the approved mockups.** Routes `/bams`, `/bams/alerts`, `/bams/config`, `/bams/settings`, `/bams/import` (pages in `frontend/src/pages/bams/`, import steps in `components/bams/`, mock engine `data/mock/mockBams*.ts`, styles `styles/bams.css`, tokens only). Vitest 401 pass, `tsc --noEmit` clean, `build:api` done (`web/` rebuilt; Recharts is a separate lazy chunk). Mock: `?data=mock&mockProvider=unavailable` simulates the PROD stub. Deviations from the mockups (all contract-driven unless noted): (1) delete confirmation says a safety backup IS taken (contract §11.6; mockup 06b said none); (2) mockup 06 Unit field dropped and Region is free text (contract); (3) config metric list shows no per-metric rule counts (no API field; shown for the selected metric); (4) "Download skipped rows" is on the result step only (contract §12.5 answers 409 before Apply); (5) highs show dates only (schema); (6) rule type "Percent change" replaced by "Percent of high" (amendment); (7) Alerts view lists the last 5 closed alerts under Needs action and the full list on the Closed history tab; (8) table scrolls horizontally inside its panel below about 1300 px (spec 44). Not done: starter-template editor (routes `configs/save|delete` exist; no mockup), desktop-notification delivery (backend), Windows/Bloomberg checks. The two browser-console lines "422" and "409" seen while testing are the deliberate validation responses, not errors.

**DA T-101/T-122 done (2026-10-14): no schema change needed for Run 4 or BAMS import.** Import fixtures at `db/fixtures/bams_import_rows.json`, tested (db suite 112 OK). 90-day seed history extension still open. See `docs/03_DATA_MODEL.md` section 18.

**BE Run 4 done (2026-10-14): T-102..T-109 and T-123..T-125.** Code in `server/bams/` (provider, monitor, lifecycle, notify, reads, service, routes) and `server/importer/bams_*.py`. Provider/monitor status: DEV runs `SimulatedProvider` (deterministic, percentages 0..100, force/stale/outage via `/api/dev/bams/*`); the monitor loop thread starts with the server (DEV default running, PROD default stopped) and is the only provider caller; the 90-day DEV history is generated by a gap-filling backfill in the simulator path (seed counts unchanged). PROD uses `BlpapiProvider` (real since the BLPAPI task; unavailable without blpapi or the Terminal): every metric reads No Data, lifecycle frozen, banner shown, simulator never constructed. **Unverified on Windows:** the PowerShell toast notifier (`server/bams/notify.py`), the monitor thread under a real Windows service lifetime, and `%LOCALAPPDATA%` paths. **Not built:** real BLPAPI session, reminders, percent-change rule. Deviations from the contract are listed in sections 11.12 and 12.6 of `docs/04_API_CONTRACT.md` (rule delete blocked while an alert is active; audit `source` is GUI/System; appliance matcher adds a number/name-word rule on top of the Run 3 engine). Tests: `pytest server db tests/e2e` 544 passed; `sql_safety_scan.py` 0 violations.

**BE T-100/T-120 done (2026-10-14, contract only):** `docs/04_API_CONTRACT.md` sections 11 (BAMS monitoring) and 12 (BAMS import) are FINAL; no code yet (T-102 onward, T-123 onward are next). Open for PM: mockup 05 "Percent change" rule type and mockup 06 "Unit" field are not in the schema (contract: `pct_of_high`, no unit).

**Run 4 (planned 2026-10-14): first BAMS dashboard.** Plan in `docs/01_PM_SPEC.md` section 12 (D-49 to D-62, T-100 to T-117). Next: BE T-100 (contract) and DA T-101 may start; FE T-110 produces eight mockups in `mockups/bams/`; **no UI build until the user approves them**. DEV simulated data only; PROD fails closed. Runs 2 and 3 status below.

**Run 4 amendment (2026-10-14, user decision): BAMS appliance+metrics bulk import (xlsx/csv, duplicate detection) is IN.** Plan: `docs/01_PM_SPEC.md` section 12.8 (D-63 to D-72, US-14.11 to US-14.16, T-120 to T-132). No schema change. Reuses Run 3 import design. Next: BE T-120 (contract), DA T-122, FE T-121 (mockups 9-13; user approval before T-127). Documents only; no code.

**Run 2 (planned 2026-10-13; T-60, T-61 and the FE tasks T-70 to T-75 done, BE T-62 to T-64 done per the coordinator; QA T-76 next):** Today "Triage Split" (top-10 list, detail pane, chips, ring, Later tabs) and the approved visual refresh of the Account Workspace and Accounts pages. Binding decisions D-26 to D-36 and tasks T-60 to T-77 are in `docs/01_PM_SPEC.md` §0, §7 and §10; visual rules in `docs/02_DESIGN_GUIDELINES.md` §15; three additive API changes in `docs/qa/API_CHANGE_REQUEST.md` (PM-AC-1 to PM-AC-3). No schema change. T-61 (DA, done 2026-10-13): `db/queries/day_progress.sql`, `db/queries/activity_trend.sql`, seed additions (8 of 27 plan tasks done today, 2 done_other; 7-day samples), `db/tests` 109 passed, verifier PASS, scanner 0 violations; details in `docs/03_DATA_MODEL.md` §17. Order: DA (T-61 seed and reference queries) then BE (T-62 to T-64) and FE (T-70 to T-75) in parallel, then QA (T-76) and PM traceability (T-77). The Run 1 item below is complete.

Run 1 covers spec phases 1-2 (foundation, Today, Accounts, Account Workspace, Quick Capture). Backend 2.1 (T-10 to T-13) and frontend 2.2/2.3 (T-20 to T-23) are done. Next: Phase 3.1 checkpoint and 3.2 QA integration. The Phase 1.3 schema re-review (`SCHEMA_REVIEW_5`) is still pending.

## Validation
| Gate | Status |
|---|---|
| Run 2 frontend (T-70 to T-75) | **Built, awaiting QA T-76.** `tsc --noEmit` clean; Vitest 191 passed (14 files); `npm run build:api` ok. Parity with `day_progress.sql` and `activity_trend.sql` pinned on 3 dates. Driven in the Browser pane against a real DEV backend on a scratch DB (port 8791) at 1440, 1100, 768 and 390: no page-level horizontal scroll, no app console errors; ring checked live (complete a plan task: 8 -> 9 of 27, reopen: back to 8). Frontend deviations from the mockups are listed in the changelog and the hand-off report. |
| T-62..T-64 Backend (Run 2) | **PASS**: `.venv/bin/python -m pytest server db tests/e2e` 323 passed (299 before + 24 in `server/tests/test_run2.py`) on the T-61 seed; `db/sql_safety_scan.py` 0 violations. `progress`, `/api/accounts/activity-trend` and `server_tiles` documented in `docs/04_API_CONTRACT.md` §9; PM-AC-1..3 done (`server_tiles` instead of `servers`, see the change request). Frontend `ApiDataSource` wiring (T-75) and QA (T-76) pending. |
| T-61 DB layer (Run 2) | **PASS**: `python -m unittest discover -s db/tests` 109 passed (77 + 32 new); `seed_mock.py all` verifier PASS on 4 dates; `sql_safety_scan.py` 0 violations; vitest 120 passed after regenerating `today_parity_*.json` (117 rows). `pytest server` and `tests/e2e` NOT run (no fastapi in the DA's interpreter): backend-dev must run them on the new seed. |
| 1.3 Schema review | Reviews 1 to 4 REJECTED; gate closed by the orchestrator on 2026-10-12 under the severity policy (no Blocker/High open). `SCHEMA_REVIEW_5` was not run; QA-4-1/2 were verified against real code at Gate 3.2. |
| 2.1 Backend tests | 118 passed after Phase 4.1 (107 before) (Python 3.12 and 3.10, macOS). The scanner finds 0 violations in the whole `TAM_Command_Center/` tree. |
| 2.2 / 2.3 Frontend tests | 118 Vitest tests pass; `tsc --noEmit` clean; `vite build` succeeds. Includes keyboard matrices for `Select` and `AccountPicker`, the Today parity test against the reference SQL, rebase tests, adapter tests, App integration tests and repository guards (no raw colours outside `tokens.css`, `fetch` only in `src/data`, no native select). Verified in the Browser pane at 1440, 1024, 900 and 768 px with no console errors and no page-level horizontal scroll from 768 px. |
| 3.2 QA integration | `docs/qa/ERROR_LOG_1.md`: **PASS (0 open Blocker/High)**. Phase 4.1 fixes (QA-E1-1/2/3/4/7/8) await a formal QA re-check; PM re-ran all suites (239 pytest, 118 vitest) in 4.2. |
| 4.2 Traceability | `docs/05_TRACEABILITY.md`: **COMPLETE** (PASS 111, FAIL 0, MISSING 0, DEFERRED 2: US-12.2 AC1/AC2, Phase 4.3). Verified by PM against the live DEV app on a scratch DB. |
| 4.3 Deployment smoke test | **PASS on macOS (Python 3.10)**: `tools/smoke_release.py`. Archive has no DB/dev_data; schema.sql, migrations, queries shipped; manifest SHA-256 verified; fresh venv install; PROD boots with no auto-seed and ignores test flags; dev-channel build refuses PROD; DEV boots seeded. `.bat` files: static lint only (0 errors), never executed. |
| Run 4 BAMS dashboard and import (T-112..T-132) | **PASS**: `docs/qa/ERROR_LOG_5.md` 0 Blocker/High (8 Low). PM re-ran: pytest 606 passed, vitest 401 passed. `docs/05_TRACEABILITY.md` section 7: PASS 46, FAIL 0, MISSING 0, DEFERRED 2 (Windows toast delivery, US-14.6b). §52 malformed-workbook test for BAMS: PASS. |
| Windows workstation | **untested** (launchers, `.venv` install, `%LOCALAPPDATA%`, `msvcrt` lock, browser open) |
| Bloomberg / BLPAPI | **implemented, tested with a fake session only.** Untested on the workstation: real `blpapi` install, response shapes in `server/bams/blpapi_parse.py` ([U]), session/terminate behaviour, PX_LAST suitability, batch size 500, logged-out behaviour, data limits. Checklist: `docs/BLPAPI_NOTES.md`. TEAM out of scope |

## Next steps
-1. Phase 4.3 done on macOS (US-12.2 AC1 verified by the smoke test; AC2 flagged in `VALIDATION.txt`). Next: run every `.bat` on the target Bloomberg Windows workstation; backend-dev to fix `server/requirements.txt` (websockets 17.2 needs Python 3.11+, uvloop has no Windows wheels); QA to review the release scaffolding.
0. QA re-check of QA-E1-2/3/4/7/8 (Phase 4.1 fixes) at the next gate.
1. 1.3 QA schema re-review (`docs/qa/SCHEMA_REVIEW_5.md`).
2. Phase 3.1: build both trees and commit a checkpoint, then 3.2 QA integration.
3. Phase 4.1: frontend done (default is `api`, `web/` built with `build:api`, FE-AC-1..4 consumed). Remaining: QA re-run against the live API at Gate 4.1; backend to document FE-AC-1..4 in `docs/04_API_CONTRACT.md`.
4. Re-verify the DB layer, the backend and the frontend on the Windows workstation (untested there).

## User decisions
Open (Run 2, defaults in force until answered; see `docs/01_PM_SPEC.md` §10):
1. Ring scope: the ring counts tasks only (D-29). Alternative: also count Critical alerts and overdue upgrades, which needs a completion definition for them.
2. Mark complete in the Today detail pane: left out (D-28) because it was not in the approved field list. Adding it is a small frontend change.
3. Upgrades inside tier 1 rank after all overdue tasks (D-32). Alternative: directly after Critical alerts.
4. Frozen start-of-day ring denominator: not built (needs a schema change request).

Closed (Run 1): on 2026-10-12 the user confirmed Q-1 to Q-5 (the defaults), which made D-01, D-04, D-07, D-08, D-12 and D-22 in `docs/01_PM_SPEC.md` §0 final.

## Binding PM contracts (from `docs/01_PM_SPEC.md` §0)
- **D-11:** optimistic concurrency uses the request field `expected_row_version` (integer). It is compared with `row_version`; a mismatch returns 409 `stale_write`.
- **D-23 (QA-1-12a):** when an open Client Follow-Up task's `due` equals the account's `next_contact`, Today and Upcoming show only the task. `db/queries/today_queue.sql` must implement this; the owner is data-architect-agent, and it needs no schema change.
- **D-24 (QA-1-12b):** Exception upgrades always qualify for queue tier 5, whatever their date. Deferred upgrades stay out of the queue. Same query owner.
- **D-25:**
  - No REPLACE in any spelling; upserts use `ON CONFLICT … DO UPDATE` only, enforced by `db/sql_safety_scan.py`.
  - `channel` is required on every DB open and migrate call.
  - The release ships `db/schema.sql`, `db/migrations/` and `db/queries/`.
- **Run 2 (2026-10-13, D-26 to D-36):**
  - Today = top 10 queue items (queue order), chips, detail pane with no steps / next action / Mark complete; View all = full queue (`?show=`).
  - Ring = tasks only, live: `total = done + open`, `done <= total`, local-day window from the server's `today`; `progress` on `GET /api/today`; no schema change.
  - Tier 1 order: Critical alerts, tasks by priority then due, then upgrades by date (unchanged code; D-04 stands).
  - New visuals use only existing tokens plus three solid tint surfaces; no gradients, no animation, no scores.

## Run 3 (planned): account bulk import with duplicate detection
Status: **frontend built (T-87 to T-91, mock-verified; live API browser check pending); backend T-80 to T-86 in review.** Approved mockups: `mockups/import/01..06`. Decisions D-37 to D-48 and stories US-13.1 to US-13.8 are in `docs/01_PM_SPEC.md` section 11; the proposed API is `docs/04_API_CONTRACT.md` section 10 (backend finalizes first, T-80). Tasks: T-80 to T-86 backend, T-87 to T-91 frontend, T-92 to T-94 QA, T-95 PM traceability. No schema change. New runtime dependency to add and pin: `openpyxl` (release packaging must include it; no packaging task in this run). Behaviour change to a frozen route to be confirmed by backend: `POST /api/client/save` create gains `duplicates_confirmed` (PM-AC-4). Contacts, servers, tasks and notes import remain out of scope.

## Deferred by user (2026-10-14): BLPAPI workstation verification
Real Bloomberg provider is built and fake-session tested only. Left for later, to be done on the Bloomberg workstation: run `tools/bloomberg_probe.py`, check `server/bams/blpapi_parse.py` shapes, logged-out and Terminal-quit behaviour, batch limit, `PX_LAST` suitability. Known risk to decide then: refdata has no source timestamp, so `source_update` is "last changed between polls"; an unchanging value may show Delayed/Stale. Option: base freshness on last successful poll. Also still untested on Windows: toast, launchers, paths.

- T-169 v2.1 (2026-10-14): mockups updated to brief v2.1 (grouped accounts, selection, Set version 3b, Target version). Awaiting approval.
- T-169 (2026-10-14): Operations mockups v2 delivered in mockups/operations/ (replaced rejected v1): operations page + 1024 frame, quarter dialog, appliance edit, empty states, BAMS import additions. Awaiting user approval (gates T-171).

- T-171 (2026-10-15): Operations UI built against contract section 13 (see CHANGELOG). Header Target version display removed per user; quarter version is the greyed default. Live-verified on tam-app-dev; 424 Vitest pass, 3 Today parity tests fail only on the data architect's uncommitted mock_data.json change.
- Run 5 frontend polish (2026-10-15): status badge menu, Workspace Open in Operations link, Enter submits Operations dialogs, header expand toggle, selection mode (OPS-FE-1..3).
- Settings (2026-10-15): Data and Logging are collapsible, collapsed by default (CollapsiblePanel); Data is the container for Run 6 portability content.
- Run 6 portability UI built (2026-10-15): Settings > Data export, restore from file, restore database per contract section 14; database restore awaits backend phase 2 (501 handled). Live check pending a server restart with phase 1 code.
- QA-7-2 (frontend side) and QA-7-4 fixed (2026-10-16).
- ChatGPT Bridge dropped by the user (2026-10-16): nav item, placeholder page and route removed; spec D-21 superseded for it; backend stubs unchanged.
- Settings runtime panel shows the active database name (2026-10-16); top bar intentionally unchanged.
- Bloomberg Terminal `{command}` links built in React source (replaces the temporary web/terminal-links.js approach); task notes visible on Today (2026-10-16).
- BAMS dashboard table is collapsible by account, sharing the Operations group-row component (2026-10-16).
- Task open sequence: read-only popup first, Edit opens the drawer (?task=&edit=1); Today pane section renamed Notes (2026-10-16).
- Mark complete asks for confirmation; toast has Undo (2026-10-16).
- Time display: all timestamps local, 12-hour default via one shared formatter; 12/24 choice kept in the browser until the server setting supports it (2026-10-16).
- Audit log UI, notes-only Activity and backup kinds built against contract section 18 (2026-10-16).
- Accounts page: Notes column, load bars and collapsed-hint copy removed (2026-10-16).
- Workspace Overview due-date histogram removed (2026-10-16).
- Log download buttons and audit retention line built (2026-10-16); dev server restarted on a fresh schema-2 DB.
- Audit log keeps only Download CSV in the UI (2026-10-16).
