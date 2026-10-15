# ERROR_LOG_6: Gate 3.2/3.3, Run 5 Operations (2026-10-15)

Scope: spec 01_PM_SPEC.md section 13 (D-107..D-121), contract 04_API_CONTRACT.md section 13, server/ops/, importer changes, Operations page, seed.

## Results run
- pytest (server db tests/e2e): 636 passed, 17 subtests, 0 failed.
- Vitest: 31 files, 427 passed. tsc --noEmit: 0 errors. build:api: OK.
- bandit (-ll, server/ops + server/importer): 4 Medium B608 (constant column strings, false positives; see QA-6-4), 0 High. ruff/pip-audit/npm audit not run (ruff not installed; npm audit not re-run this gate).
- Network code under server/ops: grep for requests/httpx/urllib/socket/subprocess/http = none.
- Live API e2e on tam-app-dev (8766): quarter create/duplicate (409 "2031 Q2 already exists. Edit it instead.")/edit (row_version 1->2)/stale (409 stale_write)/delete (blocked 409 while a record exists, then 409 confirmation_required, then 200 with pre-delete backup)/re-delete 404; version auto-apply after quarter edit (all 25 appliances -> 9.0.0 then 9.1.0, source=quarter); appliance save (create, partial update, null status 422, stale 409, notes with script tag stored verbatim, 20001-char note 422, control-char version 422); reset (no confirm 409, confirm 200 + backup, repeat 200 no-op); PROD without East/West save 422 "Set East or West first..."; set-version (200, empty list 422, 501 ids 422, unknown quarter 404, clear with null); SQL-injection strings in q (200, no effect) and status (422); bad enum/year-only 422; other /api/operations/* 501.
- Audit rows verified in audit_events (category operations, source GUI, old/new, reason "set version" / "safety backup <file>"). Backups created on quarter delete and appliance reset.
- Browser at 1024 wide: add-quarter duplicate inline error, edit quarter 7.2.0->7.2.9 (appliances without own version show "default 7.2.9"), status change toast, edit dialog and Reset to quarter confirm, bulk set-version on 3 selected ("Version set on 3"), filter deep link (?quarter=2026-Q4&status=Scheduled&env=PROD&pol=unset&q=brs shows 2 of 25), collapsible account groups, no console errors beyond the intentional 409. No scores/percentages/progress in pages/OperationsPage.tsx or pages/operations/ (grep). No right-aligned header version.
- Not verified live: BAMS file upload note (covered only by pytest test_polarity_alias_and_east_west_normalisation, test_ops_note_counts_missing_env_and_respects_existing_values), 375 px width.
- My test data (2031 Q2) was created and deleted; dev DB 2026 Q4 version restored to 7.2.0.

## Findings

| ID | Sev | Owner | Spec | Item |
|---|---|---|---|---|
| QA-6-1 | Medium | backend-dev (count) + data-architect (seed) | 13 D-111 delete guard; contract 13.1 `records` | `quarters[].records` counts every server_upgrades row for the quarter, including rows whose (client, server_name) matches no appliance. Fresh seed: 28 of 82 rows are orphans; dev UI shows "34 appliances have a status in this quarter" with 25 appliances, Delete quarter disabled, and no UI path to clear them (reset works only on listed appliances). Same would happen after a BAMS appliance rename (records keyed by client_id + server_name). Repro: open Edit 2026 Q4 on seeded DB. Expected: count and block only visible appliances (or seed without orphans). |
| QA-6-2 | Low | data-architect / orchestrator | seed realism | Running dev DB (dev_data/tam_dev.db) is stale vs current seed: regions AMER/EMEA/APAC, only 1 of 25 appliances East/West, so almost every PROD row reads "East/West not set". Fresh seed gives 22 East/West. Reseed (`seed_mock.py --reset`) before user review. |
| QA-6-3 | Low | data-architect | D-107 auto-apply demo | Seeded records copy the quarter version into their own version, so after a quarter edit only 2 of 25 appliances follow it. Correct per spec, but the seed does not demonstrate the headline user decision. Leave most records' own version blank. |
| QA-6-4 | Low | backend-dev | hygiene | bandit B608 x2 in server/ops/repo.py (f-string over constant QCOLS) and x2 in importer/repo.py. False positives; add `# nosec B608` with reason. |

No Blocker or High items.

VERDICT: PASS (0 open Blocker/High)
