# 05 Traceability Matrix: TAM Command Center, Run 1 (Spec Phases 1-2)

| | |
|---|---|
| Author | pm-agent (Phase 4.2), 2026-10-12 |
| Inputs | `docs/01_PM_SPEC.md` (E1-E12, section 9 coverage index), `docs/SPEC.md` section 52, `docs/04_API_CONTRACT.md`, `docs/qa/ERROR_LOG_1.md`, `docs/qa/OPEN_ITEMS.md` |
| Tree | `TAM_Command_Center/` as of 2026-10-12 22:30 (after Phase 4.1) |
| Status values | PASS, FAIL, MISSING, DEFERRED (out of scope for this run, or sequenced after 4.2, with the phase named) |

## 0. What I ran and observed myself (not taken from other agents' reports)

| Check | Result |
|---|---|
| `.venv/bin/python -m pytest server db tests -q` (from `TAM_Command_Center/`) | **239 passed** (118 server + 77 db + 44 e2e) |
| `npx tsc --noEmit` (frontend) | exit 0, no errors |
| `npx vitest run` (frontend) | 10 files, **118 passed** |
| `db/sql_safety_scan.py .` | 0 violations |
| Live app: `TAM_DEV_MODE=1 TAM_PORT=8771 python -m server` from a scratch copy of the tree, scratch DB `scratchpad/app/dev_data/tam_dev.db` | Started; `lsof` shows `127.0.0.1:8771 (LISTEN)` only. `/api/health` gives `mode=DEV, version=0.1.0-dev, schema_version=1` and the scratch DB path |
| Second process on the same DB (port 8772) | Refused: "Another TAM Command Center instance (PID 16904, port 8771) is using this database." |
| Server started without `TAM_DEV_MODE=1` | Refused: "A development build refuses to run in PROD mode ..." |
| Browser (Browser pane) on the live DEV server | `/` lands on `/today`. Network shows only `/api/state` and `/api/today` (no `mock_data.json`). `/settings?data=mock` still shows "Data source: Live API" and requests `/api/*` (mock is not selectable on this build) |
| Direct API writes (curl, Origin header set) | Meeting, Call and General notes each: create 200, edit 200, delete without `confirm` 409 `confirmation_required`, delete with `confirm` 200 with a `backup_created` `pre-delete` side effect. The backup file passes `PRAGMA integrity_check`. Deletions show in `activity?filter=system` as "General Note deleted: TR2". Filters `meeting`/`call`/`general` return only their note type |
| Misc API | `DELETE /api/health` 405; `Host: evil.com` 403; `POST /api/operations/x` 501 `not_implemented` (Phase 3); `GET /api/today` returns `queue` tiers 1-5 present and in non-decreasing order, 48 upcoming, 20 recent changes, 8 account-load rows sorted by overdue desc |

Evidence key: **BE** `TAM_Command_Center/server/tests/<file>::<test>`; **E2E** `TAM_Command_Center/tests/e2e/test_gate32_e2e.py::<test>`; **FE** `frontend/src/App.test.tsx` test titles (abbreviated); **DB** `db/tests/test_db_contract.py`; **OBS** my own observation listed above or noted in the row.

