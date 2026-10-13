# 01 PM Spec: TAM Command Center, Run 1 (Spec Phases 1-2)

| | |
|---|---|
| Author | pm-agent (Phase 1.1) |
| Date | 2026-10-12 |
| Source of truth | `docs/SPEC.md` (cited below as `§n`) |
| Process | `docs/TEAM_LOOP.md` |
| User confirmations | Q-1 to Q-5 (defaults behind D-01, D-04, D-07, D-08, D-12, D-22) were confirmed by the user on 2026-10-12. |
| Scope | Spec §51 Phase 1 (Foundation) and Phase 2 (CRM Workspace): foundation, Today, Accounts, Account Workspace, Quick Capture |
| Downstream consumers | data-architect-agent (1.2), qa-guardrail-agent (1.3, 3.2), backend-dev-agent (2.1, 4.1), frontend-dev-agent (2.2, 2.3), deployment-agent (4.3), pm-agent (4.2) |

Tie-breaker for anything not settled here: §55. Clarity over decoration, faster TAM execution over CRM complexity, safe cached data over live data that may be wrong.

---

## 0. Decisions made in Phase 1.1

The spec leaves these open or ambiguous. Each one is binding for this run unless the user overrides it. Agents cite the decision ID (D-nn) when they rely on one.

| ID | Decision | Rationale / spec basis |
|---|---|---|
| D-01 | **Version line.** This rebuild starts at app version `0.1.0-dev`, schema version `1`. No in-place upgrade from the legacy v8.5.4 / schema 7 DB. Migrating legacy data is the Phase 5 importer's job (Inspect → Preview → Apply, §37). | Spec says exact version numbers need not be preserved. A clean schema line avoids inheriting legacy migration debt. |
| D-02 | **Schema is complete from day one.** `db/schema.sql` creates every §33 table, including Operations and BAMS tables. This run builds no CRUD for them. They are filled by mock seed data and read by Today, Accounts and Infrastructure. | Lets the §52 Today tests ("active BAMS alert appears", "near-term upgrade appears") and "Infrastructure shows BAMS and upgrade records" pass without building Phases 3-4, and keeps migrations stable. |
| D-03 | **Activity = manual notes ∪ system events.** System events are not copied into `notes`. The Activity timeline merges `notes` (manual, editable) with read-only rows derived from `audit_events` (task, contact and account lifecycle, server-upgrade changes) and `bams_alert_events` (opened / recovered / closed). | §12 forbids editing system history as if it were a note. One source per fact avoids drift. |
| D-04 | **Today ranking.** Six tiers, defined exactly in §3.1 below. Every object lands in exactly one place: its highest qualifying queue tier, or else Upcoming. All due-today tasks share tier 2 and are sorted by priority inside it. | §7 says ranking is "roughly". This keeps Medium/Low due-today work from sinking below upgrades. |
| D-05 | **Horizon constants.** Near-term upgrade in the queue = scheduled within 14 days. Upcoming panel = next 14 days for tasks and client touches, next 30 days for upgrades. "Upcoming tasks" queue tier = due in the next 3 days. These are named constants in one backend module. | Keeps the queue actionable. They can become settings later without touching the schema. |
| D-06 | **"Today" is the workstation's local calendar date**, computed by the backend. All-day fields (`due`, `next_update`, `next_contact`, `last_contact`, `scheduled_date`) are stored as `YYYY-MM-DD` with no timezone. Instants (`created_at`, `updated_at`, note `timestamp`, audit `timestamp`) are stored as ISO-8601 UTC (`...Z`). The Local/GMT setting changes only how instants are displayed. | §39 local vs GMT display. Date-only fields must not shift across timezones. |
| D-07 | **Next Client Touch** = `clients.next_contact`. Quick Capture "Client Follow-Up" creates a task with category `Client Follow-Up`. If the task's due date is earlier than the current `next_contact`, or `next_contact` is empty, it also sets `next_contact` to that date, in the same transaction with its own audit row. A checkbox in the form (on by default) can turn this off. | §31 lists Client Follow-Up as its own capture type. §10 needs a Next Client Touch. This links the two without a new table. |
| D-08 | **Last contact.** Saving a Meeting Note or Call Note whose date is later than `clients.last_contact` updates `last_contact` (audited, source `System`). General Notes do not. | Keeps the account brief accurate without manual bookkeeping. |
| D-09 | **API style.** Use the spec's §34 route names (`POST /api/<object>/save` is an upsert: no `id` means create). Add read endpoints only where §42 says a dedicated endpoint is needed (Today, activity pagination, archived tasks, backups). Out-of-scope §34 routes are registered and return HTTP 501 `not_implemented`. | Traceability to §34. QA can check each route by name. |
| D-10 | **Destructive confirmation.** Every `*/delete` request must include `"confirm": true`, or the server returns 409 `confirmation_required`. Before deleting, the server takes a SQLite online-API safety backup. If the backup fails, the delete is aborted. | §12 and §36 require confirmation, a safety backup and an audit row. |
| D-11 | **Optimistic concurrency.** Updates may send `expected_row_version` (integer). It is compared with the row's `row_version` column, which the DB bumps by exactly +1 on every update. If it does not match, the server returns 409 `stale_write` and the UI offers to reload. Every read payload includes `row_version`. *(Revised 2026-10-12: it was `expected_updated_at`; changed to the schema's `row_version` per `03_DATA_MODEL.md` and QA-1-3.)* | Two browser tabs on one workstation are realistic. An integer version is immune to timestamp-resolution ties. Silent overwrites go against the "trustworthy" goal in §55. |
| D-12 | **Account deletion** is allowed only through a dialog where the user types the account name. It cascades to that account's contacts, notes, tasks, server upgrades and BAMS objects, after a safety backup. `audit_events.client_id` has no FK cascade, so history survives. Setting status to `Inactive` is the primary, recommended path. | Destructive and rare. Marking Inactive keeps history. |
| D-13 | **Routing.** Path-based SPA routes (§4.1) with a backend catch-all that serves `index.html` for non-`/api` paths. Deep links survive a page reload. | §32 navigation and §52 "clicking a queue item navigates correctly". |
| D-14 | **Icons:** `lucide-react` (ISC licence, line icons, tree-shaken). This is an icon set, not a UI kit, so it does not breach the "no UI kit" rule. **Fonts:** system stack only (Segoe UI Variable / Segoe UI; Cascadia Mono / Consolas). No web-font CDN, because the app must work offline on a locked-down workstation. | §6 consistent line icons. §46 local-only. |
| D-15 | **Date entry** uses native `<input type="date">` and `datetime-local` styled with `color-scheme: dark`, plus quick chips (Today, Tomorrow, +1 week). No custom date picker this run. Select-type choices always use the custom combobox. | §6 bans raw select popups specifically. A dark native date picker is acceptable and saves a large component. |
| D-16 | **Bloomberg reference rendering (§38) is deferred.** Note and task text is rendered as escaped plain text with preserved line breaks (no Markdown, no HTML), through one `<RichText>` component. That component is the seam where §38 linking plugs in later. | Keeps the scope tight. One render path gives one sanitization point (§46). |
| D-17 | **Ports and modes.** PROD runs on `127.0.0.1:8765` and DEV on `127.0.0.1:8766` by default, overridable with `TAM_PORT`. Mode is DEV only if `TAM_DEV_MODE=1`. A build stamped `channel=dev` in `VERSION.txt` refuses to start in PROD mode. PROD ignores and logs `TAM_DEV_MODE`/`TAM_BAMS_TEST_MODE` if they appear on a prod-channel build. DEV-only routes (`/api/dev/*`) are not registered at all in PROD. | §4 and §47. Separate ports let DEV and PROD run side by side on separate DBs. |
| D-18 | **Single-instance lock.** An OS-level exclusive lock on `<db>.lock` (`msvcrt.locking` on Windows, `fcntl.flock` elsewhere) is taken before the DB is opened. A second process exits with a clear message naming the PID and port of the holder. | §4 and the §52 Safety test. |
| D-19 | **No Recharts this run.** Account Load and counts are tables and numbers. Recharts stays the locked choice for BAMS trends in Phase 4. | Frontend rule: "only where it earns its place". |
| D-20 | **Global Tasks page is functional this run** (cross-account list, same component as the account Tasks tab, plus an Account column and filter). Tasks with no account (`client_id` NULL) are allowed and appear there as "No account". | §5 nav includes Tasks. Phase 1 includes Tasks. Internal tasks need a home. |
| D-21 | **Unbuilt nav destinations** (Operations, BAMS, ChatGPT Bridge) stay in the rail with a small "Later" tag. They route to a placeholder page that says what will live there and links to the related Account Infrastructure data. | §5 mandates the nav. The frontend agent role requires a clear "not built yet" state. |
| D-22 | **Safety-backup retention.** Automatic safety backups (`pre-delete`, `pre-migration`) keep the 30 most recent. Manual backups are never pruned. **(Confirmed by the user 2026-10-12, Q-2.)** | Unbounded per-delete backups would fill the disk. Manual backups are the user's own, so they are never pruned. |
| D-23 | **One queue entry per follow-up obligation (QA-1-12a).** When an account has an open, non-archived task with category `Client Follow-Up` whose `due` equals `clients.next_contact`, the Today queue and the Upcoming panel suppress the account-level `client_follow_up` item and keep only the task. The task row shows the context "Next Client Touch". If the dates differ, both items appear. | The task is the actionable, completable object. Two rows for one obligation add noise (§55). This needs no schema change: it is a NOT EXISTS predicate in `today_queue.sql` (owner: data-architect-agent) mirrored in the backend service and `MockDataSource`. |
| D-24 | **Exception upgrades always appear in the queue (QA-1-12b).** Tier 5 also includes any upgrade with status `Exception`, whatever its date (one in the past already lands in tier 1). `Deferred` upgrades stay out of the queue and appear only in Upcoming when they fall in its window. | An Exception needs TAM action now, and §24 lists it under Needs Attention. Deferred is a deliberate "not now", so it belongs in the Phase 3 Operations Needs Attention view, not the daily queue. |
| D-25 | **Write and DB-open contracts** (from `03_DATA_MODEL.md` §2.1 and §12, QA-1-2/QA-2-2, QA-1-14). (a) No DB write ever uses REPLACE in any spelling (`REPLACE INTO`, `INSERT OR REPLACE`, `UPDATE OR REPLACE`, ORM equivalents). Allowed idioms are plain INSERT, `INSERT … ON CONFLICT(…) DO UPDATE`, and (insert-once cases such as the BAMS notification log) `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`; widened by the orchestrator 2026-10-12 to match `03_DATA_MODEL.md` §2.1 and QA-2-1. And `db/sql_safety_scan.py` fails the build on violations. (b) `channel` (`dev`/`prod`) is a required argument on every DB open and migrate call; there is no default. (c) The release must ship `db/schema.sql`, `db/migrations/` and `db/queries/`, because `assert_guards` reads `schema.sql` at startup. | REPLACE deletes and reinserts rows, which silently bypasses audit and FK semantics. A required channel prevents a DEV process from opening a PROD DB by default. A missing `schema.sql` would stop the app from starting. |

