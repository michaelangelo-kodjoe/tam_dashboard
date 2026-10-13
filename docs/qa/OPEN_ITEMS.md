# Open Medium/Low items (non-blocking)

| ID | Sev | Owner | Item | Check at |
|---|---|---|---|---|
| QA-4-1 | Medium | data-architect | sql_safety_scan.py misses placeholder table names (fix in progress) | Gate 3.2 against real backend code |
| QA-4-2 | Low | data-architect | scanner misses: alias form, peewee replace(), dict if_exists, UTF-16 .sql, launcher scripts; empty allow marker | Gate 3.2 |
| QA-4-3 | Low | data-architect | scanner false positives on UI copy / SQL data literals | Gate 3.2 |

## Gate 1.3 closed 2026-10-12 (orchestrator, per severity policy)
No Blocker/High open after SCHEMA_REVIEW_4. QA-4-1 and QA-4-2 were fixed by the Data Architect (77/77 tests, 572-statement generated corpus); QA has not re-reviewed them. QA-4-3 is half fixed, half accepted (UI-copy prose needs an allow marker with a reason).
**Verify at Gate 3.2:** run `sql_safety_scan.py` over real `server/` and `frontend/`, and review `--list-allow` output.