## 1. Mandatory items (spec sections 5, 6, 52 and user checklist)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| M-1 | Nav rail items exactly: Today, Accounts, Tasks, Operations, BAMS, ChatGPT Bridge, Settings (persistent left rail, icons) | PASS | OBS: live DOM `nav` links in order `/today /accounts /tasks /operations /bams /bridge /settings`, each with an icon. FE `nav rail: Today/Accounts/Tasks/Settings work; Operations/BAMS/Bridge show "Later" ...` |
| M-2 | Today is the landing page | PASS | OBS: loading `/` redirected to `/today`. Code `AppShell.tsx` line 57 `Navigate to /${settings.default_landing}`; default setting `today` (BE `test_writes::test_settings_roundtrip_validation_and_audit`). FE `lands on Today ...` |
| M-3 | No Journal destination | PASS | OBS: no "Journal" text in the rail or the Today page. FE `nav rail ... no Journal` asserts `queryByText(/journal/i)` null. `grep -i journal` over `frontend/src` and `server/` hits only SQLite `journal_mode` lines. History lives in Account Workspace, Activity tab |
| M-4 | No health score anywhere | PASS | OBS: Accounts columns are Account, Open tasks, Overdue, Waiting, BAMS alerts, Next upgrade, Next contact. Live `clients` table has no score column. FE `Accounts: Inactive filter ... columns have no health score`. `grep` for health score in code: none |
| M-5 | No Client Notice (Operations test "Client Notice absent") | PASS | `grep -i "client.?notice"` over the whole tree (code, schema, seed): 0 hits. OBS: live schema `quarterly_upgrade_windows` and `server_upgrades` have no notice column. (The Operations workbench itself is Phase 3; the absence holds in the shipped schema and UI.) |
| M-6 | Dark, Bloomberg-style visual direction (near-black bg, amber accent, line icons, restrained radii, no gradients) | PASS | OBS: body background `rgb(11,13,16)`, `color-scheme: dark`, active nav icon and label `rgb(250,154,40)` amber, inactive `rgb(154,163,176)` gray, amber indicator bar (`shell.css` `.rail__item.is-active::before`), lucide line icons, 0 native-white buttons of 2 on Today. Screenshot of Today and of the Quick Capture dialog taken. FE `guards.test.ts` `banned visual effects are not used (gradients, backdrop blur)` and `no raw colour values outside styles/tokens.css`. Contrast computed by me from `tokens.css`: text 16.0:1, muted 7.6:1, accent 9.0:1, danger 6.4:1 on `--bg` |
| M-7 | Custom dropdowns only (no raw `<select>`, no native popup) | PASS | OBS: 0 `<select>` elements on Today, Accounts, Settings, workspace and in the Quick Capture dialog; the dark custom listbox opened on the account jump (12 options) and Priority/Category are `role=combobox`. FE `guards.test.ts::no native <select>, no Tailwind classes, no dangerouslySetInnerHTML`. `components/ui/Select.test.tsx`, `AccountPicker.test.tsx` (keyboard matrix) |
| M-8 | No sales/CRM fields (revenue, pipeline, stage, deal, owner, ARR) | PASS | OBS: live `clients` columns are `id, name, status, bpid, products, contact, last_contact, next_contact, notes, row_version, created_at, updated_at`; no commercial columns in any of the 16 tables. `grep -i "revenue\|pipeline\|opportunit\|mrr\|arr\|lead_source\|deal_"` over `frontend/src`, `server/`, `db/schema.sql`: 0 hits. `support_cases` table exists but has no UI (D-02) |

## 2. User stories and acceptance criteria