---

## 1. Epics and user stories

Format: **US-x.y**: story. *Trace:* spec sections. **AC:** testable acceptance criteria. ACs marked **[§52]** are spec acceptance tests and must appear in `docs/05_TRACEABILITY.md`.

### E1 Foundation and environment safety (§3, §4, §36, §40, §46)

**US-1.1** As the TAM, I start the app and it serves the UI and API on loopback only. *Trace:* §3, §46.
- AC1: The server binds to `127.0.0.1` only. A request to the host's LAN IP is refused. No config flag exposes it to the LAN.
- AC2: `GET /api/health` returns `{ok, mode, version, schema_version, db_path}`. In PROD, `db_path` is the full path. It is shown only on loopback, so this is acceptable.
- AC3: CORS allows same-origin only, plus the Vite dev-server origin when `mode=DEV`.

**US-1.2** DEV and PROD are isolated. *Trace:* §4, D-17.
- AC1: The DEV DB is `<app>/dev_data/tam_dev.db`. The PROD DB is `%LOCALAPPDATA%\TAM_Command_Center\tam_command_center.db`. The two paths can never resolve to the same file, and startup asserts this.
- AC2 **[§52]**: A DEV-channel build started without `TAM_DEV_MODE=1` refuses to run in PROD mode (exits non-zero with a clear message).
- AC3: `/api/dev/*` routes return 404 in PROD (they are not registered).
- AC4: The UI shows a persistent `DEV` badge in the top bar when `mode=DEV`. PROD shows no badge.

**US-1.3** Only one process can open a given DB. *Trace:* §4, D-18.
- AC1 **[§52]**: Starting a second process against the same DB fails fast with the message "Another TAM Command Center instance (PID n, port p) is using this database." No write happens.

**US-1.4** The schema is created and migrated safely. *Trace:* §4, §33, §36.
- AC1: A fresh DB is created at the current `app_meta.schema_version` with WAL and `foreign_keys=ON`.
- AC2: Before any migration runs on an existing DB, the SQLite online-backup API creates a `pre-migration` backup. If the backup fails, the migration is aborted.
- AC3: Running migrations twice is a no-op.

