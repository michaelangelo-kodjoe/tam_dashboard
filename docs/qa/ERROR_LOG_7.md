# ERROR_LOG_7: Run 6 Portability, Gate 3.2 (2026-10-15)

Scope: docs/01_PM_SPEC.md 14 (D-122..D-142), docs/04_API_CONTRACT.md 14, server/portability/*, dbkit, Settings > Data portability UI, tests/fixtures/portability. Dev server on 8766 was restarted on new code with a fresh seed; a PROD scratch instance (port 8790, scratch LOCALAPPDATA) was used for channel and concurrency tests.

## Automated results
- pytest server db tests/e2e: 708 passed, 0 failed (121 s).
- Vitest: 33 files, 448 tests passed. `tsc --noEmit`: exit 0. `npm run build:api`: built; hashes unchanged (web/ matches source).
- bandit -r server: High 0; Medium 6, all in server/tests (B608/B310/B108); portability/dbkit production code has one Low (B101 assert, dbrestore.py:379, retry loop). SQL scan of server/portability: every f-string SQL uses fixed table/column identifiers from tables.py (`# nosec B608` with reason); all values bound by name. No user text reaches SQL.
- Not available: pip-audit, npm audit not re-run (unchanged dependencies; QA-E5-8 stays open).

## Live results (all against real servers)
- Export Excel: sheets About + 8; row counts equal SQLite counts (12/35/183/210/27/103/3/82); no formula cells, no vba/external parts; no secret-like strings. Round trip of the export: 655 identical, 0 new (nothing_to_restore).
- Text guard: names `=cmd|...`, `+1+1`, `-2+3`, `@SUM(1)`, `'=quoted` exported with one extra leading `'` (string cells); re-inspect of the export: 7 identical; DB stores raw values.
- Export database: `tam_backup_..._v1.db`, integrity ok, no temp file left, no setting/credential tables.
- File restore xlsx: preview, noconfirm 409 confirmation_required, bad hash 409 preview_stale, apply added 11, row_version 1, original timestamps, 8 audit events, pre-import backup, second apply 409 already_applied, skipped.csv/.xlsx before apply 409 and after 200, re-inspect shows 11 identical (never overwritten, "differs" row skipped, formula row invalid).
- CSV restore: 9 files in one session, headers detect tables, BOM/semicolon/shuffled variants OK, Unrecognized blocks apply, table_already_added, mixed_formats, missing_parent, two_primaries, bad values, dup name, dup ticker all refused per row.
- Limits: 26 MiB 413 too_large; 10,001 rows 422 too_many_rows; .exe unsupported_type; empty corrupt; binary csv not_csv; 600 MiB-inflating xlsx zip_unsafe; DOCTYPE/entity xlsx xml_unsafe; newer_schema.xlsx schema_newer; not_an_export refused.
- Channels: DEV xlsx and DEV db into PROD channel_mismatch ("Sample data cannot be restored into the production database"); PROD xlsx into DEV accepted; /api/dev/* 404 in PROD; /api/data/reset 501; no Reset-all-data in UI.
- DB restore: not_sqlite, foreign sqlite, truncated (integrity_failed), channel mismatch, schema_newer (99), no_channel_stamp all refused; from-backup names `../../etc/passwd`, `..\x.db`, `/etc/passwd`, `x.db/../../tam_dev.db` all 404; lowercase, trailing space, empty, "yes" all 409 confirm_mismatch; apply 200, data 14 to 12 clients, integrity ok, audit `restored/backup/System`, restore_tmp empty, staged id then 410; during apply 8 requests got 503 `restoring` with Retry-After 2 and /api/health stayed 200 `restoring:true`; undo via the pre-restore backup restored 14 clients; staged file deleted before apply gives clean 422 integrity_failed, live data unchanged; two concurrent applies: one 200, one 409 apply_in_progress; 501 MiB stream 413 in 0.2 s with the earlier session intact.
- UI (Settings, desktop 1024 and 375 wide): Data and Logging collapsed on a fresh tab; Data opens; backup row Restore opens preview table with "N fewer" markers, warning, typed RESTORE field; lowercase keeps the button disabled; apply reloaded the app, network all 200, console no errors. Export to Excel issues GET /api/export/excel. No percentages or scores in portability UI (grep). 375 px layout is cramped but usable.
- Packaging: tools/build_release.py BANNED_PARTS/BANNED_SUFFIX exclude dev_data, `*.db`, `-wal`, `-shm`; restore_tmp lives under the data dir, outside the app tree.
- Not verified live: choosing files in the Restore from file and Restore database dialogs (browser tool cannot open a file chooser); covered by Vitest and the API tests above. Windows-only file replace behaviour not testable on this host.

## Items (all Medium/Low; none blocks the gate)
| ID | Sev | Owner | Spec | Item |
|---|---|---|---|---|
| QA-7-1 | Low | backend-dev | 14.5 (staged files never in Backups) | `POST /api/restore/database/from-backup` opens the backup read-only and leaves `<name>.db-wal` and `<name>.db-shm` next to it in TAM_Backups. Repro: call from-backup with any listed name, `ls dev_data/TAM_Backups`. Expected: no sidecars (stage via a copy outside Backups or immutable=1). Actual: both files created (0 B / 32 KiB). Not listed in Backups, not auto-pruned. |
| QA-7-2 | Low | backend-dev / frontend-dev | 14.3 apply result `files` | For an xlsx restore, `item.files` repeats the workbook name once per sheet (8x); the result panel prints `r.files.join(', ')` so the user sees the same name eight times. Dedupe. |
| QA-7-3 | Low | backend-dev | 14.3 invalid codes | A text value starting with TAB (account name `\tTAB`) is skipped as `database_rule` ("values in this row do not fit together") instead of a specific column message. Data is safe; wording is unhelpful. |
| QA-7-4 | Low | frontend-dev | D-136 | Settings Data dialog at 375 px: description column squeezed to about 70 px wide beside the buttons (wraps to 10+ lines). Usable, cosmetic. |

VERDICT: PASS (0 open Blocker/High)
