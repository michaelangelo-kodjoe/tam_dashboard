# ERROR_LOG_8: Post-rc5 changes, Gate 3.2 (2026-10-16)

Scope: BAMS freshness, Terminal links, task popup/complete+Undo, BAMS grouping, am/pm time, Activity notes-only, Audit log UI/API, weekly backups, log download/cleanup, audit pruning (migration 0002), TAM_DB_NAME/launchers (static). Dev app on 8766 untouched except normal UI use (time display toggled and restored; one task completed then Undone).

## Automated
- `pytest server db tests/e2e`: 828 passed, 0 failed (175 s). No load flakes seen this run (run4 import e2e and perf tests passed in the single run).
- Vitest 38 files / 489 tests passed. `tsc --noEmit` exit 0. `build:api` built. `db/sql_safety_scan.py`: 0 violations. `lint_bat.py`: 0 errors (7 files).
- bandit -r server (tests excluded): 12 Low, 0 Medium, 0 High. pip-audit: no known vulnerabilities. npm audit --omit=dev: 2 moderate (react-router, already QA-E5-8). Date-only functions run under TZ Pacific/Kiritimati, Pago_Pago, New_York, UTC: identical output; 12 am/12 pm correct.

## Schema 1 -> 2 on a populated v1 DB (scratch DB `qa8_v1`, built from committed 0001 + seed_mock, 12 accounts/35 contacts/183 tasks/210 notes/809 audit/1440 samples, probe audit rows aged 400, 60, 15.5, 13.5, 3 and 0.1 days)
- Forced failure (copy of 0002 + bad statement, real `Runtime` startup): pre-migration backup written, transaction rolled back, DB byte-identical to the v1 original (cmp), version 1, old trigger intact, backup kept. See QA-8-1 for the exit code.
- Real `python -m server` start: schema 1 -> 2, all table counts unchanged, one `migrated` audit row, pre-migration backup present, weekly backup taken, trigger replaced, `schema_version`=2, prune anchor set.
- Direct SQL on the live DB: DELETE of rows aged 3 d, 13.5 d, 0.1 d and the newest row refused ("newer than 14 days"); UPDATE refused (append-only); INSERT OR REPLACE with existing id refused; DELETE of 15.5 d and 400 d rows allowed; AUTOINCREMENT seq not reused (next id 811 after 810). Only DELETE FROM audit_events in code: auditprune.py and migrate.purge_audit_events (DEV reseed, transactional).
- Prune job with an injected clock: day+5 nothing; day+15 removed 624 old rows, kept 185 (0 older than 14 d), wrote exactly one `pruned` audit row; repeat at +15 d/+5 min and +20 d: no second run; clock +40 d: removed 0 (cutoff is clamped to the real clock). Anchor and last-run persist in app_meta (restart does not double-run). First start only sets the anchor.
- Whole-DB restore of the v1 file via API: preview `will_upgrade_from: 1`, apply succeeded, live DB at schema 2 with the new trigger, counts equal, pre-restore backup created.
- After pruning, Today `progress` (8/27 done) and `recent_changes` (20) identical before and after.

## Live (dev app 8766, 1024 px and 375 px)
BAMS group collapse/expand per account and expand-all work; Operations untouched (not changed). Terminal link in a queue row: href `bbg://screens/DRQS%20675842766`, click did not change selection or open a popup. Tasks: row opens read-only popup (`?task=`), Edit opens drawer (`&edit=1`), Esc returns. Mark complete: No leaves status and row_version unchanged; Yes completes (audit `completed`); Undo restores In Progress (audit `reopened`). Today Notes pane present. Time display toggle 12h/24h changes top bar immediately. Activity tab shows notes only; Accounts list has no Notes column. Audit log: filters (action, text), hostile text `<script>...' OR 1=1--` rendered as inert empty result; "Entries older than 14 days are removed every 2 weeks" text present. API: export csv/xlsx 200 with attachment names, bad enum/date/limit/offset 422, logs download zip/current 200, `file=../../etc/passwd` 422, extra `path` param ignored. Backups list shows kind badge (Safety/Weekly); no manual backup present to inspect. Console: no errors. No scores/percentages on Today, Accounts, Tasks, Settings (BAMS shows metric values only). Download buttons were not clicked in the browser (files verified with curl).

## Items
| ID | Sev | Owner | Spec | Item |
|---|---|---|---|---|
| QA-8-1 | Medium | backend-dev (db/migrate.py, server/runtime.py) | TEAM_LOOP safety, contract 16 exit codes | A migration that fails with a raw `sqlite3.Error` (bad SQL, disk full) is not converted to `MigrationError`/`StartupRefused`. Repro: scratch `Runtime` on a v1 DB with a 0002 containing `INSERT INTO nonexistent_table VALUES (1);`. Expected: exit code 4 with a "Database refused / failed migration" message (the launcher prints that text for 4). Actual: unhandled `sqlite3.OperationalError: no such table` traceback, process exit 1, launcher says "stopped with exit code 1". Data safe: rolled back, backup kept (verified). Needs a contrived failure, so Medium. |

## Re-verification of earlier items
QA-E5-8 (react-router advisories) still open, unchanged (Low). No regressions found in items from ERROR_LOG_7 touched by this change (restore from file/database exercised via the v1 upgrade path).

## Not testable here
Windows launcher flow (`choose_db.py` timed prompt, .bat) reviewed statically only: DB name is validated (`^[A-Za-z0-9_-]{1,40}$`, reserved names), env var is passed through, no path parts; lint clean; choose_db parity tests pass in the suite.

VERDICT: PASS (0 open Blocker/High)
