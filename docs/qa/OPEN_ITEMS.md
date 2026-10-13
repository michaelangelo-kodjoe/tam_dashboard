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
| QA-E1-1 | Medium | frontend-dev / backend-dev | Default `web/` build uses the mock adapter; API only with `?data=api` (Phase 4.1 swap) | Gate 4.1 |
| QA-E1-2 | Low | backend-dev | No X-Frame-Options / CSP frame-ancestors / CSP headers | next gate |
| QA-E1-3 | Low | backend-dev | `DELETE /api/health` returns 404 not 405; `HEAD /` 405 | next gate |
| QA-E1-4 | Low | backend-dev | No request body size cap (20 MB body read, 422) | next gate |
| QA-E1-5 | Low | data-architect | Scanner misses keyword-split concatenation, `\x` escapes, dynamic REPLACE | next gate |
| QA-E1-6 | Low | frontend-dev | npm audit: react-router-dom moderate (shipped); vite/vitest/esbuild dev-only high/critical | next gate |
| QA-E1-7 | Low | backend-dev / deployment | pip-audit and bandit not installed; requirements unpinned | Gate 4.3 |
| QA-E1-8 | Low | backend-dev | FE-AC-1..4 API change requests still open | next gate |
