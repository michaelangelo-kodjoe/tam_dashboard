# Changelog

All notable changes to the TAM Command Center rebuild. New work goes under **Unreleased** until a DEV release is cut. Nothing moves to a Production section until DEV validation explicitly passes (spec §50).

## 0.2.0-rc2 (2026-10-24) - Release packaged (deployment-agent, task D-2)
- Version bump to 0.2.0-rc2 (VERSION.txt, server DEFAULT_VERSION). Schema 3, channel prod in the archive, UNVALIDATED on Windows/Bloomberg. Archive TAM_Command_Center_0.2.0-rc2_win.zip not committed; the rc1 archive is untouched.
- Gate before build: 739 pytest (server db), 580 Vitest, tsc clean, sql_safety_scan 0; build:api left web/ unchanged. QA-W1..W4 PASS, 0 open Blocker/High.
- rc1 -> rc2 delta: Overview "Upgrades, Next 30 Days" panel (frontend, replaces server tiles), `upgrades_30d` API key, Operations 'default' target-version display removed, new purple token, removed server tiles (ServerTiles). Everything else is as rc1.
- Included in rc2: Overview panel (frontend-dev-agent, QA-W4) and the backend item below.

### rc2 backend - B-5/B-6 Overview 30-day timeline (backend-dev-agent)
- Fix: upgrades shown in Operations were missing from the Overview 30-day widget. New `upgrades_30d` key on the account infrastructure payload (`server/ops/effective.py`, built on `ops/derive.build_row`): Operations-effective upgrades (record override, else quarter date) dated today..today+30, not Completed/Deferred. Nothing is written.
- Scope narrowed (B-6): `server_upgrades`, `next_upgrade`, account counts and Today are unchanged (saved records only); no `not_in_bams`, no `derived` on Today items. Contract: `docs/04_API_CONTRACT.md` 13.1a.
- Tests: `server/tests/test_effective_upgrades.py` (5: seeded parity with Operations, saved-only baseline for the rest, no writes, labelling/edges, override/closed).

## 0.2.0-rc1 (2026-10-23) - Release packaged (deployment-agent, task D-1)
- Version bump to 0.2.0-rc1 (VERSION.txt, server DEFAULT_VERSION so /api/health reports it; QA-W1-5 closed). Schema 3. Channel prod in the archive. UNVALIDATED on Windows/Bloomberg.
- Gate before build: 734 pytest (server db), 575 Vitest; build:api left web/ unchanged. blpapi stays in the release requirements. Archive TAM_Command_Center_0.2.0-rc1_win.zip not committed.

## 0.2.0-rc1 (2026-10-23) - backend backport (backend-dev-agent, task B-2)
- Ported the workstation-zip backend: migration 0003 + schema.sql (schema_version stamp fixed to 3; `migrate.py --verify-schema` IDENTICAL), persistent BAMS alert policies (`sync_auto_policies`, `auto_apply`, `config_id`), `GET /api/bams/metrics/catalog`, `POST /api/bams/notifications/test`, Windows NotifyIcon notifier with async queue and truthful delivery log, monitor sync each poll, provider field `LAST_PRICE`, BAMS import changes (Polarity column K, only `Account` header required, metadata-only rows, explicit Region/Environment/Location overwrite, conflict detection, `policy_sync`), new template. Dropped as agreed: stray `server/portability/app.py` and `services.py`. Fixed a zip bug on the way: `configs_delete` crashed (`sqlite3.Row.get`) on every delete.
- Bloomberg Terminal BAMS workbooks (Client, Ticker, Region, Metric, DC Location) are now auto-detected and converted on `/api/import/bams/inspect` (`bams_terminal_adapter` wired in `bams_service._read`); template imports unchanged.
- BAMS state sparklines: one set-based statement per request instead of 24 queries per row (`reads.spark_many`), same output; parity test against the old algorithm.
- Rich notes: `body_format: "html"` on `/api/note/save`, strict allowlist sanitiser (`server/richtext.py`), no schema change (hidden storage marker in `notes.body`), `body_format`/`body_text` on reads, search on visible text, audit without bodies, export/restore round trip. `db/queries/activity_timeline.sql` gains `:q_like_html`.
- `blpapi>=3.25.10.1,<4` added to `server/requirements-release.txt` (shipped requirements.txt); header comments in `server/requirements.txt` and `tools/build_release.py` corrected.
- Contract: `docs/04_API_CONTRACT.md` section 17. Tests updated for schema v3, LAST_PRICE, Polarity, header rules; 80+ new tests (rich notes, policies, notifier, Terminal import, spark parity, migration 0003). Pre-existing failure, not from this port: `test_qa_e5_3_seeded_alert_mix_survives_polls` (DEV seed uses the wall clock while the test pins the BAMS clock to 2026-10-14; fails on the untouched tree too).