**US-1.5** Every write is audited. *Trace:* §35.
- AC1: Each create, update, delete, archive, primary change and setting change writes one `audit_events` row with `timestamp`, `client_id` (when known), `object_type`, `object_id`, `action`, `old_value`/`new_value` (JSON of changed fields), `reason` (optional) and `source` (`GUI`, `System`, `Migration`; later `Bulk Import` and `ChatGPT Bridge`).
- AC2: The data write and its audit row commit in the same transaction.

**US-1.6** Risky writes have backups. *Trace:* §36, D-10, D-22.
- AC1 **[§52]**: Deleting a note, task, contact or account creates a `pre-delete` backup file before the delete commits.
- AC2 **[§52]**: A backup taken while the app is writing in WAL mode yields a DB that passes `PRAGMA integrity_check` and contains the committed rows.
- AC3: The code never uses `shutil.copy` or file replacement on a live DB file. QA verifies this with grep.

**US-1.7** Logs are useful and safe. *Trace:* §40.
- AC1: Startup logs the mode, version, DB path, schema version and migration outcome. Backup operations and API errors are logged.
- AC2: `BrokenPipeError`, `ConnectionResetError`, `ConnectionAbortedError` and WinError 10053/10054 are logged at DEBUG as a single line with no traceback.
- AC3: `GET /api/logs/recent?limit=200` returns recent log lines, which Settings displays.

### E2 Navigation shell and design system (§5, §6, §43, §44, §54)

**US-2.1** A persistent left rail shows Today, Accounts, Tasks, Operations, BAMS, ChatGPT Bridge and Settings, each with an icon and label. *Trace:* §5, D-21.
- AC1: The active item uses an amber icon and label with an amber indicator bar. Inactive items are muted gray.
- AC2: There is no Journal item.
- AC3: Operations, BAMS and Bridge show a "Later" tag and open a placeholder page.
- AC4: Below 1280px wide the rail collapses to icons only, with tooltips and an `aria-label` on each item.

**US-2.2** The design system follows `docs/02_DESIGN_GUIDELINES.md`. *Trace:* §6, §54.
- AC1: No browser-native white button or native select popup appears anywhere. QA checks every screen.
- AC2: Every button shows the default, hover, active, disabled and focus-visible states.
- AC3: The custom select combobox passes the keyboard matrix in guidelines §6.

**US-2.3** The app is accessible. *Trace:* §43.
- AC1: All controls have labels, all tables use `<table>` semantics, and keyboard focus is always visible.
- AC2: Dialogs and drawers trap focus, close on Escape, and return focus to the element that opened them.
- AC3: With `prefers-reduced-motion: reduce`, transitions are disabled.
- AC4: Text contrast is at least 4.5:1 for body text and 3:1 for large text and UI glyphs. Status is never conveyed by colour or icon alone.

**US-2.4** Narrow windows still work. *Trace:* §44.
- AC1: At 1024px wide, the Today queue and the Account tabs stay fully usable. The secondary context (Today right column, Account context rail) moves below the primary content and collapses before the primary content shrinks.
- AC2: Wide tables scroll horizontally inside their container. The page itself never scrolls horizontally at widths of 768px and above.

### E3 Today: daily action workspace (§7)

**US-3.1** Today is the default landing page and shows a prioritized work queue. *Trace:* §7, D-04, D-05.
- AC1: Queue items are ranked by the tiers in §3.1 below.
- AC2: Each item shows the account, type label, title, urgency/status, date with a relative label, and context (waiting owner, server, or metric).
- AC3 **[§52]**: An overdue task appears before a normal upcoming task.
- AC4 **[§52]**: An active BAMS alert (seeded) appears as an actionable item.
- AC5 **[§52]**: A seeded upgrade within 14 days appears in the queue.
- AC6 **[§52]**: Clicking an item navigates to the underlying object, following the route table in §4.2. Pressing Enter on a focused item does the same.
- AC7: The landing page honours the "default landing page" setting.

**US-3.2** Upcoming shows the next 14 days of obligations (30 days for upgrades), excluding anything already in the queue. *Trace:* §7.
- AC1: Items are grouped by date ("Tomorrow", then weekday or date headings) and include tasks, next client touches and server upgrades.

**US-3.3** Recently Changed shows the latest 20 account-level changes as one-line sentences. *Trace:* §7.
- AC1: The list includes note created, task completed, upgrade updated, BAMS alert opened, recovered or closed, and contact changed. Settings and backup events are excluded.
- AC2: Clicking a row opens that account's Activity tab.

**US-3.4** Account Load is a compact table below the queue. *Trace:* §7.
- AC1: Columns are Account, Open, Overdue, Waiting, Alerts and Next Contact. Rows are sorted by overdue (descending), then open (descending). At most 8 rows are shown, with an "All accounts" link.
- AC2: Clicking a row opens the account Overview.
- AC3: The table is visually subordinate to the queue (smaller heading, lower position).

**US-3.5** Today refreshes on the "dashboard auto-refresh" setting (Off/1/5/15 min) and after every mutation. *Trace:* §39.

### E4 Accounts directory (§8)

**US-4.1** Accounts is a dense, sortable table. *Trace:* §8.
- AC1: Columns are Account, Open Tasks, Overdue, Waiting, BAMS Alerts, Next Upgrade and Next Contact. Numbers use tabular numerals and are right-aligned.
- AC2: There is no health score and there are no commercial fields.
- AC3: A search box filters by name or BPID. A status filter offers Active (default), Inactive and All.
- AC4 **[§52]**: Clicking a row opens that account's Workspace Overview.
- AC5: "+ Account" opens the account editor (name required, unique, case-insensitive; BPID; products; status; next contact; notes).

### E5 Account Workspace: header and Overview (§9, §10)

**US-5.1** The account header shows the name, BPID, products and counts: open tasks, overdue, waiting, servers, active BAMS alerts and upcoming upgrades. *Trace:* §9.
- AC1: "Servers" counts distinct server or appliance names (case-insensitive, trimmed) across `bams_objects` and `server_upgrades` for the account.
- AC2: Each count is plain text with a label, not a badge. Overdue > 0 and alerts > 0 use the danger and warning text colours.
- AC3: An "Edit account" action opens the account drawer, which contains a danger zone for deletion (D-12).

**US-5.2** Tabs are Overview | Tasks | Activity | Infrastructure | Contacts, each with an icon and synced to the URL. *Trace:* §9.

