# Open Medium/Low items (non-blocking)

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-4-1 | Medium | data-architect | sql_safety_scan.py misses placeholder table names (fix in progress) | Gate 3.2 against real backend code |
| QA-4-2 | Low | data-architect | scanner misses: alias form, peewee replace(), dict if_exists, UTF-16 .sql, launcher scripts; empty allow marker | Gate 3.2 |
| QA-4-3 | Low | data-architect | scanner false positives on UI copy / SQL data literals | Gate 3.2 |

## Gate 1.3 closed 2026-10-12 (orchestrator, per severity policy)
No Blocker/High open after SCHEMA_REVIEW_4. QA-4-1 and QA-4-2 were fixed by the Data Architect (77/77 tests, 572-statement generated corpus); QA has not re-reviewed them. QA-4-3 is half fixed, half accepted (UI-copy prose needs an allow marker with a reason).
**Verify at Gate 3.2:** run `sql_safety_scan.py` over real `server/` and `frontend/`, and review `--list-allow` output.

## Gate 3.2, ERROR_LOG_1 (2026-10-12): PASS (0 open Blocker/High)
QA-4-1 and QA-4-2 verified against real code and closed (residual contrived evasion tracked as QA-E1-5). QA-4-3 accepted. 0 scanner violations, 0 allow markers.

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-E1-1 | Medium | frontend-dev / backend-dev | ~~Default `web/` build uses the mock adapter~~ **FIXED 2026-10-12 (frontend-dev):** default is `api`, `web/` built via `build:api` without `mock_data.json`; `?data=mock` is DEV/demo only; test `src/data/index.test.ts`. Verified in browser against live backend. | CLOSED at Gate 3.2 re-test (ERROR_LOG_2) |
| QA-E1-2 | Low | backend-dev | No X-Frame-Options / CSP frame-ancestors / CSP headers | FIXED 2026-10-12 (Phase 4.1), CLOSED at Gate 3.2 re-test (ERROR_LOG_2) (residue: QA-E2-1) |
| QA-E1-3 | Low | backend-dev | `DELETE /api/health` returns 404 not 405; `HEAD /` 405 | FIXED 2026-10-12 (Phase 4.1), CLOSED at Gate 3.2 re-test (ERROR_LOG_2) (residue: QA-E2-2) |
| QA-E1-4 | Low | backend-dev | No request body size cap (20 MB body read, 422) | FIXED 2026-10-12 (Phase 4.1), CLOSED at Gate 3.2 re-test (ERROR_LOG_2) |
| QA-E1-5 | Low | data-architect | Scanner misses keyword-split concatenation, `\x` escapes, dynamic REPLACE (re-confirmed 3 of 12 corpus cases at ERROR_LOG_2; accepted residue) | next gate |
| QA-E1-6 | Low | frontend-dev | npm audit: react-router-dom 6.30.6 moderate (shipped; fix is 7.x major); vite/vitest/esbuild dev-only high/critical. Unchanged at ERROR_LOG_2 (8 findings) | next gate |
| QA-E1-7 | Low | backend-dev / deployment | pip-audit and bandit not installed; requirements unpinned | PARTLY FIXED 2026-10-12: requirements pinned; pip-audit (0 vulns) and bandit (0 High, 8 Medium B608 false positives) run. Deployment owns the release lock. 2026-10-12 backend-dev: requirements split into runtime requirements.txt (installs on Python 3.10-3.12, incl. Windows) and requirements-dev.txt; verified on 3.10 (pip check, DEV /api/state, pytest 267 passed, smoke_release PASS). CLOSED at Gate 3.2 re-test (ERROR_LOG_2) |
| QA-E1-8 | Low | backend-dev | FE-AC-1..4: routes/fields implemented, consumed by the frontend, documented in `docs/04_API_CONTRACT.md`, `API_CHANGE_REQUEST.md` marked done | FIXED 2026-10-12 (Phase 4.1), CLOSED at Gate 3.2 re-test (ERROR_LOG_2) |

## Phase 4.1 (backend-dev-agent, 2026-10-12)
FE-AC-1..4 implemented and documented in `docs/04_API_CONTRACT.md`; QA-E1-2, -3, -4, -8 fixed; QA-E1-7 partly fixed (see above). `pytest server` 118 passed (11 new in `server/tests/test_phase41.py`), `pytest db` 77 passed, e2e 44 passed, `sql_safety_scan.py` 0 violations. QA-E1-1 (default data source) is the frontend's item.

## Gate 3.2 re-test, ERROR_LOG_2 (2026-10-12): PASS (0 open Blocker/High)
QA-E1-1, -2, -3, -4, -7, -8 verified fixed against the built app and HEAD and closed; QA-4-1/2 closed, QA-4-3 accepted. New items:

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-E2-1 | Low | backend-dev | CORS-rejected preflight (400 text/plain) lacks the security headers/CSP (CORSMiddleware answers before the header middleware) | FIXED 2026-10-12 (backend-dev); CLOSED at Gate 3.2 Run 2 (ERROR_LOG_3, strict test passes) |
| QA-E2-2 | Low | backend-dev | `GET /api/note/save` and `/api/note/delete` return 405 without an `Allow` header (note_get special case in `server/app.py`) | FIXED 2026-10-12 (backend-dev); CLOSED at Run 2 gate (ERROR_LOG_3) |
| QA-E2-3 | Medium | frontend-dev | Top-bar "+ Capture" button does not prefill the current account (PM US-10.1 AC2); only the `N` key does. `TopBar.tsx` calls `openCapture()` without `clientId` | FIXED 2026-10-12 (frontend-dev): TopBar passes the current `clientId` like the N key; regression tests in `App.test.tsx`; verified in browser on a DEV backend. CLOSED at Run 2 gate (ERROR_LOG_3, re-checked in the browser) |

