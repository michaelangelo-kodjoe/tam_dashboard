# TAM Command Center: Project State

> This file is the current truth, not a transcript (spec §50). Update it on every substantive code, config, schema, deployment or behaviour change. History belongs in `CHANGELOG.md`.

Last updated: 2026-10-12 by data-architect-agent (Phase 1.2, after QA review 4: scanner only). Previous update: pm-agent (D-11 revised; D-23 to D-25 added; Q-1 to Q-5 confirmed).

## Current release
| | |
|---|---|
| App version | `0.1.0-dev` (not yet built) |
| Channel | dev |
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

Status: designed, not implemented.

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
| `TAM_Command_Center/server/` | FastAPI backend | pending (2.1) |
| `TAM_Command_Center/frontend/` | React source | pending (2.2) |
| `TAM_Command_Center/web/` | Compiled frontend | pending (4.1) |

## Completed behaviour
Phase 1.1 planning is complete. Phase 1.2 database layer is done: schema v1, the migration runner contract (pre-migration online backup, no-op rerun), a deterministic relative-date mock seed that covers every Today tier, and reference queries. Nothing has been built yet beyond the DB layer.

## Current work item
Run 1 covers spec phases 1-2 (foundation, Today, Accounts, Account Workspace, Quick Capture). Next step: **Phase 1.3, the QA schema gate** (T-05) on `db/` and `docs/03_DATA_MODEL.md`.

## Validation
| Gate | Status |
|---|---|
| 1.3 Schema review | Reviews 1 to 4: **REJECTED**. Fixes are applied; review 5 is pending (the iteration cap for the REPLACE item). |
| 3.2 QA integration | not run |
| 4.2 Traceability | not run |
| 4.3 Deployment smoke test | not run |
| Windows workstation | **untested** |
| Bloomberg / BLPAPI / TEAM | **untested and out of scope this run** |

## Next steps
1. 1.3 QA schema re-review (`docs/qa/SCHEMA_REVIEW_5.md`).
2. Backend and `MockDataSource` must mirror the D-23 and D-24 predicates from `db/queries/today_queue.sql`. The PM items D-11, QA-1-12a and QA-1-12b are resolved.
3. Re-verify the DB layer on the Windows workstation's Python/SQLite (untested there).
3. 2.1 backend and 2.2 frontend, in parallel.

## User decisions
None open. On 2026-10-12 the user confirmed Q-1 to Q-5 (the defaults), which made D-01, D-04, D-07, D-08, D-12 and D-22 in `docs/01_PM_SPEC.md` §0 final.

## Binding PM contracts (from `docs/01_PM_SPEC.md` §0)
- **D-11:** optimistic concurrency uses the request field `expected_row_version` (integer). It is compared with `row_version`; a mismatch returns 409 `stale_write`.
- **D-23 (QA-1-12a):** when an open Client Follow-Up task's `due` equals the account's `next_contact`, Today and Upcoming show only the task. `db/queries/today_queue.sql` must implement this; the owner is data-architect-agent, and it needs no schema change.
- **D-24 (QA-1-12b):** Exception upgrades always qualify for queue tier 5, whatever their date. Deferred upgrades stay out of the queue. Same query owner.
- **D-25:**
  - No REPLACE in any spelling; upserts use `ON CONFLICT … DO UPDATE` only, enforced by `db/sql_safety_scan.py`.
  - `channel` is required on every DB open and migrate call.
  - The release ships `db/schema.sql`, `db/migrations/` and `db/queries/`.