**US-5.3** Overview shows the top open tasks. *Trace:* §10.
- AC1 **[§52]**: It shows up to 8 open (non-Complete, non-archived) tasks, sorted overdue first, then priority High→Low, then due date ascending (nulls last).
- AC2: Clicking a row opens the task drawer. Rows have a hover chevron and no "Open" button. "View all (n)" switches to the Tasks tab.

**US-5.4** Overview shows the 10 most recent Activity entries, with manual notes and system events visually distinct (guidelines §9). "View all" opens the Activity tab. *Trace:* §10, §12.

**US-5.5** A continuous context rail (one surface with internal dividers, not separate cards) shows the following. *Trace:* §10.
- Next Client Touch: date, relative timing, primary contact name, inline "Set date" action, and last contact.
- Infrastructure Snapshot: server count, active alerts, next upgrade (date and server), and an environment summary (e.g. `PROD 4 · DEV 1`, regions).
- Contacts: up to 5, primary first, showing name, role, team, email (as a `mailto:` link) and a primary marker.
- Account details: BPID, products, account notes.

### E6 Tasks (§11, D-20)

**US-6.1** The account Tasks tab lists tasks for the account. *Trace:* §11.
- AC1 **[§52]**: Only tasks with this account's `client_id` appear.
- AC2: Columns are Task, Category, Priority, Due, Next Update, Status, Waiting On and Updated.
- AC3: Filters are status (default "Open" = not Complete), priority, category, a text search (task, notes, waiting), and a "Show archived" toggle. Every column is sortable.
- AC4: An inline "Mark complete" icon button appears on row hover or focus.

**US-6.2** Create and edit tasks in a drawer. *Trace:* §11.
- AC1: Fields are Task (required, ≤500 chars), Account (picker, nullable), Category (the 10 spec values), Priority (default Medium), Status (default Not Started), Due, Next Update, Waiting On and Notes (≤20,000 chars). Created and updated timestamps are shown read-only.
- AC2: If status is Waiting and Waiting On is empty, a non-blocking hint appears.
- AC3: Saves are audited. Completing a task writes an audit `action=completed`, which surfaces as a system event in Activity.

**US-6.3** Archive and unarchive tasks. Archived tasks are hidden unless "Show archived" is on. Changes are audited. *Trace:* §11.

**US-6.4** Delete a task after confirmation and a safety backup. The delete is audited. *Trace:* §11, D-10.

**US-6.5** The global Tasks page shows the same table plus an Account column and an account filter, including a "No account" option. *Trace:* §5, D-20.

### E7 Activity and notes (§12)

**US-7.1** The Activity timeline merges manual notes and system events, newest first, paginated 50 at a time with "Load more". *Trace:* §12, §45, D-03.

**US-7.2** Activity filters are All, Meeting Notes, Call Notes, General and System Events, plus a text search on subject and body. *Trace:* §12.
- AC1 **[§52]**: Each filter returns only its type. "System Events" returns only derived events.

**US-7.3** Manual notes support create, edit and delete. *Trace:* §12.
- AC1 **[§52]**: Meeting Note create, edit and delete all work.
- AC2 **[§52]**: Call Note create, edit and delete all work.
- AC3 **[§52]**: General Note create, edit and delete all work.
- AC4: Fields are Type, Timestamp (defaults to now, editable), Subject (≤200), Body (≤50,000), Action Items (≤10,000) and Source (read-only, `GUI` for UI-created notes).
- AC5: Delete requires confirmation, a safety backup and an audit row. The deletion appears as a system event ("Meeting note deleted: <subject>").

**US-7.4** System events are distinct and read-only. *Trace:* §12.
- AC1 **[§52]**: System events render in the compact system style (guidelines §9). They have no edit or delete controls, and the API has no route that edits them.

### E8 Contacts (§13)

**US-8.1** The Contacts tab is a table with Name, Role, Team, Email and Primary, with create, edit and delete in a drawer. *Trace:* §13.

**US-8.2** Primary contact behaviour. *Trace:* §13.
- AC1 **[§52]**: Making contact B primary clears A's primary flag in the same transaction. A toast confirms "B is now primary (was A)". The database enforces at most one primary per account.
- AC2: An account may have zero primary contacts.
- AC3: Contact add, update, delete and primary changes appear as system events.

### E9 Infrastructure, read-only this run (§14, D-02)

**US-9.1** The Infrastructure tab shows BAMS objects (name, region, location, enabled, worst metric status, active alerts) and server upgrade records (server, environment/polarity, current → target version, scheduled date, status, validation). *Trace:* §14.
- AC1 **[§52]**: Seeded BAMS objects and upgrade records for the account are listed.
- AC2: A notice reads "Upgrades are managed in Operations; monitoring in BAMS (coming in a later release)." There are no create or edit controls.
- AC3: `?server=<name>` highlights and scrolls to that server's rows (target for Today links).

### E10 Quick Capture and search (§31, §32)

**US-10.1** A global "+ Capture" button in the top bar, and the `N` key when focus is not in an editable field, opens the Quick Capture dialog on any page without navigating away. *Trace:* §31.
- AC1: The type segmented control offers Task, Client Follow-Up, Meeting Note, Call Note and General Note.
- AC2: The Account picker comes first. It is pre-filled with the current account when opened inside a workspace.
- AC3: Task shows Task, Due, Priority and Category. Client Follow-Up shows Task (prefilled "Follow up with <primary contact or account>"), Due (required) and the "Update Next Client Touch" checkbox (D-07). Notes show Subject, Body, Action Items and Timestamp.
- AC4: Ctrl+Enter saves. After saving, a toast offers a "View" link. The dialog closes and the current page refreshes its data.
- AC5: An account is required for notes and Client Follow-Up, and optional for Task.

**US-10.2** Global account jump. *Trace:* §32.
- AC1: Ctrl+K, or clicking the top-bar search, opens an account picker with type-ahead over name and BPID. Enter opens that account's Overview.

**US-10.3** Cross-links. *Trace:* §32.
- AC1: Account names anywhere outside the workspace (Today, global Tasks, Recently Changed, Account Load) link to the Account Workspace.

### E11 Settings and backup (§39, §36)

**US-11.1** The Settings page offers: default landing page (Today/Accounts/Tasks); time display (Local/GMT); dashboard auto-refresh (Off/1/5/15 min); log level (INFO/DEBUG); and open browser on start (stored for the launcher). *Trace:* §39.
- AC1: Every change is saved via `/api/settings/save` and audited.
- AC2: BAMS cadence, notifications, privacy mode and start-with-Windows do not appear yet. They arrive with their phases.