### E1 Foundation and environment safety

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-1.1 AC1 | Binds 127.0.0.1 only, LAN refused | PASS | OBS `lsof` shows `127.0.0.1:8771`. BE `test_startup::test_real_servers_loopback_only_and_second_process_blocked`; E2E `test_loopback_bind`. No flag exposes LAN (`config.py`) |
| US-1.1 AC2 | `/api/health` returns ok, mode, version, schema_version, db_path | PASS | OBS curl `/api/health` (also returns `channel`). Contract section 0 |
| US-1.1 AC3 | CORS same-origin plus Vite origin only in DEV | PASS | BE `test_startup::test_cors_only_for_dev_origin_and_not_in_prod`, `test_host_and_origin_guards`; E2E `test_host_and_origin_guards`. OBS `Host: evil.com` 403 |
| US-1.2 AC1 | DEV and PROD DB paths isolated, startup asserts | PASS | `server/config.py` isolation assertions; BE `test_startup::test_prod_refuses_dev_db_and_dev_refuses_prod_db`; OBS health `db_path` under `dev_data/` |
| US-1.2 AC2 [§52] | DEV-channel build without `TAM_DEV_MODE=1` refuses PROD mode | PASS | OBS refused with the message above. BE `test_dev_channel_build_refuses_prod_mode_real_process`; E2E `test_dev_build_refuses_prod_mode` |
| US-1.2 AC3 | `/api/dev/*` absent in PROD | PASS | BE `test_dev_routes_absent_in_prod_present_in_dev`; E2E `test_prod_has_no_dev_routes` |
| US-1.2 AC4 | Persistent DEV badge in the top bar in DEV | PASS | OBS screenshot: amber "DEV" tag beside the clock and "+ Capture". FE `lands on Today, shows the DEV and Mock badges` |
| US-1.3 AC1 [§52] | Second process on the same DB fails fast naming PID and port | PASS | OBS message with PID 16904, port 8771. BE `test_second_lock_on_same_db_is_refused_with_pid_and_port`; E2E `test_second_instance_blocked` |
| US-1.4 AC1 | Fresh DB at current schema version, WAL, FK on | PASS | BE `test_startup::test_fresh_db_wal_fk_schema_version`; OBS health `schema_version: 1` |
| US-1.4 AC2 | Pre-migration online backup; failure aborts | PASS | BE `test_pre_migration_backup_then_migrate`, `test_pre_migration_backup_failure_aborts_migration` |
| US-1.4 AC3 | Migrating twice is a no-op | PASS | BE `test_restart_is_noop_no_backup_no_audit`; DB contract tests |
| US-1.5 AC1 | Every write writes one audit row with the listed fields | PASS | BE `test_writes::test_every_write_produces_exactly_one_audit_row`; OBS deletions produced `note.deleted` system entries |
| US-1.5 AC2 | Data write and audit row in one transaction | PASS | BE `test_audit_failure_rolls_back_the_data_write`, `test_audit_is_append_only_at_db_level` |
| US-1.6 AC1 [§52] | Delete note/task/contact/account creates a `pre-delete` backup first | PASS | OBS: 3 note deletes each returned `backup_created` and wrote a `*_pre-delete_v1.db` file; backup `integrity_check` = ok. E2E `test_destructive_actions_create_backup`; BE `test_delete_aborts_when_backup_fails`, `test_task_delete_backup_and_audit`, `test_contact_delete_backup_audit` |
| US-1.6 AC2 [§52] | Backup under WAL writes passes integrity_check and holds committed rows | PASS | BE `test_writes::test_backup_under_concurrent_wal_writes_passes_integrity_check`; E2E `test_backup_under_wal` |
| US-1.6 AC3 | No `shutil.copy` / file replace on a live DB | PASS | BE `test_writes::test_no_naive_file_copy_of_live_db`; `test_sql_safety_scan_clean_on_whole_tree` (I re-ran: 0 violations) |
| US-1.7 AC1 | Startup logs mode, version, DB path, schema, migration outcome | PASS | BE `test_startup_logs_mode_version_db_schema_migration`; OBS `/api/logs/recent` line "starting: mode=DEV channel=dev ... port=8771" shown in Settings |
| US-1.7 AC2 | Disconnect errors are one DEBUG line, no traceback | PASS | BE `test_disconnect_errors_are_one_debug_line_no_traceback`, `test_disconnect_in_route_does_not_log_error` |
| US-1.7 AC3 | `GET /api/logs/recent?limit=200` shown in Settings | PASS | BE `test_logs_recent_limit_validation`; OBS Settings "RECENT LOG" section populated |

### E2 Navigation shell and design system

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-2.1 AC1 | Active item amber icon, label and indicator bar; inactive muted gray | PASS | OBS computed colours (amber `rgb(250,154,40)` icon and label, gray `rgb(154,163,176)`); `shell.css` indicator rule |
| US-2.1 AC2 | No Journal item | PASS | See M-3 |
| US-2.1 AC3 | Operations/BAMS/Bridge show "Later" and open a placeholder | PASS | OBS "LATER" tags in the rail; FE nav rail test (not-built page) |
| US-2.1 AC4 | Below 1280px rail collapses to 56px icons with tooltips and `aria-label` | PASS | OBS at 1100px viewport: rail width 56px; link `aria-label`s "Operations (later release)" etc. `shell.css` `@media (max-width: 1279px)` |
| US-2.2 AC1 | No native white button or select popup on any screen | PASS | OBS 0 native `<select>`, 0 white buttons; guard test (M-7). Screens inspected: Today, Accounts, workspace, Quick Capture, Settings |
| US-2.2 AC2 | Every button has default, hover, active, disabled, focus-visible | PASS | `styles/ui.css` lines 9-36 define all five for primary/secondary/ghost/icon/danger; `/sandbox` page renders each state (`SandboxPage.tsx`). Code read; no pixel test |
| US-2.2 AC3 | Select passes keyboard matrix | PASS | `components/ui/Select.test.tsx` and `AccountPicker.test.tsx` (vitest, run by me: all green) |
| US-2.3 AC1 | Labels, `<table>` semantics, visible focus | PASS | FE `Workspace header counts, tabs ... arrow-key tab navigation`; `aria-sort` asserted in FE tests; `.btn:focus-visible` outline. Table semantics in OBS (`th`/`tbody tr`) |
| US-2.3 AC2 | Dialogs/drawers trap focus, Escape closes, focus returns | PASS | FE `dialogs trap focus: Tab cycles inside ...`, `N opens Quick Capture ... Escape closes a pristine dialog and focus returns`, `a dirty dialog asks "Discard changes?"` |
| US-2.3 AC3 | `prefers-reduced-motion` disables transitions | PASS | `styles/tokens.css` line 94, `base.css` line 54, `ui.css` line 296 (code read) |
| US-2.3 AC4 | Contrast at least 4.5:1 body, 3:1 large/UI; status not by colour alone | PASS | Contrast computed by me from `tokens.css`: lowest text token on lowest surface is danger 5.0:1 (on `--surface-3`), muted 6.0:1. Status rows carry text labels and icons (OBS Today screenshot) |
| US-2.4 AC1 | At 1024-1100px right columns move below primary content | PASS | OBS at 1100px: Today "Upcoming" panel sits below "Work queue". CSS breakpoints `pages.css` 1199 (Today) and 1099 (workspace). I did not test exactly 1024px or the collapsed brief in the browser (frontend-dev reports it) |
| US-2.4 AC2 | Tables scroll in their container; no page horizontal scroll at >= 768px | PASS | OBS at 1100px `scrollWidth <= innerWidth`; `ui.css` table container overflow rules |