## 0.2.0-rc1 (2026-10-23) - frontend (frontend-dev-agent, task F-1)
- BAMS metric chart: drag-to-zoom (minimum 3 minutes, Esc cancels, double-click or Reset zoom restores, window label, finer ticks as you zoom); line colour by severity (normal below Warning, amber at Warning, red at Critical, from the metric's rule lines); 30/60/90d high lines and threshold lines removed (figures stay as text). Pure maths in `lib/chartZoom.ts`.
- Warning amber / Critical red everywhere in BAMS (status badges, row edges, KPI tile, bell, close-alert dialog); words always shown.
- Alert configuration: metric list grouped by account > appliance > metric with one master arrow (collapsed by default, remembered in localStorage) and the filter in the same row; metric-first persistent alert policies ported from the workstation build as React components (custom Metric combobox, no injected JS); starter templates sit behind "Show advanced templates".
- Done button on task popup (with notes editor) and on Today work-queue rows, shared Undo toast (`useCompleteTask`); BAMS search suggestions.
- Formatted notes: rich editor (size, bold, italic, underline, lists, clear) for Meeting/Call/General notes in the note drawer and Quick Capture, stored as `body_format: "html"`; timeline renders sanitised HTML as React elements (no innerHTML), plain notes unchanged. Task notes stay plain (API supports formatting on notes only).
- BAMS Settings page: grouped sections, 220px label column, footer bar; "Windows delivery is unverified" help text removed.
- Performance: stale-while-revalidate cache in `useQuery` (module-level, per data source, structural sharing, polling pauses when the tab is hidden, `cache:false` for edit forms and destructive previews, `keepPrevious` for BAMS filters); memoised sparklines.
- Dialogs and drawers: one sizing rule via `--overlay-w` (cap min(W, 100vw - 32px), height 100vh - 48px, body scrolls, full-screen under 640px); task popup 880, capture 760, drawers 720, BAMS metric drawer 1100.
- Tests: 543 passing in 46 files, `tsc --noEmit` clean; build:api output refreshed in `web/`.

## 0.2.0-rc1 (2026-10-23) - frontend F-2/F-3 (frontend-dev-agent)
- F-2: chart drag-zoom fetches the window (`GET /bams/metric/{id}/trend?from&to`), cached per window, instant client zoom meanwhile; 7-day cap, minimum about 2 sample intervals; 422, empty and thinned states.
- F-3: starter templates restored exactly as before (no "Show advanced templates" gate). List markers, indentation and nesting visible in the note editor and rendered notes (base.css reset had removed them). Text colour palette (Amber, Red, Green, Blue, Purple, Gray, White; Default clears) in the note toolbar; renderer shows palette colours via React elements only. QA-W1-1: toolbar Btn hoisted (no remount; focus persists; Enter/Space/arrows work). QA-W1-3: react-router-dom 7.18.4 (advisories cleared; remaining npm audit findings are dev tooling: vitest/vite/esbuild). QA-W1-4: account page children constrained (min-width/max-width) so the tab bar scrolls inside its own container.

## 0.2.0-rc1 (2026-10-23) - frontend F-4 (frontend-dev-agent)
- Note editor text colour now behaves like Word: with nothing selected, a chosen colour (or Default) applies only to text typed next (pending colour); with a selection only the selection changes. The toolbar shows an "A" with a colour bar that follows the colour of the character before the caret (aria-label "Text colour: <name>"). Default inside a coloured span splits it, so text is really uncoloured. Live normalisation of browser colour markup (font tags, rgb spans) to palette spans in `lib/richText.ts` (`normaliseColours`, `colourAt`, `selectionColour`); only palette colours are ever saved.

## 0.2.0-rc1 (2026-10-23) - frontend F-5 (frontend-dev-agent)
- Note editor A- / A+ now work like Word and like the colour palette: with a selection only the selection is resized; at a bare caret a pending size (stepped from the current value, 11..20 px) applies to the text typed next, and the px readout shows it immediately, then follows the caret or selection. No whole-body fallback for size or Clear formatting (Clear at a caret makes the next text plain). Size and colour combine on one span ("font-size: Npx; color:#HEX"); Default colour keeps a pending size.

## Unreleased - 0.2.0-rc2 frontend F-6 (frontend-dev-agent)
- Account Overview > Infrastructure panel: server tiles removed; summary line "N Servers · P PROD · D DEV" (no regions, no alerts text); "Upgrades, Next 30 Days" timeline from the new `upgrades_30d` payload key (contract 13.1a), one marker per (date, polarity), colour only (West accent, East info, DEV new `--purple` token, unknown PROD grey), tooltip and aria-label per marker, legend West/East/DEV on its own line, empty state "No Upgrades In The Next 30 Days"; close dates stagger. Title Case wording in this panel. Dead code removed (ServerTiles, TimelineTrack, timelineMarkers, their CSS and tests). Mock adapter derives `upgrades_30d` and PROD/DEV counts.

## Unreleased - Cleanup (post rc6, no behavior change)
- Removed only provably dead code (vulture/pyflakes/tsc --noUnused*, plus whole-repo grep): unused imports and locals in server/, unused functions `bams.lifecycle.preview_sentence` and `dupes.order_key`, unused frontend exports (CountStat, FieldRow, applianceLabel, isNoteType, nowInstant, types ImportField and SimilarChoice), and the stray backup docs/qa/OPEN_ITEMS.md-E. CSS, mockups, docs, migrations, web/ untouched. Rollback tag: rc6-working.

## Unreleased - Release 0.1.0-rc6 packaged (deployment-agent)
- Built from HEAD 1586b58 after QA gate 8 PASS and the QA-8-1 fix: 831 pytest + 496 Vitest passed, tsc clean; build:api left web/ unchanged. Schema 2 (db/migrations/0002_audit_prune.sql) shipped; first start migrates schema 1 to 2 (automatic pre-migration backup); older builds cannot open the upgraded database. Docs (START_HERE, README, USER_GUIDE, VALIDATION) describe the new features and the migration warning. UNVALIDATED on Windows/Bloomberg; zip not committed; rc1-rc5 untouched.

## Unreleased - Release 0.1.0-rc5 packaged (deployment-agent)
- Launcher split. `Launch_TAM_Command_Center.bat` is the daily entry and never installs (a failing env check says to run Install_and_Launch.bat once). `Install_and_Launch.bat` is first-time setup: it skips the install whenever the resolved Python imports fastapi, uvicorn, pydantic and openpyxl (`tools/install_stamp.py ensure`; a missing or different stamp is just rewritten), prints one line saying why it installs or not, offers a Desktop shortcut to Launch_TAM_Command_Center.bat (previously Install_and_Launch.bat), tells the user to use Launch from then on, and only starts the app if asked (default No). Install_Dependency.bat unchanged and standalone.
- Reinstall-every-run: not reproducible on macOS, so the true cause is UNCONFIRMED. Reading the old code: the old test needed an exact hash match of a stamp stored inside .venv (so any new requirements.txt, a recreated .venv, a failed stamp write or an unzip into a new folder forced a full pip run), imported only 3 of the 4 core packages, and the shortcut pointed at the installer so every daily start re-ran the check. Fix: the import test alone decides; stamp moved to `<app>/.install_stamp` and informational only; the shortcut points at Launch.
- Database choice: new stdlib `tools/choose_db.py` (same name rules as server/config.py, parity-tested): lists *.db names in %LOCALAPPDATA%\TAM_Command_Center, Enter or 10 s keeps last_database.txt, number picks, N creates (existing name refused unless OPEN typed); remembers the choice only after validation; honours a preset TAM_DB_NAME; banner shows the database; server exit 5 gets a TAM_PORT explanation. Never deletes/renames. Includes TAM_DB_NAME server support and contract section 16 (committed with this release) and the 413 body-drain fix. 29 new tests (server/tests/test_choose_db.py). Windows paths (msvcrt timed prompt, .bat flow) unrun; zip not committed.

## Unreleased - Release 0.1.0-rc4 packaged (deployment-agent)
- Fix: workstation pip failed (`No matching distribution found for pydantic==2.14.1`) because the Bloomberg internal mirror lags PyPI and the release requirements.txt pinned every package exactly. New `server/requirements-release.txt` (direct deps as ranges: openpyxl>=3.1,<4; fastapi>=0.115,<1; uvicorn>=0.30,<1; pydantic>=2.9,<3) is now the source of the shipped requirements.txt; `tools/build_release.py` refuses exact pins there. `server/requirements.txt` stays the audited exact-pin dev file. click and opentelemetry-api are not imported by the server; they are only transitive (uvicorn, fastapi) so pip handles them. Tested in scratch venvs (Py 3.10, 3.12): newest with pydantic<=2.14.0, oldest allowed (fastapi 0.115.0, pydantic 2.9.0, uvicorn 0.30.0, openpyxl 3.1.0): see VALIDATION. The pip-audit of exact pins no longer covers the installed set (stated in VALIDATION).
- `Install_Dependency.bat` pip failure now says to look for the ERROR line and send the full output, and mentions PIP_INDEX_URL / pip.ini / wheelhouse; START_HERE has the same note. Bats only statically linted. Zip not committed; rc1-rc3 untouched.
- Defect for PM: `tests/e2e/test_gate32_retest_e2e.py` (413 oversize-body cases) and `test_gate_run3_import_e2e.py::test_body_caps_only_upload_route_5mib` are flaky (httpx ReadError, connection reset) in a clean venv even with the exact pins; the project .venv passed 12 of 12. Likely client resets while the server answers 413 early on a large body.

## Unreleased - Release 0.1.0-rc3 packaged (deployment-agent)
- Added single entry point `Install_and_Launch.bat` + `START_HERE.txt` (5 lines) and `tools/install_stamp.py` (requirements hash stamp in .venv). Flow: refuse if not in an unzipped folder, find Python 3.10+ (reuses `_resolve_python.bat`), install via `Install_Dependency.bat` on first run or when requirements.txt changed, PROD env check (BLPAPI missing = clear note, app still starts, via the existing `--core-only` design), optional Desktop shortcut (once), launch via `Launch_TAM_Command_Center.bat` with the browser forced open (`TAM_OPEN_BROWSER=1`, small addition to `tools/open_when_ready.py`; the stored setting is still honoured otherwise). Old launchers kept. Update docs: data lives in %LOCALAPPDATA%, never in the app folder. build_release.py ships the new files; smoke test checks them. Bats only statically linted, never run on Windows. rc1/rc2 zips untouched; zip not committed.

## Unreleased - Release 0.1.0-rc2 packaged (deployment-agent, Phase 4.3)
- Fixed `tools/build_release.py`: it shipped only top-level `server/*.py`, so the archive could not start (missing server.importer/ops/bams/portability); now recursive, tests dirs excluded. Found by the smoke test.
- Built `dist/TAM_Command_Center_0.1.0-rc2_win.zip` (channel=prod, from HEAD ee5945d, fresh `build:api`): 711 pytest + 452 Vitest passed first; smoke test run. Added `docs/guides/USER_GUIDE.txt` (Operations, export, restore). README and VALIDATION updated; still UNVALIDATED (not tested on Windows or Bloomberg BLPAPI/TEAM/BSSO). The rc1 zip in dist/ was left untouched. Missing: CRM guide, screenshots. dist/ is gitignored; nothing committed.

## Unreleased - Run 6 T-175 schema confirmation and fixtures (data-architect)
- Confirmed, no schema change: audit vocabulary already covers restore events. Table-level restore = category `data`, object_type `import`, object_id = table name, action `restored`, source `Bulk Import`; post-database-restore = category `data`, object_type `backup` (or `system`/`schema`), action `restored`, source `System`. Explicit-id inserts (ids, created/updated timestamps, row_version) work for all 8 restored tables; insert fires no row_version/id guards; one-primary and unique guards reject clashes; parents-before-children needed with foreign_keys=ON (incl. quarter before upgrade record); rollback leaves nothing. `support_cases` has no UI/API, so it is not an export table.
- Added: `db/tests/test_portability_restore.py` (10 tests); fixtures `tests/fixtures/portability/` (generator `build_fixtures.py`; valid CSV per table, CSV variants, invalid CSVs incl. Unrecognized and missing-parent, xlsx valid DEV/PROD, newer schema, non-export). Column names follow SPEC 14 until contract section 14 exists.

## Unreleased - Run 7 planning (Legacy import)
- Added (docs only): `docs/01_PM_SPEC.md` section 15 (D-143..D-153, US-17.1..17.3, T-186..T-192): Inspect -> Preview -> Apply import of the old app's database (accounts, contact text, tasks, notes, BAMS appliances/metrics/rules/configs, settings); samples, alert events, notification log and legacy audit not imported; no alerts after import is a tested requirement. No code or schema change.

## Unreleased - Run 6 planning (Portability)
- Added (docs only): `docs/01_PM_SPEC.md` section 14 (D-122..D-135, E16 stories, T-174..T-183) and `docs/qa/PORTABILITY_MOCKUP_BRIEF.md`: Excel export (9 sheets), safe database copy, restore from Excel that only adds missing rows (preview, `pre-import` backup, one transaction), reusing the Run 3/4 import safety code. Amended: restore also accepts .csv (one table per file, table identified from headers or picked by the user, several files per session, D-135, US-16.7); wording is 'Restore from file'. In-app database restore (replace the live DB from an uploaded .db or a listed backup; staged verification, typed RESTORE, `pre-restore` backup, atomic swap with rollback, D-136..D-142, US-16.8..16.10, T-184/T-185) added by user decision; Reset all data stays out. No code or schema change.

## Unreleased - Run 5 Operations DEV seed (T-166)
- Changed: DEV mock seed (`db/seed_mock.py`, `db/mock_data.json`): PROD appliances now carry Region East/West (3 left on EMEA = "Set East or West"); 2 DEV appliances (NWH, KMC) added on an isolated RNG/id stream so no other seeded value moved; next quarter (2027 Q1) has no PROD West date; server_upgrades gain one date override (kmc-bpipe-hk-01, 2026 Q4) and one version override (brs-sapi-ny-01, 7.2.0-rc2). Existing quarters/status mix/overdue (BRS DEV In Progress) already covered. No schema change. 636 tests pass.

## Unreleased - Create a task from a note's action items (frontend)
- Added: after a note with Action items is saved (Note drawer or Quick Capture; new notes, or edits that changed the action items) a popup asks "Create a task from this action item?" with the item text and account; "Yes, create task" / "No" (No has focus, Escape = No). The note is already saved either way. Yes opens the normal new-task drawer for that account prefilled (title = the item, truncated at 500 with the full text in Notes; Notes "From note: <subject or type>, <date>"; usual defaults). Multi-line or bulleted action items are asked one by one ("Action item N of M", next prompt after the task drawer closes or No). Files: `lib/actionItems.ts`, `components/editors/ActionItemPrompt.tsx`, queue state in `store/UIContext.tsx`; `TaskDrawer` takes a `prefill`. Vitest 496.

## Unreleased - Audit log: Excel download removed (frontend)
- Removed: the "Download Excel" button in Settings > Audit log; "Download CSV" stays. `exportAudit(query)` is CSV-only in the DataSource, Api and Mock adapters; tests updated (Vitest 489). The server's xlsx format is untouched.

## Unreleased - Log downloads and audit retention line (frontend, contract 18.4/18.5)
- Added: Settings > Logging: "Download logs" (zip) and "Download current log" with a toast, a quiet "Older log files were omitted (size limit)" note when `X-Log-Files-Omitted` > 0, and "Log files older than 7 days are removed every week." `DownloadedFile.omitted`; DataSource `downloadLogs` (Api + Mock).
- Added: Settings > Audit log: "Entries older than 14 days are removed every 2 weeks. Last cleaned: <local time or Never>. Next: <local time>" from `retention` on `/api/audit` and facets (hidden when absent). Vitest 489. Verified live on a reseeded dev DB (schema 2): zip 200 `application/zip`, retention line, toast, no console errors.

## Unreleased - Workspace Overview: due-date histogram removed (frontend)
- Removed: the due-date histogram above Open tasks on the Account Workspace Overview tab, with `DueHistogram`, `dueHistogram`/`histogramSummary`/`HistBin`, its CSS and tests. The open-tasks table and counts are unchanged. The header load stack-bar, Next 15 days cells and servers dots stay. Vitest 486.

## Unreleased - Accounts page without bars; no "collapsed" hints (frontend)
- Removed: Accounts table "Notes" column and its sparkline (and the `getActivityTrend` adapter method, `ActivityTrend` type, mock trend buckets and tests; the backend route is untouched); the load stack-bar in the Load column (number kept) and the horizontal bars in the "Open load by account" tile (now name and count only).
- Removed: "Collapsed to keep this screen calm" (Today later tabs) and the hint text on the Settings Data / Audit log / Logging headers.
- Not removed (not bars, listed for review): the "Next 15 days" mini calendar cells with marks, the servers dot row, the Workspace header load stack-bar and due histogram (Account Workspace, not the Accounts page). Vitest 488.

## Unreleased - Audit log, notes-only Activity, backup kinds (frontend, contract section 18)
- Added: Settings > Audit log (collapsible, collapsed by default, loads only when opened; `?section=audit` opens it): read-only newest-first table (local am/pm time, account, category, object, action, source, summary), row expands to reason and before/after values, filters (search, category, object, action, source, account, date range) from `/api/audit/facets`, 50 per page with total and Previous/Next, Download CSV / Excel with the current filters (413 shows the narrow-filters message). `components/portability/AuditLog.tsx`; DataSource `getAudit`, `getAuditFacets`, `exportAudit` (Api + Mock).
- Changed: Account Activity is notes only: System filter, system rows and their CSS removed; empty text says notes; footer pointer "System changes are in Settings > Audit log" (`/settings?section=audit`). Accounts table column "Activity" is now "Notes" (counts notes). Mock matches (notes only, trend counts notes).
- Added: Settings > Data > Backups shows a Weekly / Safety / Manual badge per row and the retention note.
- Tests: `components/portability/AuditLog.test.tsx` (+5), Activity/mock tests updated; trend parity fixtures regenerated; 490 total. Verified live (fresh dev DB): Audit log, Activity, Backups, no console errors. Server left running.

## Unreleased - Local time, 12-hour default (frontend)
- Changed: every timestamp goes through one formatter in `lib/dates.ts` (`parseInstant`, `timeOfDay`, `formatTimestamp`, `formatClock`; `lib/bams.ts` `formatTime`/`formatStamp` delegate to it): server UTC instants (a zone-less string is treated as UTC) shown in the browser's LOCAL zone, 12-hour am/pm by default (`16 Oct 9:30 AM`), never GMT/UTC (the legacy `gmt` setting is ignored). Date-only values (due dates) are not converted. Also routed: top-bar clock, BAMS last poll/update/alerts, bell, trend chart ticks/tooltip, import result, backups list, note editor.
- Added: Settings > General "Time display": Local 12-hour (am/pm) default, Local 24-hour. Stored in the browser (`localStorage`) because the server `time_display` only accepts `local` | `gmt` (contract section 0, `server/constants.py`); persisting it server-side needs a backend change (e.g. allow `local12`/`local24`).
- Tests: `lib/time.test.ts` (+12, fixed TZs); 485 total.

## Unreleased - Confirm before completing a task (frontend)
- Added: "Mark complete" (Tasks page and Workspace Tasks tab) now asks "Complete this task?" with the task title and account; buttons "Yes, complete" and "No" (No has focus, Escape = No); only Yes saves. Editing Status in the Edit drawer is unchanged (deliberate Save). Today's detail pane and the read-only popup have no completion control, so nothing to confirm there.
- Added: the success toast has an Undo button (10 s) that reopens the task to its previous status with the new row_version (same save path as an edit; toast gains an optional `onAction`).
- Tests: the Mark complete test now covers No, Escape, Yes and Undo; 472 total.

## Unreleased - Read-only task popup and Today Notes (frontend)
- Changed: every place a task opens (Tasks page, Workspace Tasks tab, Today "Open task", Operations/others via `?task=<id>`) now shows a read-only popup first (`components/editors/TaskViewDialog.tsx`, existing Dialog: focus trap, Escape, focus return): title, account link, category, priority, status, due, next update, waiting on, created/updated and the full Notes with Terminal links and line breaks; buttons Edit and Close. Edit switches (replace) to `?task=<id>&edit=1`, the unchanged edit drawer; `?task=new` (and `edit=1`) open the form directly. Links inside rows still do not open the popup.
- Changed: Today detail pane section "Why it is here" is now "Notes": the task's notes (clickable links) or a quiet "No notes"; non-task items keep their reason text under Notes.
- Tests: `components/editors/TaskView.test.tsx` (+3), terminal-link tests adjusted; 471 total. Verified live: Tasks row -> popup -> Edit -> drawer, Today pane, no console errors.

## Unreleased - BAMS table grouped by account (frontend)
- Added: the BAMS metrics table collapses by account the same way as Operations: shared `components/ui/GroupToggle.tsx` (header chevron toggle-all, group row with chevron/aria-expanded, whole row toggles, Enter/Space) now used by both; `DataTable` gains an optional `grouping` prop; summary per account "12 appliances · 2 stale · 1 no data" (`lib/bamsGroups.ts`, no percentages). Default: only accounts with an active alert open; any quick view, search or filter auto-expands matches; choices remembered per session. Server sort order, KPI tiles, tabs, filters and row -> metric drawer unchanged. Appliance column and Current/Trend left as they were (user: screenshot arrows were not a request). Vitest 468.

## Unreleased - Bloomberg Terminal links and task notes on Today (frontend)
- Added: `{command}` text becomes a `bbg://screens/<encoded command>` link (visible braces and `<GO>` kept, `<GO>` stripped from the URI). Pure parser `lib/terminalLinks.ts`, `components/ui/TerminalLinkText.tsx` (React nodes only; stopPropagation on click, double-click and keys, navigation not prevented; focusable, visible focus, accessible name). Wired into `RichText` (account notes, Workspace/Activity note bodies and action items), Operations notes, the global/Workspace Tasks list (new Notes column), and Today. Edit controls keep raw text. Task titles stay plain (they sit inside links; nested links are not allowed).
- Added: Today detail pane shows the selected task's Notes; queue rows show a one-line notes preview (both with working links). The full edit stays in the drawer.
- Tests: `lib/terminalLinks.test.tsx` (+13); Vitest `testTimeout` raised to 20 s (slow machine under concurrent builds); 467 total.

## Unreleased - Active database name (frontend)
- Added: Settings > Runtime shows `Database: <name>` (from `runtime.db_name` / `/api/health` `db_name`; Api and Mock adapters; mock returns `tam_dev`) above the database file path. Not shown in the top bar (user decision). Vitest 454.

## Unreleased - ChatGPT Bridge dropped (frontend)
- Removed: the ChatGPT Bridge nav item, its placeholder page and `/bridge` route (now the normal not-found page), the unused `PlaceholderPage` and the rail "Later" tag code. Backend 501 stubs untouched. Spec D-21 is superseded for the Bridge. Vitest 452.

## Unreleased - Run 6 xlsx workbook entry (contract 14.3 amendment)
- Changed: an .xlsx is one file row with its sheets summarised (no table dropdown); Remove drops the workbook; skipped-row list shows the new `tab_or_linebreak` / `leading_trailing_space` texts. `RestoreFile.sheets` added (Api mapper defaults it). Vitest 451.

## Unreleased - Run 6 QA-7-2 and QA-7-4 (frontend)
- Fixed: restore result names the workbook/files once (UI and adapter de-duplicate, accept `file` or `files`). Settings > Data usable at 375 px (stacked actions, compact Backups table, wrapping dialog footers). Vitest 450.

## Unreleased - Run 6 portability UI (frontend)
- Added in Settings > Data: Export to Excel and Export database (downloads), Restore from file (one .xlsx or up to nine .csv; per-file table dropdown, Unrecognized / Missing columns states, remove file, CSV notice, New/Identical/Differs/Invalid per table, skipped-row list with outcome and table filters, "Add N missing rows", result with safety backup and skipped .xlsx/.csv download), Restore database (file chooser, and "Restore this backup" on every Backups row): file vs current counts with "fewer" highlight, red replace-everything warning, typed RESTORE, Restoring progress (polls health on 503/network), result with Reload app and 5 s auto-reload, failure states "Your data was not changed" / "Restored from safety backup <name>", graceful not-built message on 501.
- Added: `DataSource` portability methods (Api + Mock; mock restores CSV only and never mutates its tables), `portTypes.ts`, `lib/portability.ts`, `components/portability/`.
- Tests: +17 Vitest (components/portability/Portability.test.tsx, data/ApiPortability.test.ts); 448 total. Not exercised live: file uploads and the real restore paths (the running dev server predates backend phase 1 and still answers 501 on export).

## Unreleased - Settings collapsible sections
- Changed: Settings Data (Backups) and Logging (log level, recent log; formerly Diagnostics) are collapsible panels, collapsed by default, chevron button header with `aria-expanded`/`aria-controls`, open state remembered per browser session (`sessionStorage`), content loads only when opened. New `components/ui/CollapsiblePanel.tsx`; `DataSection` in `SettingsPage.tsx` is the drop-in container for the Run 6 portability UI (not built). Vitest updated (+1, 432 total).

## Unreleased - Run 5 Operations frontend polish
- Changed: Operations status is a colored badge button opening the status menu (Select gains optional `renderValue`; keyboard/ARIA unchanged). Header chevron toggles expand/collapse all; checkboxes and Select all appear only in selection mode ("Select" button).
- Added: Workspace Infrastructure tab link "Open in Operations" (`/operations?q=<account name>`, D-117). Enter in a text input submits the Operations dialogs (`pages/operations/enterSubmit.ts`).
- Items OPS-FE-1..3 in `docs/qa/OPEN_ITEMS.md`.

## Unreleased - Run 5 Operations frontend (T-171)
- Added: `/operations` page (replaces the placeholder; rail "Later" tag removed): quarter select with Edit/Add quarter and DEV/East/West date chips, summary line, filters (search, status, environment, polarity, Reset) in the URL, table grouped by account (collapsed by default, auto-expand on filter, Expand/Collapse all, tri-state account checkbox, Select all (N), selection bar), inline status, Set version dialog (skips named in the toast), row-edit dialog (date override, own version, note, Environment and East/West fixes through the BAMS appliance save, Reset to quarter), quarter dialog with Target version and delete (blocked message), empty states, `?quarter=2026-Q4&q=&status=&env=&pol=&appliance=` deep links, account name links to the Workspace.
- User changes applied: no right-aligned "Target version" in the page header (column and quarter-dialog field kept); the quarter version shows as the greyed "default X", an own version carries an accent marker.
- Added: `DataSource` methods `getOperations`, `saveOperationsQuarter`, `deleteOperationsQuarter`, `saveOperationsAppliance`, `resetOperationsAppliance`, `setOperationsVersion` (Api + Mock; `data/mock/mockOperations.ts`), `src/opsTypes.ts`, `src/lib/operations.ts`.
- Added: BAMS import preview and result show the `operations_note` line ("N appliances need East or West set for Operations"), informational only.
- Tests: +30 Vitest (lib, mock adapter, API adapter, page). Verified live on tam-app-dev: grouped table, select + Set version, edit + East save, no console errors. Known: `today.test.ts` parity fails after the data architect's in-progress `db/mock_data.json` extension (passes on the committed data).

## Unreleased - QA-8-1 migration failure is a clean refusal
- Fixed: `db/migrate.py` converts a raw `sqlite3.Error` during a migration into `MigrationError` (transaction rolled back, backup kept); `server/runtime.py` also catches `sqlite3.Error`; startup exits with code 4 and the plain "Database refused" message instead of a traceback with exit 1. Staged restore with a failing migration gives 422 `migration_failed`. Tests: `test_startup.py` (2), `test_dbrestore.py` (1), db migration test updated.

## Unreleased - Audit log retention (schema 2)
- Added: migration `0002_audit_prune.sql` (+ `db/schema.sql`): audit DELETE is refused only for rows newer than 14 days; UPDATE and id re-use stay refused. `server/auditprune.py`: every 14 days delete entries older than 14 days (first start only sets the cycle anchor; persisted in app_meta; one `pruned` audit event when N > 0; no safety backup, user accepted). `retention` meta in `GET /api/audit` and `/facets`. Schema version is now 2: DB tests, startup tests and the DB-restore older-schema test updated (real 0001 -> 0002 upgrade on the staged copy). Contract 18.5; `server/tests/test_audit_prune.py` (6) and `Schema2_AuditPrune` (5).

## Unreleased - Application log download and weekly cleanup
- Added: `GET /api/logs/download?file=zip|current` (current + rotated logs of the ACTIVE database's log folder only, no path parameters, 50 MiB cap, symlinks/sub-folders/other files ignored). Weekly log cleanup on the existing hourly scheduler: rotated logs older than 7 days deleted, folder cap 50 MiB oldest first, current file never deleted (rotated first when over 5 MiB), one summary log line. Audit log (`audit_events`) untouched by it. Contract 18.4; `server/tests/test_logs.py` (14).

## Unreleased - Activity notes-only, Audit log, weekly backups
- Changed: account Activity (and the Accounts activity-trend sparkline, PM-AC-2 parity) now hold manual notes only; `filter=system` returns nothing. `activity_timeline.sql` and `activity_trend.sql` lost their audit/alert branches. Today "Recently changed" is untouched.
- Added: `GET /api/audit` (filters, paging, summaries, account name), `/api/audit/facets`, `/api/audit/export` (csv/xlsx, formula-guarded, 50,000 cap). Read-only.
- Backups: one weekly automatic backup (start + hourly check, skipped for an empty DB), keep 8; safety backups keep 5 per reason and 30 days; manual and `pre-restore` never pruned; newest never pruned; `kind` on every backup item, list newest first. Replaces the old "keep 30 automatic" rule (D-22). Contract section 18; tests in `server/tests/test_audit_backups.py` (14), DA trend tests adjusted.

## Unreleased - BAMS freshness from last_received
- Fixed: Live/Delayed/Stale (and `age_seconds`, the dashboard "Last update" sort) now use `last_received` (last successful valid receipt) instead of the value-change time, so a stable metric no longer turns Stale while polls succeed. The monitor refreshes `last_received` on every successful observation, evaluates alert rules on unchanged values (consecutive-observation rules work), and writes `last_source_update`, `current_value` and the history sample only when the value changed. Failed polls never advance `last_received`. No schema change. 9 tests in `server/tests/test_bams_freshness.py`. Contract section 17.

## Unreleased - Database name (TAM_DB_NAME)
- Added: optional `TAM_DB_NAME` (validated bare name) chooses or creates the active database in PROD and DEV; default unchanged. Per-database lock, backups (`TAM_Backups/<name>/`), logs and restore staging for named databases; early plain port-in-use check (exit 5); `db_name` in `/api/state`, `/api/health` and the startup log. Contract section 16; `server/tests/test_dbname.py` (36). No frontend change needed (the name is in `runtime.db_name`; the Runtime panel may show it).

## Unreleased - 413 delivery fix (REL-1)
- Fixed: `BodyLimit` now discards the rest of an oversize body (bounded, never stored) before sending 413, so the response reliably reaches a client that is still uploading instead of a connection reset. Cap values unchanged. Test: `server/tests/test_bodylimit.py`.

## Unreleased - QA gate 7 fixes (QA-7-1..3)
- Fixed: from-backup staging no longer writes `-wal`/`-shm` beside the backup (immutable read-only open). xlsx restore lists the workbook once (`files[].sheets`), result file names deduplicated. A leading tab, line break or leading/trailing space in name-like columns gets specific skip reasons (`tab_or_linebreak`, `leading_trailing_space`) instead of `database_rule`. Contract section 14 amended; 3 tests.

## Unreleased - Run 6 portability phase 2 (T-184, T-185): restore database
- Added: `server/portability/dbrestore.py` and routes `POST /api/restore/database/inspect|from-backup|apply|{id}/cancel`, `GET /api/restore/database/{id}`. Staging in `<data>/restore_tmp` (500 MiB, 3x free disk, header/read-only/integrity/FK/channel/schema checks, guard-trigger check via the migration runner on the staged copy, older schema migrated on the copy only), typed `RESTORE` re-checked server-side, maintenance gate (503 `restoring` + Retry-After, in-flight drain, `/api/health` answers `restoring`), BAMS monitor stopped and restarted, `pre-restore` safety backup (never auto-pruned), WAL checkpoint, copy to `.restore-new`, rename live to `.pre-restore-old`, `os.replace` with 5 retries, verification, post-restore audit event, rollback to the renamed original or to the safety backup, startup recovery. The instance lock is untouched.
- Tests: `server/tests/test_dbrestore.py` (36 incl. parametrized fault injection at 9 swap steps).

## Unreleased - Run 6 portability phase 1 (T-174, T-176..T-179)
- Added: `server/portability/` (tables, export, readers, planner, restore, routes). `GET /api/export/excel` (About + 8 sheets, text-guarded, no formulas), `GET /api/export/database` (online backup to temp, integrity check, stream, delete temp), restore from file: `POST /api/restore/inspect|apply|{id}/remove|{id}/table`, `GET /api/restore/{id}` and `skipped.xlsx|csv` (.xlsx and .csv, New/Identical/Differs/Invalid, never overwrite, parents first, `pre-import` backup, one transaction, audit per table: data/import/restored/Bulk Import). 25 MiB upload cap on `/api/restore/inspect`.
- Contract `docs/04_API_CONTRACT.md` section 14 FINAL, including the database-restore routes (not built: still 501, T-184/T-185). Column headers equal DB column names (matches the T-175 fixtures). `data/reset` stays 501. No schema change.
- Tests: `server/tests/test_portability.py` (34), export -> restore round trips for xlsx and csv into an emptied DB.

## Unreleased - Rename carries Operations records
- Fixed: renaming a BAMS appliance now renames its `server_upgrades` records in the same transaction (audited); a collision with an existing record of the new name in the same quarter is refused with 409 (no merge). Import apply cannot rename. Contract 13.8; 3 tests.

## Unreleased - QA gate 6 fixes (QA-6-1..4)
- Fixed: QA-6-1 quarter `records` and the delete-block count ignore orphan records; confirmed delete removes orphans with audit. QA-6-3 seed records follow the quarter version (2 explicit overrides kept). QA-6-4 `# nosec B608` with reasons. QA-6-2 stale DEV DB deleted (reseeds on next start). Seed `mock_data.json` and Today parity fixtures regenerated.

## Unreleased - Run 5 Operations backend (T-164, T-165, T-167, T-168)
- Added: `server/ops/` (repo, derive, service, routes, schemas) and `GET /api/operations`, `POST /api/operations/quarter/save|delete`, `appliance/save|reset|set-version` (contract `docs/04_API_CONTRACT.md` section 13). Other `/api/operations/*` paths stay 501.
- Changed (user decision): the quarter's Target version applies automatically to every appliance in the quarter (derived on read); a per-appliance version wins; blank follows the quarter.
- Changed: BAMS import accepts `Polarity` as a Region alias, normalises East/West case, adds `operations_note` to inspect and apply results, template text and soft East/West list.
- Schema: no change (audit vocabulary, FK and triggers verified by tests). DEV seed extension (T-166) not done.
- Tests: `server/tests/test_operations.py` (17).

## Unreleased - Operations mockups (T-146)
- Added (mockups only, no app code): `mockups/operations/` index, 13 static pages, README with decisions to confirm, `operations.css`. Reflects user decisions: paste/upload only (Update schedule), user-typed source URL in Settings, Environment + Region (Region for Prod; Dev one date). Awaiting user approval.

## Unreleased - Operations mockups v2.1 (T-169)
- Changed (mockups only): `mockups/operations/01-operations.html` regrouped by collapsible account rows (tri-state checkbox, counts, status summary), per-appliance checkboxes, Select all, selection bar, greyed "default" version hint, search auto-expand frame; duplicate "Set East or West" removed; added `03b-set-version.html`; index/README updated. Quarter dialog already shows Target version.

## Unreleased - Run 5 mockup v2 feedback (Operations)
- Changed (docs only): software version is manual, Target version only, stored per appliance record (`server_upgrades.target_version`) with the quarter's version as default; checkbox multi-select with Set version bulk action; table grouped by account with Expand/Collapse all (default collapsed); Target version added to the quarter dialog. Spec section 13 and the mockup brief amended. No schema change.

## Unreleased - Run 5 scope reset (Operations)
- Changed (docs only): first Operations plan and mockups rejected by the user as too dense. `docs/01_PM_SPEC.md` section 13 replaced by a minimal plan: one Operations page over BAMS appliances, manual quarters (`quarterly_upgrade_windows`) and per-appliance overrides/status (`server_upgrades`), East/West stored in `bams_objects.region` via the existing BAMS import, no network/parse/sync/Diagnostics, no schema change. Old D-73..D-106 and T-133..T-163 void. New brief `docs/qa/OPERATIONS_MOCKUP_BRIEF.md`; old `mockups/operations/` files to be replaced.

## Unreleased - Run 5 planning (Operations) [superseded]
- Added (docs only): `docs/01_PM_SPEC.md` section 13 (decisions D-73..D-100, stories US-15.1..15.13, tasks T-133..T-162, user questions), `docs/qa/OPERATIONS_MOCKUP_BRIEF.md`. Amended with user answers: manual paste/upload only (no fetch, no `schedule/sync` route), user-entered source URL, Environment + Region columns and window inference (D-101..D-106, T-163), Q8 answered: single DEV date, no migration, Region PROD-only. No code or schema change yet. Mockup approval required before any UI build. `docs/HANDOFF.md` state refreshed (Run 4 done).

## Unreleased - BlpapiProvider
- Added: real read-only `BlpapiProvider` (lazy blpapi import, refdata PX_LAST snapshots in batches of 500, per-ticker invalid/no-value handling, ProviderUnavailable on start/terminate/Terminal-down, new session next poll). Response parsing isolated in `server/bams/blpapi_parse.py`. `tools/bloomberg_probe.py` for the workstation, `env_check.py` reports blpapi version and Terminal reachability. PROD unavailable message is now "BLPAPI is not installed ..." or "Bloomberg Terminal not reachable ..." (was a fixed stub text). Tested with a fake module only.

## Unreleased - QA-E5-3
- Fixed: DEV simulator no longer recovers seeded open BAMS alerts on first poll. Monitor steers SimulatedProvider values per metric from non-closed alert state (open stays breaching, recovered stays clear); event-less lower sibling rules are set suppress-until-clear. Lifecycle engine unchanged; PROD never simulates. Test added.

## [Unreleased] - 0.1.0-rc1

### Fixed

- QA-E5-1: BAMS import row with a valid account name but unknown BPID is Invalid (account_not_found); contract section 12 updated, test added. QA-E5-6: contract 12.4 audit reason allows "rows N, M". QA-E5-7: sha1 usedforsecurity=False; _CTRL regex uses \u escapes.

- QA-E5-4: BAMS trend chart x-axis ticks deduped (one per label). QA-E5-5: import step tabs wrap and columns legend scrolls/wraps at 375 px.

### Added

- 2026-10-14, pm-agent (Run 4, T-117, T-132): `docs/05_TRACEABILITY.md` section 7 added for US-14.1..16 and D-49..D-72 (PASS 46, FAIL 0, MISSING 0, DEFERRED 2: Windows toast). Re-ran pytest 606 and vitest 401, all green. PM ruling on QA-E5-1: unknown BPID with a valid name must be Invalid (backend-dev, Low). Windows, Bloomberg and toast remain untested.
- 2026-10-14, frontend-dev-agent (Run 4, T-114, T-115, T-127, T-128): BAMS UI built exactly to the approved `mockups/bams/01-13` (with the 2026-10-14 amendments) against contract sections 11 and 12. New dependency `recharts` (lazy-loaded chunk, only the metric drawer imports it). **Pages** (`pages/bams/`): `/bams` dashboard (monitor strip with Start/Stop, four KPIs, quick views, URL-synced filters/sort/search, 15 s refresh, SIMULATED badges, empty/no-match/PROD provider-unavailable states), metric drawer (`?open=<metric id>`: value, 30/60/90D highs with dates, Recharts trend with de-overlapped reference labels and a text equivalent, rules, alert history, Close), `/bams/alerts` (Needs action and Closed history, `?event=` highlight, Close dialog with still-breaching warning and note), `/bams/config` (rules per metric, one editor for Threshold / Percent of high / Historical high with live preview sentence, starter templates with preview then plan-hash apply), `/bams/settings`, Add/Edit appliance dialog (field errors from the backend, per-metric delete) and delete confirmation with exact counts and the blocked state, bell inbox in the top bar (unread count, mark read, links to the alert), and `/bams/import` steps 1-4 (template download, preview grouped by account and appliance with five row states, per-appliance Same/Different/Skip with nothing preselected and Apply gated, result, import_failed and expired states, Open BAMS with the touched accounts). **Elsewhere:** workspace Infrastructure tab now shows live status and alert counts per appliance with Open in BAMS; Today alert rows open `/bams/alerts?event=<id>` ("Open alert"); nav rail BAMS is live. All values show a % sign; rule type is "Percent of high"; no Unit field. **Data:** `DataSource` +27 BAMS methods, implemented by `ApiDataSource` and by the mock (`data/mock/mockBams.ts`, `mockBamsImport.ts`); `?data=mock&mockProvider=unavailable` shows the PROD no-data state in the mock. **Tests:** Vitest 326 -> 401 (BAMS formatting and rule sentences, import state, mock parity, API wire, 23 page tests). Verified in the browser pane against DEV (scratch DB, port 8793) and PROD (scratch profile, port 8794) at 1440, 1100 and 768 px; no JS errors. Deviations are listed in `TAM_PROJECT_STATE.md`.
- 2026-10-14, backend-dev-agent (Run 4, T-102..T-109 and T-123..T-125; no schema change): BAMS monitoring and BAMS import built against contract sections 11 and 12. `server/bams/`: provider interface (`SimulatedProvider` DEV only, `BlpapiProvider` stub always unavailable; chosen by MODE only, PROD never constructs the simulator and shows No Data under a banner), monitor loop (only caller of the provider; injectable clock; samples, incremental highs, daily prune of samples older than 100 days and highs recompute, no REPLACE SQL), pure lifecycle and freshness (open/recovered/closed, consecutive updates, cooldown, suppress-until-clear, freeze on stale/outage), read routes (state, metric detail, trend <= 500 points, alerts), write routes (close alert, monitor start/stop, settings, appliance/metric/rule/template CRUD with preview-then-apply, delete preview and pre-delete backup, notifications with a read watermark), `Notifier` interface (in-app log, DEV notifier, best-effort Windows PowerShell toast, privacy text; unverified on Windows), DEV-only `/api/dev/bams/*` (absent in PROD). Import: `server/importer/bams_*.py` reuses the Run 3 reader (now parameterised by a `FileSpec`), sessions, backups and `dupes.py`; per-account similar-appliance matching, exact keys and ticker conflicts, per-appliance decisions, atomic Apply with `import_failed`. The DEV 90-day history is generated by the SimulatedProvider backfill (seed counts untouched). Tests: `server/tests/test_bams_monitor.py` (30), `test_bams_import.py` (20), golden `fixtures/dupes_bams_golden.json`. All BAMS values are percentages (user decision); no unit field anywhere.

- 2026-10-14, backend-dev-agent T-100/T-120 (contract only, no code): `docs/04_API_CONTRACT.md` section 11 (BAMS monitoring, FINAL: state, metric detail/trend, alerts and Close, monitor, settings, appliance/metric/rule CRUD, starter templates with preview-then-apply, notifications, DEV-only routes) and section 12 (BAMS appliance+metrics import, FINAL, reuses section 10). The `/api/bams/*` 501 stub is removed from section 5. Flags for PM/FE: mockup 05 "Percent change" rule type and mockup 06 "Unit" field have no schema basis (contract uses `pct_of_high`, no unit); highs are dates only.
- 2026-10-14, data-architect T-101/T-122: **no schema change** for Run 4 or the BAMS import (docs/03_DATA_MODEL.md section 18). New fixture `db/fixtures/bams_import_rows.json` (18 import rows incl. near-duplicate appliances, ticker conflicts) and 3 tests `T122_BamsImportFixtures`; db suite 112 OK, `sql_safety_scan` 0 violations. The 90-day seed history in T-101 is not done.

- 2026-10-14, pm-agent (Run 4 planning; documents only, no code): first BAMS dashboard scoped in `docs/01_PM_SPEC.md` section 12 (D-49 to D-62, stories US-14.1 to US-14.10, tasks T-100 to T-117). DEV simulated provider only; PROD fails closed (stub provider, No data, never simulated); lifecycle open/recovered/closed with freeze on stale; in-app plus Windows desktop notifications with Privacy Mode; real BLPAPI and BAMS import deferred. Eight mockup screens required; the user must approve them before any UI build.
- 2026-10-13, frontend-dev-agent (Run 3, T-87 to T-91): account bulk import wizard (Choose file, Preview, Review duplicates, Result) and the Add account similar-account panel. Accepts `.xlsx` AND `.csv` (two template downloads, detected file type and CSV encoding/delimiter note, skipped-rows download in the upload's format). Strength shown as High/Medium/Low with reasons, no percentage; 'Unchanged' count; Products free text. Mock adapter parses CSV/xlsx without eval and matches the shared golden fixture; API adapter follows `docs/04_API_CONTRACT.md` section 10. Files: `frontend/src/components/import/`, `components/editors/SimilarAccountPanel.tsx`, `data/importFile.ts`, `data/mock/{dupes,mockImport}.ts`, `styles/import.css`. Removed stray test files `frontend/public/__imp/`.
- 2026-10-13, backend-dev-agent (Run 3 T-80..T-86, account bulk import + duplicate detection; no schema change): `server/importer/` (hardened reader for .xlsx AND .csv with content sniffing, UTF-8/BOM/Windows-1252, comma/semicolon; ZIP-bomb, XML-entity, macro, external-link checks; formulas never evaluated; 500-row cap; 5 MiB cap on the upload route only), template (xlsx/csv), Inspect/Preview (writes nothing), Apply (pre-import backup, one atomic transaction, one `Bulk Import` audit event per created/updated account, fill-blanks-only, 409 `unresolved_duplicates`/`preview_stale`/`already_applied`), skipped-rows download in the upload format, `server/dupes.py` shared engine and golden fixture, `POST /api/client/check-similar`, `client/save` 409 `possible_duplicate` unless `duplicates_confirmed:true`. `openpyxl==3.1.5` pinned and pip-audited. Contract: `docs/04_API_CONTRACT.md` section 10 FINAL.
- 2026-10-13, pm-agent (Run 3 planning; documents only, no code): the user approved the account bulk import mockups (`mockups/import/01..06`). Binding decisions D-37 to D-48 and section 11 in `docs/01_PM_SPEC.md` (stories US-13.1 to US-13.8, golden similarity table, test classes, tasks T-80 to T-95); proposed API in `docs/04_API_CONTRACT.md` section 10 (proposed by PM, to be finalized by backend in T-80); change requests PM-AC-4 to PM-AC-9 in `docs/qa/API_CHANGE_REQUEST.md`. Summary: core-field template generated with openpyxl (new pinned runtime dependency), .xlsx only with ZIP/XML/macro/external-link/formula safety and a 500-row cap, Inspect/Preview/Apply with nothing written before Apply, one atomic transaction after a `pre-import` safety backup, one `Bulk Import` audit event per created or updated account, liberal deterministic duplicate detection shared with the Add account dialog (reasons plus High/Medium/Low, no numeric score), fill-blanks-only merges, stale detection by `plan_hash` and `row_version`, downloadable skipped rows. No schema change. Out of scope: contacts/servers/tasks/notes import, CSV, remembering decisions, packaging.
- 2026-10-13, backend-dev-agent: "0 of 19" ring report investigated; **no runtime bug**. `Runtime.clock` returns a `date` (not a callable result of the wrong type), so `seed_mock.load(conn, data, self.clock())` in `server/runtime.py` and in the DEV reseed route (`server/services.py`) already pass the correct `today`. A server-auto-seeded DB and a CLI-seeded DB give the same `progress` (27 / 8 / 19 / 2). The reporting DEV DB (`dev_data/tam_dev.db`) was seeded on 2026-10-12 (`db.mock_seed.rebased_to` 2026-10-12) before the T-61 seed existed, and auto-seed only runs on a fresh DB, so it has no completed-today rows. Fix: delete `dev_data/tam_dev.db` or call `POST /api/dev/reseed`. Added regression tests (auto-seed and reseed route equal the CLI seed, 27/8/19/2) in `server/tests/test_run2.py`.
- 2026-10-13, frontend-dev-agent (Run 2, T-70 to T-75): Today "Triage Split" and the approved workspace and Accounts refresh, built to the mockups as amended by D-26 to D-36 and PM §10.5 (the spec wins where they differ). Not packaged or released.
  - **Today** (`pages/TodayPage.tsx`, `pages/today/`): summary chips (Top 10, six tiers, All; full counts; `?show=top|t1..t6|all`, default not written to the URL, unknown values fall back to `top`), a strict top-10 listbox (`aria-activedescendant`; Up/Down/Home/End, Enter opens, click selects, double-click opens, no wrap; works without focusing the list; chips own Left/Right), tier headings only under All, "Showing N of M" and "View all (M)", a detail pane (why-it-is-here sentence, key facts with null facts omitted, one Open link; no steps, next action or completion control), the "N of M tasks done" ring from `progress` (M = 0 shows "No tasks due today", N = M shows "All done", `done_other` only in the tooltip, refetch when the local date changes), and Upcoming / Recently changed / Account load as tabs under the list (collapsed by default, Account load capped at 8 rows plus "All accounts (N)"). The old right column and Panels are gone. Logic is pure and tested in `lib/triage.ts`.
  - **Instruments** (`components/ui/Instruments.tsx`, `lib/instruments.ts`, `styles/instruments.css`): StackBar/MeterLegend, Sparkline, DueHistogram, TimelineTrack, ProgressRing, SummaryChips, DotRow, Avatar, DatePill, ProximityTrack; static SVG/CSS with text equivalents, no gradients, no animation. Tokens added: `--surface-warning/-danger/-accent`, `--meter-h`, `--spark-h`, `--ring-size`, `--row-h-triage`, `--r-round` (`--hover-row` already existed).
  - **Workspace**: header band (Open tasks exclusive meter, Servers dot row with real per-server alert state, Alerts with the worst alert, Next upgrade and Next client touch with proximity tracks), "Top item for this account" (D-34, no steps), due histogram, server tiles with sparklines only where samples exist ("No trend data" otherwise, solid tint surfaces for alerting tiles), 30-day upgrade timeline with edge-pinned out-of-window markers, avatars in the context rail. The infrastructure query is lifted into `WorkspacePage` and shared with the header, Overview and Infrastructure tab.
  - **Accounts**: tile strip (Portfolio, Open load by account, Next 15 days) plus Needs attention (D-33 key, max 4, no score), and table columns Account, Load (bar), Overdue, Waiting, Alerts, Servers (dots), Next upgrade and Next contact (pills), Activity (14-day sparkline from `GET /api/accounts/activity-trend`). The Next 15 days upgrade markers, the servers dots and the attention signals are derived from the same `GET /api/today` queue (tier 5 is exactly T..T+14; alert and overdue-upgrade items carry the server name).
  - **Data**: `TodayData.progress`, `Infrastructure.servers` (tiles), `ActivityTrend`, `DataSource.getActivityTrend`. `MockDataSource` ports `day_progress.sql` and `activity_trend.sql` (injectable local-midnight function and clock) and builds server tiles by contract §9.3. `ApiDataSource` maps `progress`, `server_tiles` (the integer `servers` stays the count) and the trend endpoint; `progress` is `null` against a server that predates PM-AC-1.
  - **Tests**: Vitest 120 -> 191. Parity of progress and the 14-day trend against the reference SQL on three dates (`scripts/gen_today_parity.py` now also writes `run2_parity_<date>.json`; ranking fixtures regenerated, unchanged), progress edge cases (reopened, future/no due date, Inactive, archived, deleted, UTC+10 and a 25 h DST day, N <= M), tiles, triage/instrument derivations (every D-33 tie-break), component tests, adapter tests, new guards (no animation, keyframes, gradient, blur or shadow in the Run 2 files; no steps/next-action/"Mark complete" text in Today; the three tint tokens pinned to the 12% blend), and App integration tests for Today, workspace and Accounts.
- Found, not fixed (outside frontend scope): `server/runtime.py` auto-seeds a fresh DEV DB with `seed_mock.load(conn, data, self.clock())`, passing a clock where `load` expects a date, so the auto-seeded DEV DB has no done-today rows (ring shows 0 of 19) and instants are not rebased to today. Seeding the scratch DB with `db/seed_mock.py load` gives the documented 8 of 27.
- 2026-10-13, backend-dev-agent (Run 2, T-62 to T-64; PM-AC-1..3 done). Additive, no schema change; `docs/04_API_CONTRACT.md` §9 holds the shapes.
  - `GET /api/today` gains `progress {day,total,done,open,done_other}` (executes `day_progress.sql` unmodified; the two local midnights of the window are converted to UTC separately, DST-exact; `Runtime.tz` is injectable for tests).
  - New `GET /api/accounts/activity-trend?days=14[&include_inactive=true]` -> `{ok,today,days,series:{client_id:[14 ints, oldest first]}}` (`activity_trend.sql` unmodified; `days` other than 14 is a 422).
  - `GET /api/client/{id}/infrastructure` gains `server_tiles` (name, environment, version, alert_severity, spark) with a 7-day, at most 28-point sparkline from `bams_metric_samples` (one metric, one time range; null when no samples). Named `server_tiles` because `servers` is the frozen integer count.
  - New `server/localtime.py`, `server/trends.py`; 24 new tests in `server/tests/test_run2.py`. `pytest server db tests/e2e`: 323 passed; `sql_safety_scan.py`: 0 violations. No existing test needed changing (none pins the queue contents against the new seed row).
- 2026-10-13, data-architect-agent (Run 2, T-61): DB-layer support for the progress ring, activity trend and sparklines. **No schema change** (`docs/qa/SCHEMA_CHANGE_REQUEST.md` not needed).
  - New reference queries `db/queries/day_progress.sql` (D-29; `:today`, `:day_start_utc`, `:day_end_utc`; plan/done/open/done_other; `ix_audit_ts`) and `db/queries/activity_trend.sql` (14 daily points per account from the same union as `activity_timeline.sql`; 15 local-midnight UTC bounds so DST days are exact; `ix_notes_client_ts`, `ix_audit_client_ts`). `seed_mock.progress_params()` / `trend_params()` build the parameters.
  - Seed: `Gen.build_done_today()` adds 14 tasks and 36 audit rows with tasks completed today (08:30Z to 10:45Z) covering every §10.2 case (N = 8, M = 27, done_other = 2 on the seed), and `bams_metric_samples` now span 7 days (60 per sampled metric, 1440 rows; was 24 hourly). Own RNG stream, so every other seeded row is unchanged; `mock_data.json` regenerated, byte-identical on repeat. Verifier gains 14 checks; the "nothing in the future" check now allows the done-today rows (nothing after today 12:00Z).
  - Tests: 32 new in `db/tests/test_db_contract.py` (109 total), including reopened/inactive/archived/deleted edge cases, Tokyo local midnight, 23 h and 25 h New York DST days and parity with `activity_timeline.sql`.
  - Frontend `today_parity_*.json` fixtures regenerated from `today_queue.sql` (the reopened seed task is one new queue row, 117 rows).
  - `docs/03_DATA_MODEL.md` §17 documents all of it, with the hand-computed table.
- 2026-10-12, deployment-agent (Phase 4.3, T-42): Windows release scaffolding. NOT production-ready; nothing was run on Windows or against Bloomberg.
  - **Launchers** (CRLF, static-linted only): `Launch_TAM_Command_Center.bat` (PROD, 8765, clears test flags), `Launch_DEV_Preview.bat` (DEV, 8766, sets `TAM_DEV_MODE=1` and `TAM_BAMS_TEST_MODE=1`), `Install_Dependency.bat` (app-local `.venv`, optional `wheelhouse\` offline install), `Check_PROD_Environment.bat`, `Check_DEV_Environment.bat`, and the helper `tools/_resolve_python.bat` (TAM_PYTHON, `.venv`, `python`, `py -3`; 3.10+ required; an invalid TAM_PYTHON fails with no fallback).
  - **Helpers:** `tools/env_check.py` (read-only preflight: Python, modules, files, channel vs mode, flags, data folder, port, BLPAPI import; PROD fails closed without BLPAPI, `--core-only` is used by the PROD launcher because the BAMS monitor does not exist yet; DEV warns only) and `tools/open_when_ready.py` (honours the stored `open_browser_on_start` setting, reads the DB read-only).
  - **Build:** `tools/build_release.py` (zip with SHA-256 `BUILD_MANIFEST.txt`, refuses DBs/dev_data/.venv/node_modules/frontend/mock data in a prod archive, rewrites `VERSION.txt` to `channel=prod`, `--channel dev` makes a DEV-preview package with the seed data) and `tools/smoke_release.py` (unpack, fresh venv, boot PROD and DEV, assert no auto-seed in PROD), `tools/lint_bat.py` (static lint of the .bat files).
  - `README.txt`, `VALIDATION.txt` (honest: untested on Windows and Bloomberg, not production-ready, deferred phases 3-5).
- `VERSION.txt` is now `0.1.0-rc1` (channel dev in the source tree; the release archive rewrites it to prod).

### Changed
- 2026-10-13, pm-agent (Run 2 planning, T-60): the user approved the mockups in `mockups/` (Today direction C "Triage Split", account workspace, accounts). No code or mockup was changed; documents only.
  - `docs/01_PM_SPEC.md`: new binding decisions **D-26 to D-36** (Triage Split layout; strict top-10 default list with View all and chips; no steps / next-action field / Mark complete in the Today detail pane; the "done today N of M" ring defined as tasks only, live, `N <= M`, via `progress` on `GET /api/today`, no schema change; Upcoming / Recently changed / Account load as tabs; approved visual refresh limited to schema-free derived data; tier 1 upgrade ranking rule; Needs attention rule with no score; workspace "Top item" panel; mockups are illustrative; design amendments). New §10 with details, the derived-data rulings, the mockup deviation register, API additions (PM-AC-1 to PM-AC-3), acceptance criteria (US-3.6 to US-3.9, US-4.2, US-5.6) and Run 2 tasks T-60 to T-77 (no packaging tasks). D-04 clarified (no behaviour change).
  - `docs/02_DESIGN_GUIDELINES.md`: new §15 (panel types, grouped panels, inset tiles, instruments, tokens, calm checklist). The Run 1 rules "single continuous context rail" and "no card-in-card" are superseded (§2, §14 updated).
  - `docs/qa/API_CHANGE_REQUEST.md`: PM-AC-1 to PM-AC-3 (additive).
  - No `docs/qa/SCHEMA_CHANGE_REQUEST.md` was created: none of D-26 to D-36 requires a schema change.

### Fixed
- 2026-10-12, backend-dev-agent: requirements split. `server/requirements.txt` is now runtime-only (fastapi, uvicorn, pydantic and their pinned transitive deps; no optional uvicorn extras, no test/audit tools) and installs cleanly on Python 3.10-3.12 on Linux/macOS/Windows. New `server/requirements-dev.txt` (`-r requirements.txt` plus pytest, httpx, pip-audit, bandit and the optional extras; uvloop is skipped on win32 and websockets only on Python 3.11+). Audited pins unchanged; `exceptiongroup==1.3.1` added for Python < 3.11 (anyio dependency). `tools/build_release.py` docstring/header updated; its filter is kept as a guard. Verified on Python 3.10.14: fresh venv `pip install -r server/requirements.txt`, `pip check` clean, DEV server on a scratch DB answers `/api/state` 200, `pytest server db tests` 267 passed, `tools/smoke_release.py` PASS.

### Found (reported, not fixed; application logic untouched)
- `server/requirements.txt` pins `websockets==17.2` (Python 3.11+) and `uvloop` (no Windows wheels), so `pip install -r server/requirements.txt` fails on the supported minimum Python 3.10. The release requirements omit the optional uvicorn[standard] extras. FIXED by the requirements split above.
- A DEV preview cannot run from a prod-channel release by design (TAM_DEV_MODE is ignored there); DEV needs the `--channel dev` package.
- CRM and Operations guides and the Operations/Bulk Upload/BAMS screenshots required by spec section 56 do not exist yet (phases 3-5).

- 2026-10-12, frontend-dev-agent: QA-E2-3 fixed (top-bar + Capture now prefills the current account like the N key; two regression tests). T-1 fixed (`build:api` tree-shakes the mock adapter and `mock_data.json` out of `web/`).
- 2026-10-12, pm-agent (Phase 4.2): `docs/05_TRACEABILITY.md`, the requirements traceability matrix. 113 rows (mandatory checks, E1-E12 acceptance criteria, PM decisions) plus the section 52 summary: PASS 111, FAIL 0, MISSING 0, DEFERRED 2 (US-12.2, Phase 4.3). Verified by re-running `pytest server db tests` (239 passed), `tsc` and `vitest` (118 passed), and by driving the live DEV app on a scratch DB. Five Low observations (T-1 to T-5) are listed there. `TAM_PROJECT_STATE.md` validation table brought up to date.
- 2026-10-12, pm-agent (Phase 1.1): `docs/01_PM_SPEC.md`, covering epics E1-E12, user stories traced to spec sections, the Today ranking rules, screen layouts, component inventory, API contract list, task board T-01 to T-50, and the out-of-scope list for run 1 (spec phases 1-2).
- 2026-10-12, pm-agent (Phase 1.1): `docs/02_DESIGN_GUIDELINES.md`, covering colour, type, spacing and motion tokens with checked contrast ratios, button states, the custom Select and AccountPicker keyboard contracts, tables, the note vs system-event treatment, overlays and screen states.
- 2026-10-12, pm-agent: skeletons of `TAM_PROJECT_STATE.md` and `CHANGELOG.md`.
- 2026-10-12, data-architect-agent (Phase 1.2, T-01 to T-04):
  - `db/schema.sql`: schema v1 with all 16 §33 tables, enum CHECKs, NULL-safe date/instant CHECKs, partial indexes for Today, append-only audit triggers, and `application_id` 'TAMC'.
  - `db/migrations/0001_initial.sql` and `db/migrate.py`: reference runner. It takes a pre-migration online backup, is forward-only, and refuses newer or foreign DBs.
  - `db/queries/*.sql`: reference Today queue, Activity timeline, Recently Changed and account summary SQL.
  - `db/seed_mock.py` and `db/mock_data.json`: deterministic fixture rebased to today. It has 12 accounts, 166 tasks, 210 notes and 756 audit rows, and covers every Today tier.
  - `db/tests/test_db_contract.py`: 22 tests.
  - `docs/03_DATA_MODEL.md`.

- 2026-10-12, backend-dev-agent (Phase 2.1, T-10 to T-13):
  - **API contract:** `docs/04_API_CONTRACT.md` published first and frozen: routes, payloads, error codes, Today queue item shape.
  - **`server/` (FastAPI, loopback only):**
    - DEV/PROD modes, ports 8766/8765 and a build-channel guard.
    - Per-DB single-instance lock.
    - Rotating file logging. Browser-disconnect errors are logged as one debug line with no traceback.
    - Migration on start through `db/migrate.py` with a pre-migration online backup.
    - A new DEV DB is auto-seeded with the mock data.
  - **Routes:**
    - `/api/health`, `/api/state`, `/api/today`, `/api/client/{id}/activity` (keyset pagination), `/api/tasks`, `/api/client/{id}/infrastructure`, `/api/settings[/save]` and `/api/logs/recent`.
    - Client, contact, task and note CRUD, including task archive.
    - `/api/data/backup[s]`.
    - DEV-only `/api/dev/reseed`.
    - 501 stubs for operations, bams, export, import, data/reset, restore, context and chat.
  - **Rules implemented:** D-07, D-08, D-10, D-11, D-12, D-22, D-23 and D-24 (the last two through the unmodified `today_queue.sql`) and D-25.
  - **Tests:** `server/tests/` has 107 tests (`test_startup.py`, `test_writes.py`, `test_today.py`).

- 2026-10-12, frontend-dev-agent (Phases 2.2 and 2.3, T-20 to T-23): `frontend/` (React 18, TypeScript, Vite, `lucide-react`, `react-router-dom`; custom CSS only) with build output in `web/`.
  - **Design system:** `src/styles/tokens.css` (the only file with raw colours), buttons with every state, custom `Select` and `AccountPicker` combobox components, segmented control, tabs, sortable `DataTable` with sticky header and `aria-sort`, `Dialog` and `Drawer` (focus trap, Escape, focus return, scroll lock, "Discard changes?" guard), toasts, tooltips, badges, banners, skeleton rows and `RichText` (the single plain-text render path, D-16). A sandbox page at `/sandbox` renders every button state.
  - **Screens:** Today, Accounts, Account Workspace (Overview, Tasks, Activity, Infrastructure, Contacts, context rail, collapsible "Account brief" below 1100 px), global Tasks, Settings (general, runtime, backups, recent log), Operations/BAMS/Bridge placeholders, Quick Capture (Task, Client Follow-Up, Meeting/Call/General Note), account jump (`Ctrl+K`) and the `N` shortcut. Editors open from the URL (`?task=`, `?note=`, `?contact=`, `?account=`) so Back closes them and deep links work.
  - **Data layer:** one `DataSource` interface (`src/data/DataSource.ts`). `MockDataSource` (loads `db/mock_data.json` via `public/`, rebase rule with the exact BAMS offset and the frozen mock clock, Today ranking port with D-23 and D-24, CRUD, audit rows, D-07, D-08, `expected_row_version`, safety-backup records). `ApiDataSource` maps `docs/04_API_CONTRACT.md` to the domain types. A store (`DataProvider` + `useQuery`) refetches on every mutation, keeps earlier data when a refresh fails and flags it stale.
  - **Tests:** 113 Vitest tests (Select and AccountPicker keyboard matrices, Today parity with `db/queries/today_queue.sql` on three dates, rebase rules, mock CRUD and rules, adapter mapping, App integration for every in-scope [§52] UI flow, repository guards).
  - Scripts: `npm run dev|build|build:api|test|typecheck`; `scripts/gen_today_parity.py` regenerates the parity fixtures from the reference SQL; `.claude/launch.json` defines the dev and preview servers.
  - `docs/qa/API_CHANGE_REQUEST.md`: four additive, non-blocking requests (FE-AC-1 to FE-AC-4).

### Known gaps and deviations (frontend, 2026-10-12)
- `Select`: Escape on a **closed** select is not consumed (the guideline says it is a no-op that does not bubble), so an enclosing dialog or drawer still closes. Escape on an open select is consumed as specified.
- At 1440 px the account Tasks table (8 columns plus actions, beside the 320 px context rail) scrolls horizontally inside its container. This is allowed by spec §44 but is not ideal.
- `?note=<id>` deep links find the note by paging the Activity timeline (see FE-AC-1).
- The default build is the mock build: `web/mock_data.json` is copied into `web/`. Use `npm run build:api` for any release build.
- `ApiDataSource` was exercised by hand against the live DEV backend (Python 3.12) but there is no automated end-to-end suite yet (QA 3.2). The `?data=api` URL switch is lost on a full page reload.
- Not tested on Windows or on the Bloomberg workstation. Contrast ratios come from the token table in `02_DESIGN_GUIDELINES.md`; no automated contrast or axe scan was run.
- Recharts is not installed (D-19: no charts this run).

### Decisions (Phase 1.2)
- The PM's default answers to Q-1 to Q-5 are applied as recorded (see `docs/03_DATA_MODEL.md` §1).
- `audit_events.object_label` was added so Activity sentences survive deletes.
- `bams_objects.environment` was added for the §14 environment summary.
- JSON1 and STRICT are deliberately not used, for Windows CPython portability.

### Decisions
- Decisions D-01 to D-22 are recorded in `docs/01_PM_SPEC.md` §0. The main ones:
  - Clean version line `0.1.0-dev` / schema 1.
  - The full §33 schema exists from day one.
  - Activity merges notes with read-only system events derived from audit.
  - Six-tier Today ranking.
  - Spec §34 route names, with 501 stubs for later phases.
  - Every delete requires confirmation plus a safety backup.
  - DEV on port 8766, PROD on port 8765.

- 2026-10-12, pm-agent: **the user confirmed Q-1 to Q-5 (the defaults)**. D-01, D-04, D-07, D-08, D-12 and D-22 are now final.
- 2026-10-12, pm-agent: **D-11 revised.** The optimistic-concurrency request field is `expected_row_version` (integer, compared with the schema's `row_version`), replacing `expected_updated_at`.
- 2026-10-12, pm-agent: **D-23 (QA-1-12a).** When an open Client Follow-Up task's `due` equals the account's `next_contact`, Today and Upcoming show only the task and suppress the account-level follow-up item.
- 2026-10-12, pm-agent: **D-24 (QA-1-12b).** Exception upgrades always qualify for queue tier 5, whatever their date. Deferred upgrades stay out of the queue.
- 2026-10-12, pm-agent: **D-25 contracts.**
  - DB writes never use REPLACE in any spelling; upserts use `ON CONFLICT … DO UPDATE` only.
  - `channel` is a required argument on every DB open and migrate call.
  - The release must ship `db/schema.sql`, `db/migrations/` and `db/queries/`.

### Changed
- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_1` (REJECTED). `0001_initial.sql` was edited in place because v1 is unreleased.
  - **QA-1-1:** audit rows can no longer be rewritten by REPLACE (`trg_audit_events_no_replace`).
  - **QA-1-2:** `INSERT OR REPLACE` / `REPLACE INTO` are banned by contract (03 §2.1). Guard triggers block secondary-key REPLACE, and a codebase scan test enforces the ban.
  - **QA-1-3:** `row_version` is the D-11 token on 12 tables, with guard and auto-bump triggers. The `updated_at >= created_at` CHECK was removed.
  - **QA-1-4:** the persistent purge flag is removed. `migrate.purge_audit_events()` purges transactionally, and `assert_guards()` checks the guard triggers on every open.
  - **QA-1-5:** BAMS freshness fields now rebase to load time. The seed covers Live, Delayed, Stale and No Data.
  - **Lows:**
    - `closed_at >= recovered_at`
    - ad-hoc upgrade identity index
    - a rule with active alerts cannot be deleted
    - `notes.source` excludes System
    - no control characters in identity text
    - three unused indexes dropped; Recently Changed uses `ix_audit_ts`
    - Today: NULL dates sort last, alert `days_delta` is local, disabled monitoring is excluded
    - fictional release versions
    - seed guards moved into `load()`; reseed keeps settings
    - `db.channel` stamp and check
    - foreign `application_id` refused
  - Added `queries/object_history.sql`.
  - Tests: 22 → 47.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_2` (REJECTED). `0001_initial.sql` was edited in place because v1 is still unreleased.
  - **QA-2-1:** removed the INSERT-side secondary-key guards that broke `ON CONFLICT DO UPDATE` / `DO NOTHING` and `INSERT OR IGNORE`. The §25 re-import, notification insert-once and name/ticker upserts now work. Duplicate errors now always read `UNIQUE constraint failed: <table>...`.
  - **QA-2-2:**
    - Added BEFORE UPDATE guards on every secondary unique key and id immutability on 13 tables, which blocks `UPDATE OR REPLACE`.
    - Added `db/sql_safety_scan.py`: a whole-file, string-seam-aware scan for every REPLACE spelling, including ORM and DDL forms and `.mjs`/`.cjs`.
  - **QA-1-5:** added the frozen mock clock rule (`app_meta['bams.mock_clock']` plus `queries/metric_freshness.sql`). The verifier now uses real wall time.
  - **Lows:**
    - NULL-safe ad-hoc identity
    - explicit-bump and RETURNING contract
    - channel refusal checked before stamping, and `channel` is now required
    - trigger SQL compared, not just names
    - poller writes no longer bump `row_version`; alert close is status-conditional
    - deterministic Recently Changed tie-break
  - Tests: 47 → 63.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_3` (REJECTED) and the PM follow-ups.
  - **QA-3-1:** rebuilt `db/sql_safety_scan.py`:
    - a comment-aware lexer, so comment markers inside strings no longer hide code
    - root-anchored skips, so `server/web/`, nested `tests/` and `dist/`, and `.pyw`/`.pyi` files are scanned
    - new patterns for SQLAlchemy `text('OR REPLACE')`, peewee `on_conflict_replace` / `on_conflict('replace')` and pandas `if_exists='replace'`
  - **QA-3-2:** contextual patterns (no false hits on SQL `replace()`, `.replace("INTO"…)` or UI copy) and a `sql-safety: allow` per-line marker.
  - **QA-3-3:** PROD refuses a DB with `bams.mock_clock` present; `metric_freshness.sql` honours the mock clock only when `:channel='dev'`.
  - **QA-3-4:** `assert_guards` refuses undeclared extra triggers.
  - **PM D-23:** a Client Follow-Up task with `due == next_contact` suppresses the duplicate touch item in the queue and Upcoming, and gets the context "Next Client Touch".
  - **PM D-24:** Exception upgrades are tier 5 at any date; Deferred never enters the queue and shows in Upcoming only inside +15..+30.
  - New seed scenarios and verifier checks for D-23/D-24.
  - `03_DATA_MODEL.md` §1 now says D-11 uses `expected_row_version`.
  - Tests: 63 → 70.

- 2026-10-12, data-architect-agent: fixes for QA `SCHEMA_REVIEW_4` (REJECTED). Only the scanner and its tests changed.
  - **QA-4-1:** `REPLACE INTO` / `UPDATE OR REPLACE` now match placeholder table names (f-string, `%s`, `.format`, `${}`).
  - **QA-4-2:**
    - `AS alias`
    - peewee `replace()` / `replace_many()`
    - pandas dict-passed `if_exists`
    - BOM- and UTF-16-aware decoding
    - `.sh/.bash/.zsh/.ps1/.psm1/.bat/.cmd` are scanned
    - allow markers must carry a reason; `--list-allow` added
    - also sqlite-utils `replace=True` and Kysely `.orReplace()`
  - **QA-4-3:** `.sql` single-quoted data is no longer scanned. UI-copy false positives are accepted and documented (fail closed, reasoned marker).
  - Added a generated adversarial corpus: 572 banned cases, 44 ORM forms, 57 negatives.
  - Tests: 70 → 77.

### Removed
- Review-1 INSERT-side guards: `trg_clients_no_replace_name`, `trg_server_upgrades_no_replace_identity`, `trg_bams_objects_no_replace_name`, `trg_bams_metrics_no_replace_keys`, `trg_bams_alert_events_no_replace_active`, `trg_bams_alert_configs_no_replace_name`, `trg_bams_notification_log_no_replace` (QA-2-1). `trg_contacts_no_replace_primary` was renamed `trg_contacts_one_primary_on_insert`.
- `app_meta['maintenance.audit_purge_allowed']` (QA-1-4).
- Indexes `ix_tasks_waiting_next_update`, `ix_server_upgrades_open_date`, `ix_server_upgrades_validation`, `ix_bams_alert_events_active` (QA-1-10).

### Fixed
- 2026-10-12, backend-dev-agent (QA-E2-1, QA-E2-2):
  - **QA-E2-1:** a CORS-rejected preflight now returns a structured 400 `cors_rejected` JSON error, and responses answered by `CORSMiddleware` carry the security headers/CSP (new `PreflightGuard` ASGI middleware in `server/app.py`, outside CORS).
  - **QA-E2-2:** `GET /api/note/save|delete` 405 now sends `Allow: POST`.
  - Strict-xfail marks removed from `tests/e2e/test_gate32_retest_e2e.py`.
- 2026-10-12, backend-dev-agent (Phase 4.1):
  - **FE-AC-1:** `GET /api/note/{id}` returns `{"ok": true, "item": <Note>}`; unknown id is 404 `not_found`; `GET /api/note/save|delete` is 405.
  - **FE-AC-2:** activity note entries carry `client_id` and `created_at`.
  - **FE-AC-3:** `server_name` on activity system entries and `recent_changes` rows (BAMS object name for alerts, server name for upgrades, else null).
  - **FE-AC-4:** `next_upgrade: {date, server} | null` on every `infrastructure[client_id]` in `/api/state` and on the per-account infrastructure response. Same rule as `account_summary.sql`.
  - **QA-E1-2:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and a restrictive CSP (self-only scripts; inline styles allowed for React/Recharts) on every response. The built `web/` bundle loads and navigates with no CSP violations.
  - **QA-E1-3:** a known path with the wrong method returns 405 `method_not_allowed` with `Allow`. `HEAD /` works.
  - **QA-E1-4:** 2 MiB request-body cap (declared and chunked bodies) returns 413 `payload_too_large`.
  - **QA-E1-7 (part):** `server/requirements.txt` pinned to the venv versions. pip-audit: no known vulnerabilities (after upgrading the venv's pip 24.0 to 26.2.1). bandit on `server/` excluding tests: 0 High, 8 Medium (B608 on f-strings built from fixed fragments and allow-listed column names, false positives), 1 Low (B101 assert).
  - Tests: `server/tests/test_phase41.py` (11 new). `pytest server` 118, `pytest db` 77, e2e 44, scanner 0 violations. `docs/04_API_CONTRACT.md` updated.
- 2026-10-12, frontend-dev-agent (Phase 4.1):
  - **QA-E1-1:** `DEFAULT_SOURCE` is now `api`. `?data=mock` still selects the mock adapter for DEV/demo and is remembered for the tab session in `sessionStorage` (try/catch). A production build (`npm run build:api`, `VITE_DATA_SOURCE=api`) ignores `?data=mock` and does not ship `mock_data.json`. Regression test: `src/data/index.test.ts`.
  - **FE-AC-1..4 consumed in `ApiDataSource`** (backend routes and fields exist in `server/`; `docs/04_API_CONTRACT.md` did not yet document them when re-read): `GET /api/note/{id}` replaces the 12-page activity paging for `?note=` deep links (new `DataSource.getNote`), note activity entries use wire `client_id` and `created_at`, system entries and recent changes use wire `server_name`, and the infrastructure summary uses the server-computed `next_upgrade`. The client-side derivations were removed.
  - Verified against the live DEV backend on a scratch DB (Today, account workspace, note create/edit/delete, `?note=` deep link on a cold load, Quick Capture call note, primary contact switch): no console errors, no failed requests. Vitest 113 -> 118.
- none
- 2026-10-14, pm-agent (documents only, no code): user decision, BAMS appliance+metrics bulk import (xlsx/csv, duplicate detection) is IN Run 4. `docs/01_PM_SPEC.md` section 12.8 added (D-63 to D-72, US-14.11 to US-14.16, tasks T-120 to T-132, mockups 9-13); D-49, D-57, section 12.4 and open question 4 amended. Reuses the Run 3 import design. No schema change.

- T-169 (2026-10-14): Operations mockups v2 delivered in mockups/operations/ (replaced rejected v1): operations page + 1024 frame, quarter dialog, appliance edit, empty states, BAMS import additions. Awaiting user approval (gates T-171).