**US-11.2** Runtime panel (read-only): mode, version, schema version, DB path and backup folder. *Trace:* §39, §42.

**US-11.3** "Create backup now" runs a manual online backup. A list shows the 20 most recent backups (name, reason, size, time). A recent-log viewer is included. *Trace:* §36, §40.

### E12 Process and documentation discipline (§50, §47)

**US-12.1** `TAM_Command_Center/TAM_PROJECT_STATE.md` and `CHANGELOG.md` are updated by every agent on every substantive change (§50). QA treats a missing update as a Low finding.

**US-12.2** Deployment-agent produces the §47 launchers and files for DEV and PROD, a release zip without any `.db`, and a SHA-256 manifest. *Trace:* §47, §52.
- AC1 **[§52]**: The release archive contains no `*.db`, `*.db-wal` or `*.db-shm` files and no `dev_data/` directory.
- AC2: Windows behaviour is flagged "untested on Windows" until it is verified on the workstation (§56).

---

## 2. Data model requirements for data-architect-agent

The data architect owns the details. These requirements come from the decisions above.

1. All §33 tables (D-02). `support_cases` is included but unused.
2. Enumerations enforced with CHECK constraints:
   - task category, priority and status (§11)
   - note_type: `Meeting Note`, `Call Note`, `General Note`
   - client status: `Active`, `Inactive`
   - server-upgrade environment, polarity, status and validation_status (§22, §23)
   - BAMS alert event status: `open`, `recovered`, `closed`
   - severity: `Info`, `Warning`, `Critical`
   - audit source: `GUI`, `System`, `Migration`, `Bulk Import`, `ChatGPT Bridge`
3. A partial unique index enforces one primary contact per account: `UNIQUE(client_id) WHERE is_primary=1`.
4. `clients.name` is unique, case-insensitive (`COLLATE NOCASE`).
5. `audit_events.client_id` has no cascading FK (D-12).
6. Indexes support:
   - Today queue (tasks by status, archived, due and next_update; clients.next_contact; server_upgrades by scheduled_date and status; bams_alert_events by status)
   - per-account task lists
   - the activity timeline (notes by client_id and timestamp; audit_events by client_id and timestamp)
   - recently-changed (audit_events by timestamp)
7. Settings live in `app_meta` under the `setting.` prefix. `schema_version` lives in `app_meta`.
8. Mock seed (DEV only, deterministic, dates relative to today) covers every Today tier, at least one account with zero primary contacts, an account with no BAMS objects, Inactive accounts, archived tasks, unassigned tasks, open/recovered/closed alerts (including a Critical open one), and upgrades inside and outside the 14-day and 30-day windows (including Validation Required and Completed + Pending).

---

## 3. Business rules

### 3.1 Today queue (D-04, D-05)

`T` means the local date for today. Each object is placed in the **first** tier it qualifies for. Archived tasks and Inactive accounts are excluded. Complete tasks, `closed` alerts and Completed+validated/Not Required upgrades are excluded.

| Tier | Label | Qualifies when | Sort within tier |
|---|---|---|---|
| 1 | Overdue / Critical | Task with `due < T`; BAMS event `status=open` with `severity=Critical`; upgrade with `scheduled_date < T` and status not in (Completed, Deferred) | Critical alerts first, then priority High→Low, then date ascending |
| 2 | Due today | Task with `due = T` | Priority High→Low, then title |
| 3 | Infrastructure alerts | BAMS event `status=open` with severity Warning or Info, or `status=recovered` (awaiting close) | open before recovered, Warning before Info, then `opened_at` ascending |
| 4 | Waiting / follow-up | Task with `status=Waiting` and (`next_update ≤ T` or `next_update` null); account with `next_contact ≤ T`, unless suppressed by D-23 | Date ascending, nulls last |
| 5 | Upgrade actions | Upgrade with `T ≤ scheduled_date ≤ T+14` and status not in (Completed, Deferred); or status Validation Required; or status Exception, at any date (D-24); or validation Failed; or Completed + Pending | Date ascending |
| 6 | Upcoming tasks | Task with `T+1 ≤ due ≤ T+3` | Due ascending, then priority |

Upcoming panel: tasks with `T+4 ≤ due ≤ T+14`; Waiting tasks with `T < next_update ≤ T+14`; accounts with `T < next_contact ≤ T+14`; upgrades with `T+15 ≤ scheduled_date ≤ T+30`. Items already in the queue are excluded, and the D-23 de-duplication applies.

Queue item contract (frozen by backend-dev-agent in `04_API_CONTRACT.md`):
`{kind: task|client_follow_up|bams_alert|server_upgrade, id, tier, tier_label, client_id, client_name, type_label, title, status, urgency: overdue|critical|due_today|alert|recovered|waiting|follow_up|upgrade|validation|upcoming, date, date_kind: due|next_update|next_contact|opened|scheduled, days_delta, context}`.

### 3.2 Other rules
- **Open task** means status ≠ Complete and archived = 0. **Overdue** means open and `due < T`. **Waiting** means open and status = Waiting.
- **Active BAMS alerts** are events with status `open` or `recovered`. **Next upgrade** is the minimum `scheduled_date ≥ T` among upgrades not Completed or Deferred.
- **Activity system events** (D-03) come from audit actions on task (created, completed, reopened, archived, deleted), contact (added, updated, deleted, primary_changed), note (deleted only), client (next_contact changed, status changed) and server_upgrade (any). BAMS events come from `bams_alert_events` (opened_at, recovered_at and closed_at each produce one entry). Each system event has a display sentence generated by the backend.
- **Validation (server side; the client mirrors it):** trim all strings; reject unknown enum values; validate dates as ISO `YYYY-MM-DD`; email is optional but must match a basic `x@y.z` shape if present. Unknown fields are rejected (Pydantic `extra=forbid`).

---

## 4. Screens

### 4.1 Global shell
```
┌──────────┬───────────────────────────────────────────────────────────────┐
│ ▣ TAM CC │ [⌕ Jump to account…  Ctrl+K]          [DEV]  14:05 Local  [+ Capture] │  top bar 48px
│──────────│───────────────────────────────────────────────────────────────│
│ ◉ Today  │                                                               │
│ ▢ Accounts│                     page content                              │
│ ▢ Tasks  │                 (max content width none;                     │
│ ▢ Operations Later│          24px gutters)                                │
│ ▢ BAMS  Later │                                                          │
│ ▢ Bridge Later│                                                          │
│          │                                                               │
│ ▢ Settings│                                                              │
└──────────┴───────────────────────────────────────────────────────────────┘
 rail 208px (56px collapsed below 1280px)
```