### E3 Today

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-3.1 AC1 | Queue ranked by the section 3.1 tiers | PASS | BE `test_today.py::test_tier1_..` through `test_tier5_upgrade_actions_incl_d24`, `test_tier6_and_upcoming_horizon_boundaries`, `test_each_object_in_exactly_one_place`; OBS `/api/today` tiers 1-5 in order |
| US-3.1 AC2 | Row shows account, type, title, urgency, date + relative label, context | PASS | OBS Today screenshot (account, BAMS ALERT/TASK/UPGRADE, title, Critical/High, date and "18d overdue", context); E2E `test_today_ordering_and_shape` |
| US-3.1 AC3 [§52] | Overdue task before normal upcoming task | PASS | E2E `test_today_ordering_and_shape`; FE `overdue items come before upcoming tasks ...`; OBS tier 1 tasks listed before tier 2/6 |
| US-3.1 AC4 [§52] | Active BAMS alert appears as an actionable item | PASS | OBS two Critical `bams_alert` rows (tier 1) and four Warning/Info plus two recovered in tier 3; E2E `test_today_ordering_and_shape`; FE test above |
| US-3.1 AC5 [§52] | Upgrade within 14 days appears in queue | PASS | OBS tier 5 `server_upgrade` rows (e.g. 24 Oct); BE `test_tier5_upgrade_actions_incl_d24` |
| US-3.1 AC6 [§52] | Click or Enter navigates to the underlying object per section 4.2 | PASS | E2E `test_queue_click_through_targets_resolve`; FE `clicking a task row navigates ... Enter ... does the same`, `BAMS alert rows go to the Infrastructure tab with ?server=`, `a task with no account goes to /tasks?task=` |
| US-3.1 AC7 | Landing page honours the default-landing setting | PASS | `AppShell.tsx` line 57; BE settings round trip. No UI test that changes the setting and reloads `/` (code read) |
| US-3.2 AC1 | Upcoming grouped by date, tasks, touches and upgrades, excluding queue items | PASS | `TodayPage.tsx` `UpcomingList` groups by date; BE `test_tier6_and_upcoming_horizon_boundaries`, `test_each_object_in_exactly_one_place`; OBS 48 upcoming rows in the right column |
| US-3.3 AC1 | Recently Changed: latest 20 as sentences, no settings/backup events | PASS | BE `test_today.py::test_recent_changes_and_account_load`; OBS 20 rows |
| US-3.3 AC2 | Row click opens that account's Activity tab | PASS | `TodayPage.tsx` line 124 `accountPath(client_id,'activity')` (code read); frontend integration not separately tested (Low gap, no owner action) |
| US-3.4 AC1 | Account Load columns, sort overdue desc then open desc, max 8, "All accounts" link | PASS | OBS API returns 8 rows ordered 3,2,2,1,1,1,0,0 overdue; "All accounts" link in `TodayPage.tsx` line 199; BE `test_recent_changes_and_account_load` |
| US-3.4 AC2 | Row opens account Overview | PASS | `rowHref={accountPath(client_id)}` (`TodayPage.tsx` line 200); FE `Ctrl+K ...`/row tests cover the same `DataTable` navigation |
| US-3.4 AC3 | Visually subordinate (smaller heading, lower position) | PASS | OBS Today screenshot: panel below the queue; `load-panel` class |
| US-3.5 | Refresh on the auto-refresh setting and after mutations | PASS | `AppShell.tsx` lines 80-84 (`refreshMs` from `auto_refresh_minutes`); FE `+ Capture button saves a task ... and refreshes Today`. The timer itself has no automated test (code read) |

