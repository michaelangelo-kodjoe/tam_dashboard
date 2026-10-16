# TAM Command Center: Handoff

Last updated: 2026-10-15. Read this first, then `docs/TEAM_LOOP.md`. Start a session as the lead with `claude --agent team-lead-agent` (agents live in `.claude/agents/`).

## State
Runs 1-6 are built, QA-passed, and committed (latest gates: `docs/qa/ERROR_LOG_6.md` Operations, `docs/qa/ERROR_LOG_7.md` portability, both PASS, 0 open Blocker/High). Tests at the last gate: 711 backend/db/e2e, 451 frontend. The ChatGPT Bridge was DROPPED by the user on 2026-10-15 (not planned, not built).

| Run | Scope | Status |
|---|---|---|
| 1 | Foundation, Today, Accounts, Account Workspace, Tasks, Quick Capture, Settings | Done, user-reviewed |
| 2 | Visual refresh: Today as Triage Split (top 10 + chips + detail pane, done-today ring, tabs under list), workspace and Accounts instruments | Done, user said "this looks fine / good" |
| 3 | Account bulk import (.xlsx + .csv), duplicate detection (similar names need Same/Different/Skip confirmation), single-add similar check | Done, user said "this is good" |
| 4 | BAMS monitoring dashboard (simulated DEV provider, lifecycle, notifications), appliance/metric bulk import, BlpapiProvider | Done, gate PASS |
| 5 | Operations: one simple page (quarters + target version entered manually, account-grouped collapsible appliances, status/overrides, Select mode), appliance import gains East/West Polarity; no schedule sync | Done, user said "this is good" |
| 6 | Portability: Excel export (9 sheets), database export, restore from .xlsx/.csv (never overwrites), in-app whole-database restore (typed RESTORE, pre-restore backup, rollback); Settings Data and Logging collapsed by default | Done, gate PASS |

## Not built (spec phases still ahead)
Nothing planned. The ChatGPT Bridge was dropped by the user (removed from the nav rail and routes). Windows and Bloomberg verification remain.


## Do not do without the user
- Build any UI before mockups are approved.
- Package/release. `TAM_Command_Center/dist/` holds a stale rc1 draft zip (gitignored) from before Runs 2-3; the Windows launchers, env checks, `tools/build_release.py` and `tools/smoke_release.py` exist. Rebuild only on explicit go-ahead.
- Call anything production-ready. Windows (.bat files, `msvcrt` lock, `%LOCALAPPDATA%`) and Bloomberg BLPAPI/TEAM/BSSO are untested.

## User preferences learned
- Mockups and approval before building; show real running app for review.
- All agents Sonnet, medium effort, tight prompts, watch tokens (rate limit hit 3 times; reset times were late evening).
- Only Blocker/High fail a gate; Medium/Low tracked in `docs/qa/OPEN_ITEMS.md`.
- Account import accepts .xlsx and .csv only (no .xls/.tsv); no percentages or scores shown; Same account = fill blanks only.
- Frontend design work uses the `ui-ux-pro-max:ui-ux-pro-max` skill.

## Open items (all Low/non-blocking; see `docs/qa/OPEN_ITEMS.md`)
Import is a modal not an `/accounts/import` page (QA-E4-1); abbreviation rule over-flags short words (QA-E4-2); `react-router-dom` moderate npm audit finding needs a 7.x major upgrade (QA-E1-6); scanner misses contrived dynamic REPLACE (QA-E1-5); Run 3 Lows on contrast/clipping (QA-E3-1..7); optional extra frontend tests (T-2).

## Running the app
- Source of truth: spec `docs/SPEC.md`, PM decisions `docs/01_PM_SPEC.md` (D-01..D-48), design `docs/02_DESIGN_GUIDELINES.md`, data `docs/03_DATA_MODEL.md`, API `docs/04_API_CONTRACT.md`, status `TAM_Command_Center/TAM_PROJECT_STATE.md`, history `TAM_Command_Center/CHANGELOG.md`.
- Dev app: `preview_start` config `tam-app-dev` (port 8766, DEV mode, sample data in `TAM_Command_Center/dev_data/`, gitignored). Mockups: `tam-mockups` (8780, files in `TAM_Command_Center/mockups/`). Preview servers are stopped when the app idles; restart on request. Delete a stale `dev_data/tam_dev.db*` first so the seed matches today.
- Python venv: `TAM_Command_Center/.venv` (run from `TAM_Command_Center/`): `.venv/bin/python -m pytest server db tests/e2e`; frontend: `npm --prefix frontend run test|build:api`.