### 4.2 Routes and navigation targets
| Route | Screen |
|---|---|
| `/` | Redirects to the default landing setting (Today if unset) |
| `/today` | Today |
| `/accounts` | Accounts directory |
| `/accounts/:clientId` | Redirects to `/accounts/:clientId/overview` |
| `/accounts/:clientId/{overview\|tasks\|activity\|infrastructure\|contacts}` | Workspace tab |
| `?task=<id>` / `?note=<id>` / `?contact=<id>` / `?server=<name>` | Opens the editor drawer for that object, or highlights it (infrastructure) |
| `/tasks` | Global tasks (supports `?task=<id>`) |
| `/settings` | Settings |
| `/operations`, `/bams`, `/bridge` | Placeholder (D-21) |

Queue item targets:
| Item kind | Target |
|---|---|
| task with account | `/accounts/:cid/tasks?task=:id` |
| task without account | `/tasks?task=:id` |
| client_follow_up | `/accounts/:cid/overview` (focus moves to Next Client Touch) |
| bams_alert | `/accounts/:cid/infrastructure?server=<object name>` |
| server_upgrade | `/accounts/:cid/infrastructure?server=<server_name>` |

### 4.3 Today
```
Today · Mon 12 Oct 2026                               Last refreshed 14:05 ⟳
┌───────────────────────────── Work queue (n) ──────────────┐┌─ Upcoming ─────────┐
│ OVERDUE / CRITICAL                                          ││ TOMORROW           │
│ ● Acme Capital  Task  Send entitlement summary   High  3d overdue  Waiting: J.Doe ›││  Task …            │
│ ● Borealis      BAMS  CPU breach bxa-ny-01      Critical  opened 09:12           ›││ THU 15 OCT          │
│ DUE TODAY                                                   ││  Client touch …    │
│ …                                                           ││─ Recently changed ─│
│ INFRASTRUCTURE ALERTS / WAITING / UPGRADES / UPCOMING       ││ 13:40 Acme · Task completed … │
└─────────────────────────────────────────────────────────────┘└────────────────────┘
┌── Account load ── (subordinate, compact) ─────────── All accounts › ┐
│ Account | Open | Overdue | Waiting | Alerts | Next contact            │
└──────────────────────────────────────────────────────────────────────┘
```
- The main column is about two thirds of the width. The right column is fixed at 360px. Below 1200px the right column moves under the queue.
- Tier group headings are small uppercase labels with counts. Empty tiers are hidden. If the whole queue is empty, it shows "Nothing needs attention. Next item: <first Upcoming>".
- Each queue row has 6 grid columns: urgency marker | account (link) | type label | title (ellipsis, full text in tooltip) | status + date (tabular, right-aligned) | context + chevron.

### 4.4 Accounts directory
A header row holds the "Accounts" title, a count, search, status filter, and the "+ Account" button. Below it is the dense table (32px rows, sticky header) with the columns from US-4.1. The default sort is Overdue descending, then name. A zero count renders as a muted "0". An empty Next Upgrade or Next Contact renders as a muted "-".

### 4.5 Account Workspace
```
‹ Accounts
Acme Capital Partners   BPID 1234567 · Terminal, B-PIPE                   [Edit account]
OPEN 12 · OVERDUE 3 · WAITING 2 · SERVERS 5 · ALERTS 1 · UPGRADES 2
[icon Overview] [icon Tasks 12] [icon Activity] [icon Infrastructure] [icon Contacts 4]
┌──────── main (fluid) ─────────────────────────────┐┌── Context rail 320px ──┐
│ OPEN TASKS                       View all (12) ›  ││ NEXT CLIENT TOUCH      │
│ rows… (8)                                          ││ Thu 15 Oct · in 3d     │
│                                                    ││ with J. Doe  [Set date]│
│ RECENT ACTIVITY                    View all ›     ││ Last contact 02 Oct    │
│ ▌Meeting note · 09 Oct · QBR prep …                ││ ───────────────────    │
│  ⚙ System · Task completed: …                     ││ INFRASTRUCTURE         │
│                                                    ││ ───────────────────    │
│                                                    ││ CONTACTS               │
│                                                    ││ ───────────────────    │
│                                                    ││ ACCOUNT DETAILS        │
└────────────────────────────────────────────────────┘└────────────────────────┘
```
- The header counts are a single line of labelled numbers, not badges.
- Tabs show counts where meaningful. The tab state lives in the URL.
- Below 1100px the context rail becomes a collapsible "Account brief" section between the header and the tab content, collapsed by default. On the Overview tab it starts expanded.
- **Tasks tab:** a filter bar (status, priority, category, search, show archived, "+ Task") above the table.
- **Activity tab:** a filter segmented control and search, plus "+ Note" (a split button for note type), above the timeline.
- **Infrastructure tab:** two sections, "Monitored appliances (BAMS)" and "Server upgrades", each with a table, plus the read-only notice.
- **Contacts tab:** a table plus "+ Contact". The Primary column holds a star toggle button labelled "Make primary" / "Primary".

### 4.6 Drawers and dialogs
- **Editor drawer** (right side, 480px, full height): Task, Note, Contact and Account editors. It has a header with the object type, a scrollable body, and a sticky footer with Save (primary), Cancel, and secondary actions (Archive, Delete) on the left. Closing with unsaved changes asks "Discard changes?".
- **Quick Capture dialog** (centered, 600px): type segmented control, then the account picker, then type-specific fields. Footer: Save (Ctrl+Enter) and Cancel.
- **Confirm-delete dialog:** names the object. Body text: "A safety backup is created first. This cannot be undone in the app." The danger button is labelled with the verb and object (e.g. "Delete note"). Deleting an account also requires typing its exact name.

### 4.7 Settings
Sections: General (landing page, time display, auto-refresh, open browser on start), Diagnostics (log level and recent log viewer), Data (create backup now, backups list), Runtime (read-only).

### 4.8 Placeholder pages (D-21)
A title and icon, one paragraph on what the page will do (from §15/§29/§30), "Planned for a later release", and links to related in-scope views.

---

## 5. Component inventory (frontend-dev-agent)