### E4 Accounts directory

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-4.1 AC1 | Columns and tabular right-aligned numbers | PASS | OBS table headers: Account, Open tasks, Overdue, Waiting, BAMS alerts, Next upgrade, Next contact (plus an action column); `.num { tabular-nums }` in `base.css` |
| US-4.1 AC2 | No health score, no commercial fields | PASS | See M-4, M-8 |
| US-4.1 AC3 | Search by name/BPID; Active default / Inactive / All filter | PASS | FE `Accounts: dense sortable table; default Active filter ...; search by BPID`, `Accounts: Inactive filter lists the 2 inactive accounts` |
| US-4.1 AC4 [§52] | Clicking a row opens the Workspace Overview | PASS | OBS: clicked first row link, landed on `/accounts/<id>/overview` with tabs Overview/Tasks/Activity/Infrastructure/Contacts; FE accounts test |
| US-4.1 AC5 | "+ Account" editor (unique name, BPID, products, status, next contact, notes) | PASS | FE `Edit account drawer saves ...`; BE `test_writes::test_client_create_audit_and_validation`, `test_client_name_unique_case_insensitive_including_non_ascii` |

### E5 Account Workspace header and Overview

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-5.1 AC1 | Header counts, Servers = distinct server names | PASS | OBS Halvorsen header "OPEN 12 OVERDUE 3 WAITING 4 SERVERS 3 ALERTS 1 UPGRADES 3"; BE `test_today::test_seeded_state_bundle` and `test_seeded_infrastructure_endpoint` (`inf["servers"] == counts["servers"]`); `MockDataSource.test.ts` account summaries |
| US-5.1 AC2 | Counts are labelled plain text, danger/warning colour when > 0 | PASS | OBS screenshot (single line of labelled numbers, no badges); FE `Workspace header counts ...` |
| US-5.1 AC3 | "Edit account" drawer with danger zone | PASS | OBS "Edit account" button; FE `Edit account drawer saves; the danger zone requires typing the exact name (D-12)` |
| US-5.2 | Tabs Overview, Tasks, Activity, Infrastructure, Contacts, icons, URL-synced | PASS | OBS tab list and URL `/accounts/<id>/overview`; FE `tabs synced to the URL, arrow-key tab navigation` |
| US-5.3 AC1 [§52] | Up to 8 open tasks, overdue first, then priority, then due | PASS | FE `Overview shows up to 8 open tasks sorted overdue first, then priority, then due (US-5.3)`; OBS Overview open-tasks list with "18d overdue" first |
| US-5.3 AC2 | Row click opens task drawer; hover chevron; "View all (n)" | PASS | OBS "View all (12)"; FE `clicking a task row navigates to the task and opens its drawer` |
| US-5.4 | 10 recent Activity entries, notes vs system distinct, "View all" | PASS | OBS screenshot: "RECENT ACTIVITY" with SYSTEM rows and a General note card, "View all"; FE Activity test |
| US-5.5 | Continuous context rail: Next Client Touch, Infrastructure Snapshot, Contacts (mailto), Account details | PASS | OBS screenshot: all four sections on one surface; `mailto:` in `ContextRail.tsx`; "Set date" action present |

