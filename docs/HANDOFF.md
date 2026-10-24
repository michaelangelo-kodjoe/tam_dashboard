# TAM Command Center: Handoff

Last updated: 2026-10-24. Read this first, then `docs/TEAM_LOOP.md`. Start a session as the lead with `claude --agent team-lead-agent` (agents live in `.claude/agents/`).

## Current state (2026-10-24): release 0.2.0-rc3 (lean package) packaged, UNVALIDATED
- rc3 = same app code as rc2; the archive omits CHANGELOG.md, TAM_PROJECT_STATE.md, README.txt, VALIDATION.txt and docs/guides (repo copies stay). `TAM_Command_Center_0.2.0-rc3_win.zip` not committed; rc1/rc2 zips untouched. Details below are for rc2.
- `TAM_Command_Center_0.2.0-rc2_win.zip` (+ `.sha256`) built by `tools/build_release.py` (channel prod, schema 3, blpapi in requirements); not committed (rc6/rc1 precedent; the rc1 zip is kept untouched). Gates QA-W1..W4 PASS, 0 open Blocker/High. Tests at build: 739 pytest (`.venv/bin/python -m pytest server db -q`), 580 Vitest, tsc clean, sql_safety_scan 0.
- rc1 -> rc2 delta: Overview "Upgrades, Next 30 Days" panel, `upgrades_30d` API key, Operations 'default' target-version display removed, purple token, server tiles removed.
- Resume: user validates the zip on the Bloomberg Windows workstation. Unverified there: NotifyIcon notifications, real blpapi LAST_PRICE polling, PROD mode on Windows, Terminal-workbook import via file picker, undo and external paste in the rich-text editor, all .bat files. Smoke ran on macOS with the blpapi requirement line dropped (not on public PyPI). Fix defects they report; do not call it production-ready.
- Pending user decision: BAMS Warning colour is still the app-wide gold `--warning #E8C547`; user asked earlier for amber, undecided.
- Seeded-data note: 28 seed upgrade records have no BAMS appliance, so they show in Operations/Overview without BAMS data.
- Known Lows (docs/qa/OPEN_ITEMS.md): QA-W4-1 Overview marker tooltips are native `title` only; QA-W1-2 failing seeded-alert test on untouched tree (now passing in the 739 run, confirm in OPEN_ITEMS), W1-3/W2-1 npm audit, W1-4 390px horizontal scroll, W1-6 simulator >100%, W2-2 no list-nesting control, W2-3 nested list HTML, W2-4 simulator percent-only, W3-1 one non-reproducible palette Enter. QA-W1-1 (Medium, RichTextEditor `Btn` remount/focus): check OPEN_ITEMS for status.

## State
Runs 1-6 are built, QA-passed, and committed (latest gates: `docs/qa/ERROR_LOG_6.md` Operations, `docs/qa/ERROR_LOG_7.md` portability, both PASS, 0 open Blocker/High). Run 7 (legacy database import, Settings > Data only) is in PLANNING: `docs/01_PM_SPEC.md` section 15 (D-143..D-153, T-186..T-192), mockups waived, build directly. Tests at the last gate: 711 backend/db/e2e, 451 frontend. The ChatGPT Bridge was DROPPED by the user on 2026-10-15 (not planned, not built).

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