| Component | Used by | Notes |
|---|---|---|
| `AppShell`, `NavRail`, `TopBar` | all | Collapsed rail below 1280px. The DEV badge lives in TopBar. |
| `Button` (primary, secondary, ghost, danger, icon) | all | Every state per guidelines §5. |
| `Select` (select-only combobox) | filters, editors | Guidelines §6 |
| `AccountPicker` (editable combobox, list autocomplete) | Quick Capture, task editor, jump | Guidelines §6.3 |
| `SegmentedControl` | Activity filter, Quick Capture type, settings | Radio-group semantics |
| `Tabs` | Workspace | APG tabs, URL-synced |
| `DataTable` | Accounts, Tasks, Contacts, Infra, Account Load | Sortable headers (`aria-sort`), sticky header, row navigation, horizontal scroll container |
| `QueueList` / `QueueRow` | Today | Tier groups |
| `UpcomingList`, `RecentChanges` | Today | |
| `AccountHeader`, `ContextRail` | Workspace | One continuous surface |
| `ActivityTimeline`, `NoteEntry`, `SystemEventEntry` | Overview, Activity | Distinct styles |
| `EditorDrawer` + `TaskForm`, `NoteForm`, `ContactForm`, `AccountForm` | | |
| `QuickCaptureDialog`, `ConfirmDialog`, `Dialog` base | | Focus trap |
| `Toast` / `ToastRegion` | | `aria-live` |
| `StatusBadge`, `PriorityLabel`, `DateCell` (relative + absolute), `CountStat` | | |
| `RichText` | notes, tasks | Escaped plain text with line breaks (D-16) |
| `EmptyState`, `ErrorBanner`, `SkeletonRows`, `StaleDataBanner` | | |
| `PlaceholderPage` | | |
| Data layer: `api/` repository (the only module that calls `fetch`), a `DataSource` adapter interface with `MockDataSource` (mock JSON) and `HttpDataSource`, and a `store` (React context + reducer, or a small external store) exposing selectors | | 2.3/4.1 adapter swap through one config value |

---

## 6. API contract list (backend-dev-agent freezes the details in `docs/04_API_CONTRACT.md`)

All responses are JSON. Errors look like `{"ok": false, "error": {"code", "message", "fields"?: {field: msg}}}`.

Codes:

| Code | HTTP status |
|---|---|
| `validation_error` | 422 |
| `not_found` | 404 |
| `confirmation_required` | 409 |
| `stale_write` | 409 |
| `conflict` (e.g. duplicate account name) | 409 |
| `not_implemented` | 501 |
| `backup_failed` | 500 |
| `internal` | 500 |

Successful mutations return `{"ok": true, "item": {...}}`. They may add `"side_effects": [...]`, for example `next_contact_updated` or `primary_cleared`.

| Method | Route | Purpose | Notes |
|---|---|---|---|
| GET | `/api/health` | runtime info | US-1.1 |
| GET | `/api/state` | first-load bundle | accounts with derived counts, non-archived tasks, contacts, settings, runtime, infrastructure summary per account (BAMS objects + upgrades, read-only). Excludes the full activity, archived tasks and BAMS samples (§42) |
| GET | `/api/today` | `{today, queue, upcoming, recent_changes, account_load}` | §3.1 |
| GET | `/api/client/{id}/activity` | timeline page | `filter=all\|meeting\|call\|general\|system`, `q`, `before` (cursor), `limit` (≤100, default 50) |
| GET | `/api/tasks` | task query | `client_id`, `archived` (bool), `status`; used for archived and filtered views |
| GET | `/api/client/{id}/infrastructure` | BAMS objects, metric status, active alerts, upgrades | read-only |
| GET / POST | `/api/settings`, `/api/settings/save` | settings | audited |
| GET | `/api/logs/recent` | log tail | `limit` ≤ 1000 |
| POST | `/api/client/save`, `/api/client/delete` | accounts | delete needs `confirm` + `confirm_name` (D-12) |
| POST | `/api/contact/save`, `/api/contact/delete` | contacts | primary handling in the service layer |
| POST | `/api/task/save`, `/api/task/archive`, `/api/task/delete` | tasks | save accepts `update_next_contact` (D-07). Archive takes `{id, archived: bool}` |
| POST | `/api/note/save`, `/api/note/delete` | manual notes only | D-08 side effect |
| POST / GET | `/api/data/backup`, `/api/data/backups` | manual backup and list | |
| POST | `/api/dev/reseed` | DEV only: reset the DEV DB to the mock seed | absent in PROD; takes a safety backup first |
| any | `/api/operations/*`, `/api/bams/*`, `/api/export/*`, `/api/import/*`, `/api/data/reset`, `/api/restore/excel`, `/api/context`, `/api/chat/apply` | later phases | 501 `not_implemented` |

---

## 7. Task board

Owners: **DA** data-architect-agent · **QA** qa-guardrail-agent · **BE** backend-dev-agent · **FE** frontend-dev-agent · **DEP** deployment-agent · **PM** pm-agent. Paths are relative to the repo root.