### E6 Tasks

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-6.1 AC1 [§52] | Account Tasks tab shows only that account's tasks | PASS | E2E `test_tasks_filter_to_account`, `test_account_counts_match_tasks`; BE `test_tasks_query_filters_account_only_archived_unassigned`; FE `Tasks tab lists only this account's tasks ...` |
| US-6.1 AC2 | Columns Task, Category, Priority, Due, Next Update, Status, Waiting On, Updated | PASS | FE `... offers every column` |
| US-6.1 AC3 | Filters (status default Open, priority, category, search, Show archived), sortable | PASS | `components/tasks/TaskList.tsx` ("Show archived"); `aria-sort` in FE tests; BE `test_tasks_query_filters_...` |
| US-6.1 AC4 | Inline "Mark complete" on hover/focus | PASS | FE `Mark complete is available per row and updates the counts` |
| US-6.2 AC1 | Task drawer fields, limits, defaults | PASS | BE `test_task_defaults_validation_and_unassigned`; `TaskDrawer.tsx` |
| US-6.2 AC2 | Non-blocking hint when Waiting with empty Waiting On | PASS | `TaskDrawer.tsx` line 138 `waitingHint` (code read; no dedicated test, Low) |
| US-6.2 AC3 | Saves audited, completion surfaces as system event | PASS | BE `test_task_lifecycle_audit_actions` |
| US-6.3 | Archive / unarchive audited, hidden unless toggled | PASS | BE `test_task_lifecycle_audit_actions`, `test_tasks_query_filters_...archived`; `TaskDrawer.tsx` Archive/ArchiveRestore |
| US-6.4 | Delete after confirm + safety backup, audited | PASS | BE `test_task_delete_backup_and_audit`; E2E `test_destructive_actions_create_backup` |
| US-6.5 | Global Tasks page with Account column, account filter, "No account" | PASS | `TasksPage.tsx`/`TaskList.tsx`; FE `a task with no account goes to /tasks?task=`; BE unassigned tasks test |

### E7 Activity and notes

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-7.1 | Merged timeline newest first, 50 per page, Load more | PASS | BE `test_writes::test_activity_filters_search_and_pagination`; E2E `test_activity_filters_and_system_distinct` (no duplicates, newest first); `ActivityTab.tsx` Load more |
| US-7.2 AC1 [§52] | Each filter returns only its type; System = derived only | PASS | OBS `filter=meeting/call/general` returned only the matching note type; `filter=system` only `kind: system`; E2E `test_activity_filters_and_system_distinct` |
| US-7.3 AC1 [§52] | Meeting Note create, edit, delete | PASS | OBS curl create 200, edit 200, delete 409 then 200; E2E `test_note_crud[Meeting Note]`; FE `Activity: "+ Note" menu opens a new note drawer; saving it adds the note; delete uses a confirm dialog` |
| US-7.3 AC2 [§52] | Call Note create, edit, delete | PASS | OBS as above; E2E `test_note_crud[Call Note]` |
| US-7.3 AC3 [§52] | General Note create, edit, delete | PASS | OBS as above; E2E `test_note_crud[General Note]` |
| US-7.3 AC4 | Fields and limits; Source read-only `GUI` | PASS | BE `test_note_validation_and_no_forged_source`; E2E `test_note_validation` |
| US-7.3 AC5 | Delete needs confirm, backup, audit; appears as system event | PASS | OBS: 409 without confirm; backup file; system entry "General Note deleted: TR2" |
| US-7.4 AC1 [§52] | System events distinct, compact, read-only, no edit route | PASS | FE `Activity tab: filters, system events have no edit/delete controls, notes do (US-7.4)`; E2E `test_activity_filters_and_system_distinct`; OBS screenshot SYSTEM rows vs note card |

### E8 Contacts

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-8.1 | Contacts table, drawer CRUD | PASS | `ContactsTab.tsx`, `ContactDrawer.tsx`; BE `test_contact_validation_and_immutable_client`, `test_contact_delete_backup_audit` |
| US-8.2 AC1 [§52] | New primary clears old in one transaction; toast; DB enforces one | PASS | E2E `test_contact_primary`; BE `test_primary_switch_is_atomic_and_audited`; FE `Contacts: making another contact primary clears the old one and confirms with a toast (US-8.2)`; DB partial unique index tests |
| US-8.2 AC2 | Zero primaries allowed | PASS | BE `test_create_primary_displaces_old_and_zero_primary_allowed` |
| US-8.2 AC3 | Contact changes appear as system events | PASS | BE `test_every_write_produces_exactly_one_audit_row`; activity sentence generation `server/sentences.py` |

### E9 Infrastructure (read-only)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-9.1 AC1 [§52] | Seeded BAMS objects and upgrade records listed | PASS | E2E `test_infrastructure`; BE `test_seeded_infrastructure_endpoint`; FE `Infrastructure tab: read-only notice, BAMS and upgrade tables ...`; OBS context rail shows Servers 3, Active alerts 1, Next upgrade 24 Oct |
| US-9.1 AC2 | Read-only notice, no create/edit controls | PASS | FE test above |
| US-9.1 AC3 | `?server=<name>` highlights and scrolls | PASS | FE test above; `InfrastructureTab.tsx` `scrollIntoView`; ERROR_LOG_1 browser check |

### E10 Quick Capture and search

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-10.1 AC1 | Type control: Task, Client follow-up, Meeting, Call, General note | PASS | OBS dialog radios: Task, Client follow-up, Meeting note, Call note, General note |
| US-10.1 AC2 | Account picker first, pre-filled inside a workspace | PASS | OBS: opened with `N` inside Halvorsen workspace, account combobox showed "Halvorsen Fjord Asset Management" |
| US-10.1 AC3 | Per-type fields; Client Follow-Up checkbox | PASS | OBS Task fields (Task, Due + Today/Tomorrow/+1 week, Priority, Category); FE `Client follow-up requires an account and a due date, prefills the title, and offers the next-touch checkbox` |
| US-10.1 AC4 | Ctrl+Enter saves, toast with View, page refreshes | PASS | FE `+ Capture button saves a task with Ctrl+Enter, toasts with a View link, and refreshes Today` |
| US-10.1 AC5 | Account required for notes/follow-up, optional for Task | PASS | FE follow-up test; BE `test_note_validation...`, `test_task_defaults_validation_and_unassigned` |
| US-10.2 AC1 | Ctrl+K account jump with type-ahead; Enter opens Overview | PASS | OBS jump list with 12 accounts and BPIDs; FE `Ctrl+K focuses the account jump; typing + Enter opens that account Overview (US-10.2)` |
| US-10.3 AC1 | Account names outside the workspace link to it | PASS | OBS Today rows show account links; `TodayPage.tsx`, `TaskList.tsx` |

### E11 Settings and backup

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-11.1 AC1 | Settings: landing, time display, auto-refresh, log level, open-browser; saved and audited | PASS | OBS Settings page shows all five; BE `test_settings_roundtrip_validation_and_audit` (3 audit rows); `test_log_level_setting_applied`; FE `Settings: changing a setting saves it ...` |
| US-11.1 AC2 | No BAMS cadence/notification/privacy/start-with-Windows settings | PASS | OBS Settings page content contains none of them |
| US-11.2 | Read-only runtime panel | PASS | OBS RUNTIME section: Mode DEV, Data source Live API, Version, Schema, Database, Backup folder |
| US-11.3 | Create backup now, list of 20, log viewer | PASS | BE `test_manual_backup_listing_and_integrity`; OBS "Create backup now", empty list message, RECENT LOG |

### E12 Process and release

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| US-12.1 | `TAM_PROJECT_STATE.md` and `CHANGELOG.md` kept current | PASS | Both files updated 22:30 and again by this pass. Low drift found and corrected in this pass: the Validation table still said 3.2 "not run" and 1.3 pending |
| US-12.2 AC1 [§52] | Release archive has no `*.db`, `-wal`, `-shm` or `dev_data/` | DEFERRED | Phase 4.3 (deployment-agent) builds the archive after this gate; no release folder or zip exists yet. Prerequisites verified in source: `db/schema.sql`, `db/migrations/`, `db/queries/` exist (D-25c); `dev_data/` is created only at runtime. Must be re-checked by the 4.3 smoke test |
| US-12.2 AC2 | Windows behaviour flagged untested | DEFERRED | Phase 4.3 / user (spec section 56). Flagged "untested on Windows" in `TAM_PROJECT_STATE.md`; `msvcrt.locking` and `%LOCALAPPDATA%` unexercised |

## 3. PM decisions that carry testable behaviour

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| D-07 | Client Follow-Up task sets `next_contact` when earlier or empty | PASS | BE `test_d07_follow_up_sets_next_contact_only_when_earlier_or_empty`; E2E `test_d07_d08_rules` |
| D-08 | Meeting/Call note advances `last_contact`; General does not | PASS | BE `test_d08_last_contact_only_for_meeting_and_call`; E2E `test_note_crud` (affects_last param) |
| D-10 | Delete needs `confirm: true`, backup first | PASS | OBS 409 `confirmation_required` then 200 with backup; BE `test_delete_aborts_when_backup_fails` |
| D-11 | `expected_row_version` stale write returns 409 | PASS | BE `test_stale_write_409_and_missing_404`, `test_row_version_bumped_explicitly_exactly_one` |
| D-23 | Follow-up task suppresses duplicate account touch | PASS | BE `test_d23_follow_up_task_suppresses_account_touch`, `test_d23_also_applies_to_upcoming_panel`; FE `today.test.ts` parity |
| D-24 | Exception upgrades always tier 5; Deferred never | PASS | BE `test_tier5_upgrade_actions_incl_d24` |
| D-25 | No REPLACE, `channel` required on every DB open | PASS | BE `test_sql_safety_scan_clean_on_whole_tree`, `test_every_db_open_passes_channel`, `test_open_db_requires_channel`; I re-ran the scanner: 0 violations |

## 4. Section 52 acceptance tests

In scope for Run 1 (17): every [§52] row in section 2 above. Summary by §52 heading:

| §52 test | Status | Row |
|---|---|---|
| Today: overdue before upcoming | PASS | US-3.1 AC3 |
| Today: active BAMS alert actionable | PASS | US-3.1 AC4 |
| Today: near-term upgrade in queue | PASS | US-3.1 AC5 |
| Today: click navigates | PASS | US-3.1 AC6 |
| Workspace: opens from Accounts | PASS | US-4.1 AC4 |
| Overview top open tasks | PASS | US-5.3 AC1 |
| Tasks tab filters to account | PASS | US-6.1 AC1 |
| Meeting / Call / General note CRUD | PASS | US-7.3 AC1-3 |
| Activity filters | PASS | US-7.2 AC1 |
| System events distinct | PASS | US-7.4 AC1 |
| Primary contact behaviour | PASS | US-8.2 AC1 |
| Infrastructure shows BAMS and upgrades | PASS | US-9.1 AC1 |
| Safety: DEV cannot open PROD | PASS | US-1.2 AC2 |
| Safety: second process blocked | PASS | US-1.3 AC1 |
| Safety: backup under WAL | PASS | US-1.6 AC2 |
| Safety: destructive creates backup | PASS | US-1.6 AC1 |
| Safety: no DB in release | DEFERRED | US-12.2 AC1, Phase 4.3 |

Out of scope for this run (reported as deferred, not failed):

| §52 group | Status | Phase |
|---|---|---|
| Operations: 16 tests (2027 parser fixture, West/East-first, failed sync keeps cache, auth_required, cms_shell, parser_mismatch, network_error, weekend selection, server CRUD, account dropdown filter, bulk template, preview invalid account, PROD polarity, DEV normalizes, repeated import upserts). "Client Notice absent" is separately verified in M-5 | DEFERRED | Spec Phase 3 (Operations). Routes return 501 (OBS `POST /api/operations/x` 501) |
| BAMS: 8 tests (provider fails closed, test provider DEV only, cadence, repeated breach, recovery, manual close, stale outage, notifications) | DEFERRED | Spec Phase 4 (BAMS). Routes 501; tables and Today/Infrastructure read seeded data only |
| Safety: imported malformed workbook does not partially write | DEFERRED | Spec Phase 5 (portability). `/api/import/*` 501 |

## 5. Findings: FAIL or MISSING

None. 0 FAIL, 0 MISSING.

Non-blocking observations (no owner action required for the gate; track in `docs/qa/OPEN_ITEMS.md`):

| # | Sev | Owner | Observation |
|---|---|---|---|
| T-1 | Low | frontend-dev-agent | The shipped `web/` bundle still contains the mock adapter code and the string `mock_data.json` (dead code on this build: I confirmed `?data=mock` is ignored and only `/api/*` is called). Consider tree-shaking it from `build:api`. |
| T-2 | Low | frontend-dev-agent | No automated test for the auto-refresh timer, the waiting-on hint, the default-landing redirect after a setting change, or the Recently Changed row click. Code read only. |
| T-3 | Low | qa-guardrail-agent | There is no `ERROR_LOG_2` after Phase 4.1, so QA-E1-1/2/3/4/7/8 are marked "QA to re-check" in `OPEN_ITEMS.md`. I re-ran every suite and spot-checked the live API (all green), but QA has not formally closed them. |
| T-4 | Low | data-architect-agent / orchestrator | `TAM_PROJECT_STATE.md` still said schema review 5 was pending (SCHEMA_REVIEW_4 was REJECTED; gate 1.3 was closed by the orchestrator under the severity policy). Wording corrected in this pass. |
| T-5 | Info | deployment-agent / user | Windows and Bloomberg items stay untested (spec section 56). US-12.2 is verified at 4.3. |

## 6. Totals

Rows: 8 mandatory + 98 story/AC rows + 7 decision rows = 113 rows, plus the section 52 summary (16 in-scope PASS, 1 DEFERRED, 3 out-of-scope groups).
**PASS 111 · FAIL 0 · MISSING 0 · DEFERRED 2** (US-12.2 AC1 and AC2, both Phase 4.3). Out-of-scope section 52 groups (Operations, BAMS, Safety import): 3 DEFERRED.

TRACEABILITY: COMPLETE (no FAIL/MISSING in scope)