Strict-xfail tests pin QA-E2-1 and QA-E2-2 in `TAM_Command_Center/tests/e2e/test_gate32_retest_e2e.py`; xfail marks removed 2026-10-12 after the QA-E2-1/-2 fixes; the tests now pass.

- T-1 (traceability, Low) FIXED 2026-10-12 (frontend-dev): `build:api` no longer ships the mock adapter, `loadMockFile` or `mock_data.json`. T-2 (Low) not addressed (needs timer/redirect tests, more than a few minutes).

## Run 2 gate, ERROR_LOG_3 (2026-10-13): PASS (0 open Blocker/High)
Verified: Triage Split Today (top 10, chips, `?show=`, keyboard, detail pane without steps/Mark complete, Later tabs), done-today ring against an independent SQL recomputation in three timezones, workspace and Accounts instruments (counts, sparklines, Needs attention order), calm rules, widths 1440/1100/768/390, Run 1 and security regressions. QA-E2-1/-2/-3 closed. New items, all Low:

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-E3-1 | Low | frontend-dev | Accounts "Alerts" cell says "N open" for recovered alerts and always uses a warning dot (also for Critical); the Servers dot-row says "0 with an alert" for an account with an open Info alert (`AccountsPage.tsx:86`) | next gate |
| QA-E3-2 | Low | pm (guidelines) + frontend-dev | `--subtle` (3.88:1 on surface-1) used for readable text ("No trend data", histogram axis labels); guidelines §1 and §15.4 contradict each other | next gate |
| QA-E3-3 | Low | pm | Guidelines §15.6 #10 grep text is broader than the code (Run 1 keyframes and one inset box-shadow); reword to Run 2 files and Today steady state. Run 1 animations accepted | next gate |
| QA-E3-4 | Low | frontend-dev | Alert detail fact reads "Opened ... 2d overdue"; use "2d ago" for Opened | next gate |
| QA-E3-5 | Low | data-architect | Seed: sparkline latest sample (99) differs from the alert value (97.4); "DEV DEV" in dev-server context | next gate |
| QA-E3-6 | Low | frontend-dev | Below 768 wide: search placeholder clipped, header Alerts text clipped, lower-case Needs attention reason | next gate |
| QA-E3-7 | Low | frontend-dev | Midnight-rollover refetch has no vitest (works in browser); page-wide arrow handler stops arrow-key page scrolling on Today (by design D-26) | next gate |

New QA tests: `TAM_Command_Center/tests/e2e/test_gate_run2_e2e.py` (24 cases, three timezones). Still open from earlier: QA-E1-5, QA-E1-6 (Low).

## Run 3 gate, ERROR_LOG_4 (2026-10-13): PASS (0 open Blocker/High)
Account bulk import verified live (pytest 473 + 22 new e2e, vitest 326, tsc 0, scan 0). New items, both Low:

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-E4-1 | Low | frontend-dev / pm | Import is a modal on `/accounts`, not the `/accounts/import` page route of PM 11.1; amend spec or add route | next gate |
| QA-E4-2 | Low | pm | Abbreviation rule (D-41) flags short real words ('Lane'/'Lantern', 'cmd'/'Commodities'); consider min length 4 | next gate |

New QA tests: `TAM_Command_Center/tests/e2e/test_gate_run3_import_e2e.py` (22 cases).

## Run 4 gate, ERROR_LOG_5 (2026-10-14): PASS (0 open Blocker/High)
BAMS dashboard and appliance/metrics import verified live (pytest 606, vitest 401, tsc 0, scan 0). New items, all Low:

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-E5-1 | Low | backend-dev / pm | Valid account name with unknown BPID is accepted silently (D-65 ambiguity) | next gate |
| QA-E5-2 | Low | data-architect | Seed highs above 100% for percent metrics; Mbps metric shown as % | next gate |
| QA-E5-3 | Low | data-architect / backend-dev | First DEV poll recovers 7 of 8 seeded open alerts | next gate |
| QA-E5-4 | Low | frontend-dev | Trend chart repeats x-axis date ticks | next gate |
| QA-E5-5 | Low | frontend-dev | Import step tabs/columns table clipped at 375 px | next gate |
| QA-E5-6 | Low | backend-dev | Audit reason "rows 2, 3" vs contract "row N" | next gate |
| QA-E5-7 | Low | backend-dev | bandit B324 sha1 (2 sites), B613 literal zero-width chars in regex (2 sites) | next gate |
| QA-E5-8 | Low | frontend-dev | npm audit react-router 6.x moderate advisories | dependency pass |

New QA tests: `TAM_Command_Center/tests/e2e/test_gate_run4_bams_e2e.py` (43), `test_gate_run4_import_e2e.py` (19). Not verified: Windows toast, real-UI file upload, import_expired after restart.