| ID | Phase | Owner | Task | Inputs | Outputs | Depends on | Definition of done |
|---|---|---|---|---|---|---|---|
| T-01 | 1.2 | DA | Full §33 schema with constraints and indexes | SPEC, this doc §2 | `TAM_Command_Center/db/schema.sql` | none | Loads into a scratch DB. `integrity_check` = ok. `foreign_key_check` is empty. The partial unique primary index rejects a second primary (shown). |
| T-02 | 1.2 | DA | Migration runner contract and migration 0001 | T-01 | `db/migrations/0001_initial.sql` (+ runner contract in the data model doc) | T-01 | Applying twice is a no-op. `schema_version=1`. The pre-migration backup hook is specified. |
| T-03 | 1.2 | DA | Deterministic relative-date mock seed | §2.8 | `db/seed_mock.py`, `db/mock_data.json` | T-01 | Seed runs. A query shows at least 2 items in every Today tier, plus the edge cases in §2.8. No real names or emails (`example.com` domains only). |
| T-04 | 1.2 | DA | Data model doc | T-01..03 | `docs/03_DATA_MODEL.md` | T-01..03 | Includes the ER diagram, query patterns, a Today SQL sketch matching §3.1, audit conventions and the "no vector index" statement. |
| T-05 | 1.3 | QA | Schema gate | T-01..04 | `docs/qa/SCHEMA_REVIEW_<n>.md` | T-04 | Ends with a VERDICT line. If REJECTED, the work returns to DA. |
| T-10 | 2.1 | BE | App skeleton: config, modes, ports, loopback, CORS, lock, logging, WAL, migration runner with backup | D-17, D-18, US-1.x | `TAM_Command_Center/server/` | T-05 APPROVED | pytest covers: DEV-build PROD refusal, second-instance block, PROD route absence, loopback bind, disconnect-error logging level. |
| T-11 | 2.1 | BE | Repository and service layers; audit-in-transaction; backup service (online API) | §3.2, D-10, D-22, D-25 | `server/` | T-10 | Tests: every write produces exactly one audit row, rolled back together with the data on failure; backup under concurrent WAL writes passes `integrity_check`; `sql_safety_scan.py` passes on `server/`; every DB open passes an explicit `channel`. |
| T-12 | 2.1 | BE | CRUD routes: client, contact (primary), task (archive, update_next_contact), note (last_contact) | E4-E8 | `server/` | T-11 | Tests for each AC tagged [§52] in E5-E8; tests for D-07, D-08, D-10, D-11 (`expected_row_version`), D-12, D-23, D-24. |
| T-13 | 2.1 | BE | `/api/state`, `/api/today`, activity pagination, tasks query, infrastructure, settings, logs, backups, dev/reseed, 501 stubs | §3.1, §6 | `server/`, `docs/04_API_CONTRACT.md` | T-12 | One test per Today tier with seeded data, and a "first qualifying tier only" test. The contract doc lists every route with examples. |
| T-20 | 2.2 | FE | Vite/TS scaffold, tokens, base components (Button, Select, AccountPicker, SegmentedControl, Tabs, DataTable, Dialog, Drawer, Toast) | `02_DESIGN_GUIDELINES.md` | `TAM_Command_Center/frontend/` | T-05 (parallel with T-10) | Vitest keyboard tests for Select and AccountPicker (full guidelines §6 matrix). `tsc --noEmit` is clean. A component sandbox page renders every button state. |
| T-21 | 2.2 | FE | Shell, routing (§4.2), placeholders, settings page | E2, E11 | `frontend/` | T-20 | All routes render. Deep-link reload works under `vite preview`. |
| T-22 | 2.2 | FE | Today, Accounts, Workspace (all tabs), drawers, Quick Capture, account jump | E3-E10 | `frontend/` | T-21 | Every screen in §4 is implemented with loading, empty and error states. |
| T-23 | 2.3 | FE | `DataSource` adapter: `MockDataSource` over `db/mock_data.json` with the in-memory Today ranking from §3.1 | T-03, T-13 contract | `frontend/src/api/` | T-22, T-13 | Toggling the adapter changes no component code. Mutations reflect in Today and the workspace while running on mock data. |
| T-30 | 3.1 | Orchestrator | Build both trees and commit a checkpoint | | git commit | T-13, T-23 | Both builds succeed. |
| T-31 | 3.2 | QA | Integration and security evaluation; e2e for every [§52] AC in scope | all | `docs/qa/ERROR_LOG_<n>.md`, `TAM_Command_Center/tests/e2e/` | T-30 | Verdict line present. The loop repeats until PASS (0 open). |
| T-40 | 4.1 | BE + FE | Backend serves the compiled `web/` with SPA fallback; FE switches the adapter to `HttpDataSource` | | config change | T-31 PASS | QA re-runs T-31 against the live API. |
| T-41 | 4.2 | PM | Traceability matrix | everything | `docs/05_TRACEABILITY.md` | T-40 | No FAIL or MISSING for in-scope items. |
| T-42 | 4.3 | DEP | §47 launchers, `requirements.txt`, README/VERSION/VALIDATION, release zip and SHA-256 manifest | | release folder | T-41 | The smoke test boots DEV from the zip. The archive scan finds no DB, and finds `db/schema.sql`, `db/migrations/` and `db/queries/` present (D-25c). Windows items are flagged as untested. |
| T-50 | every | all | Update `TAM_PROJECT_STATE.md` and `CHANGELOG.md` | | those files | | Done on every substantive change (§50). |

Critical path: T-01 → T-05 → (T-10…T-13 ∥ T-20…T-22) → T-23 → T-30 → T-31 loop → T-40 → T-41 → T-42.

---

## 8. Out of scope for this run

Each item is deferred to the named spec phase. The listed seam must be left clean.

| Out of scope | Phase | Seam to leave |
|---|---|---|
| Operations workbench, schedule sync/provider/parser, diagnostics, fallback, server-upgrade CRUD, bulk template and import (§15-§25) | 3 | Tables exist (D-02). Routes return 501. Infrastructure tab is read-only. |
| BAMS provider (BLPAPI/simulated), polling, rules, alert lifecycle writes, notifications, global BAMS UI, metric trend charts (§26-§29) | 4 | Tables exist. Today and Infrastructure read seeded events. Recharts is reserved for this phase. |
| Excel import/export, DB download, restore, legacy migration, ChatGPT Bridge (§30, §37, §5 data portability) | 5 | Audit `source` enum already includes `Bulk Import` and `ChatGPT Bridge`. Routes return 501. |
| Bloomberg `{DRQS … <GO>}` link rendering (§38) | later | `RichText` component (D-16) |
| Settings for BAMS cadence, notifications, privacy mode, start with Windows (§39) | 4 / 6 | `app_meta` `setting.*` namespace |
| Windows desktop notifications (§28) | 4 | none |
| Production promotion; validation on the Bloomberg workstation (§56) | 6 / user | Packaging flags remain "untested on Windows" |
| Multi-user, auth/JWT/RBAC, vector DB/RAG, Docker/Terraform, health scores, sales fields, CMDB, support_cases UI | never (locked) | none |
| Creating tasks automatically from note Action Items | not planned | none |

---

## 9. Requirement coverage index (input to Phase 4.2)

The in-scope [§52] acceptance tests and the stories that own them:

| §52 test | Story |
|---|---|
| Today: overdue before upcoming | US-3.1 AC3 |
| Today: active BAMS alert actionable | US-3.1 AC4 |
| Today: near-term upgrade appears | US-3.1 AC5 |
| Today: click navigates | US-3.1 AC6 |
| Workspace: opens from Accounts | US-4.1 AC4 |
| Overview top open tasks | US-5.3 AC1 |
| Tasks tab filters to account | US-6.1 AC1 |
| Meeting note CRUD | US-7.3 AC1 |
| Call note CRUD | US-7.3 AC2 |
| General note CRUD | US-7.3 AC3 |
| Activity filters | US-7.2 AC1 |
| System events distinct | US-7.4 AC1 |
| Primary contact behaviour | US-8.2 AC1 |
| Infrastructure shows BAMS and upgrades | US-9.1 AC1 |
| Safety: DEV cannot open PROD | US-1.2 AC2 |
| Safety: second process blocked | US-1.3 AC1 |
| Safety: backup under WAL | US-1.6 AC2 |
| Safety: destructive creates backup | US-1.6 AC1 |
| Safety: no DB in release | US-12.2 AC1 |

Deferred §52 tests (reported as deferred, not failed): all Operations tests, all BAMS tests, and "imported malformed workbook does not partially write" (Phase 5).
