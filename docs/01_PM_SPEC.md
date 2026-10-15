# 01 PM Spec: TAM Command Center, Run 1 (Spec Phases 1-2)

| | |
|---|---|
| Author | pm-agent (Phase 1.1) |
| Date | 2026-10-12 |
| Source of truth | `docs/SPEC.md` (cited below as `§n`) |
| Process | `docs/TEAM_LOOP.md` |
| User confirmations | Q-1 to Q-5 (defaults behind D-01, D-04, D-07, D-08, D-12, D-22) were confirmed by the user on 2026-10-12. |
| Run 2 amendments | 2026-10-13, pm-agent: the user approved the mockups in `TAM_Command_Center/mockups/` (Today direction C, account workspace, accounts). Binding decisions D-26 to D-36 (§0) and the detail in §10. Where §3.1, §4.3, §4.5, US-3.x, US-4.1 or US-5.5 differ from §10, **§10 wins**. |
| Run 3 amendments | 2026-10-13, pm-agent: the user approved the mockups in `TAM_Command_Center/mockups/import/` (01..06) for account bulk import with duplicate detection. Binding decisions D-37 to D-48 (§0) and the detail in §11 (stories US-13.x, tasks T-80 to T-95). Where an earlier row of §8 says bulk import is out of scope, **§11 wins for accounts only**. |
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
| D-04 | **Today ranking.** Six tiers, defined exactly in §3.1 below. Every object lands in exactly one place: its highest qualifying queue tier, or else Upcoming. All due-today tasks share tier 2 and are sorted by priority inside it. *(Clarified 2026-10-13, D-32: inside tier 1, upgrades have no priority and rank after all tasks, by scheduled date; the sort is exactly `today_queue.sql`.)* | §7 says ranking is "roughly". This keeps Medium/Low due-today work from sinking below upgrades. |
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

| D-26 | **Today layout is direction C, "Triage Split"** (`mockups/today-C.html`). Left: a numbered list. Right: a detail pane for the selected item. Above both: a strip of summary chips that filter the list. Below: a tab bar for Upcoming, Recently changed and Account load (D-30). This replaces the two-column queue plus 360px right column of §4.3. Arrow keys move the selection. | User-approved 2026-10-13. One screen, one decision at a time, calm by default. Detail in §10.1. |
| D-27 | **The default list shows strictly the top 10 queue items across all tiers, in PM tier order** (the `queue` array order of `GET /api/today`, first 10). Everything else is behind "View all": the full queue, all tiers, no cap, tier headings as dividers. "View all" is also reachable from the chips (an "All" chip and each tier chip). The mockup's "Plan" chip (tiers 1-2 only, 7 rows) is **not** built. | User-approved. Strict cap = a bounded, calm screen. §10.1 has the chip set and URL state. |
| D-28 | **No "What to do" steps and no next-action field anywhere.** The detail pane shows: why it is here, account, type, due/event date with relative label, urgency, waiting-on/context, and a link to open the underlying object. The mockup's "Mark complete" button is **not** in the Today detail pane (see §10.1; flagged for the user). Nothing in this run adds a field to `tasks`, `clients` or any table to hold a next action. | User-approved. A "next action" field is a CRM-style construct (§55). The existing task drawer and row hover action already complete tasks. |
| D-29 | **The "done today N of M" progress ring is a real feature, tasks only.** M = plan tasks = non-archived tasks with `due <= T` on an Active (or no) account that are either still open or were completed today. N = the plan tasks completed today (a `completed` audit event inside today's local-day window and `status = Complete` now). N cannot exceed M by construction. The ring is live (no start-of-day snapshot), so M can change during the day. Served as `progress` on `GET /api/today`; **no schema change**. Exact rules, edge cases and SQL shape: §10.2. | User-approved with the definition delegated to the PM. Tasks are the only objects with a clean, auditable completion event; BAMS alerts and upgrades leave the plan by other lifecycles. A snapshot denominator would need a new table, which this feature does not justify. |
| D-30 | **Upcoming, Recently changed and Account load are tabs under the list** (mockup C "Later" bar), not a drawer. The tab bar is always visible and the panel is collapsed by default (click a tab to expand it, click it again to collapse). Account load keeps the US-3.4 rule: at most 8 rows plus an "All accounts" link (the mockup's "Account load (24)" count is the link text, not the row count). | User-approved. Keeps secondary context one click away without crowding the triage pair. |
| D-31 | **The visual refresh in `account-workspace.html` and `accounts.html` is approved:** layered header meters, due histogram, server tiles with sparklines, upgrade timeline, accounts tile strip with load bars, a servers-dots column, an activity-trend column. It is built **only from data derivable without schema changes**. §10.4 rules on each new datum (include, include with limits, or defer). `docs/02_DESIGN_GUIDELINES.md` §15 holds the visual rules; it deliberately replaces the Run 1 rules "single continuous context rail" and "no card-in-card". | User-approved. |
| D-32 | **Upgrade ranking inside tier 1 (answers the open question; D-04 stays valid).** Order: (1) open Critical BAMS alerts; (2) overdue tasks by priority High, Medium, Low, then due date ascending; (3) overdue upgrades, after all tasks, by `scheduled_date` ascending, then id. Upgrades have no priority, so they never interleave with tasks. This is exactly what `db/queries/today_queue.sql` and `frontend/src/data/mock/today.ts` already do (prio rank 3 for non-task kinds); no code change. Mockup C interleaves an upgrade between a High and a Medium task; the build follows this rule instead (§10.3, §10.5). | A deterministic total order with no invented priority. An overdue upgrade is still above every tier 2 item. If the user wants upgrades higher (e.g. right after Critical alerts), that is a one-line change in two files; it is listed under "needs a user decision" as optional. |
| D-33 | **Accounts "Needs attention" list is a transparent rule, not a score.** At most 4 accounts, only accounts with at least one signal, ordered by the lexicographic key in §10.4 (open Critical alert, overdue upgrade, overdue task count, open Warning alert, client touch due or overdue, then name). The reason text is built from the same signals. There is no health score, grade, colour ranking or composite number anywhere (§55, Run 1 rule stays). | The mockup needs an ordering; making it explicit keeps it testable and non-CRM. |
| D-34 | **The workspace "Do first for this account" panel is kept as "Top item for this account", with no steps and no Mark complete.** It shows the highest-ranked queue item (tiers 1-5 only) for the account, taken from the same `queue` array filtered by `client_id`, with title, why-it-is-here sentence, date, and an Open link. It is hidden when the account has none. | Consistent with D-28. Derived from the existing ranking, so it can never disagree with Today. |
| D-35 | **Mockups are illustrative; the spec wins.** The mockups' sample content, hand-written "why" strings, invented context (e.g. "3 terminals affected", ticket numbers), sort order and counts are not requirements. Every place a mockup deviates from this spec is listed in §10.5 with what the build does instead. QA reviews against §10, not against pixels. | Prevents the mockups from silently overriding tier logic (D-04, D-23, D-24, D-32). |
| D-36 | **Design rules are amended** in `docs/02_DESIGN_GUIDELINES.md` §15 and §2/§14: grouped panels replace the single-context-rail rule; one level of inset tiles replaces the no-card-in-card rule; instruments (meters, sparklines, histogram, ring, timeline track, chips) are allowed under strict calm rules (no gradients, no animation, text equivalents, status colours only). All new colour comes from existing tokens plus three solid tint-surface tokens. | Keeps the console Bloomberg-dark, dense but calm. |
| D-37 | **Run 3 (account bulk import) is approved** on the mockups `TAM_Command_Center/mockups/import/01..06`. The template and the import carry **core account fields only**, in this column order: A `Account name` (required), B `BPID`, C `Products`, D `Status`, E `Next contact date` (`YYYY-MM-DD`), F `Notes`. `Status` is a dropdown whose values are **exactly** those allowed by `clients.status` CHECK in `db/schema.sql`: `Active`, `Inactive`. The server holds one constant for them and a test pins it to the CHECK text, so template, validation and schema cannot drift. `Products` is free text (the column is `TEXT <= 500`; there is no products catalogue), so the mockup's "Products must be in the list" rejection (row 18, "Terminall") is **not built**. The template is generated per request with `openpyxl` (sheets `Instructions`, `Accounts`, hidden `Lists`) by `GET /api/import/accounts/template`. `openpyxl` becomes a **runtime dependency**: pinned in `server/requirements.txt` (with its own pinned transitive dependencies), and release packaging must install it (note for the next release, no packaging task here). Contacts, servers, tasks and notes (the `notes` table) are not imported. | The user's decision. A free-text field validated against an invented list would reject real data. One constant for Status removes a silent-drift risk. |
| D-38 | **Upload safety.** `.xlsx` **and `.csv`** (user amendment 2026-10-13; format decided by content sniffing AND extension, a mismatch is refused; CSV: UTF-8 with or without BOM, else Windows-1252, comma or semicolon (also tab/pipe) sniffed, quoted and multiline fields, every cell plain text so `=`/`+`/`-`/`@` text is data and our own export prefixes a `'`; Preview reports detected format, encoding and delimiter). For `.xlsx` the server never trusts the extension or the browser type: it checks the ZIP signature, a **file cap of 5 MiB** (a per-route override of the 2 MiB body cap, `payload_too_large` above it), and ZIP-bomb limits **before** `openpyxl` opens anything: at most 200 entries; total declared uncompressed size <= 50 MiB; any entry > 20 MiB or with a compression ratio > 100:1 is refused; encrypted, duplicate-named or traversal-named (`..`, absolute) entries are refused; any `<!DOCTYPE` or `<!ENTITY` in an XML part is refused (XML entity bombs). **Refused outright:** macro-enabled content (`vbaProject.bin`, a macro-enabled content type), external links (`xl/externalLinks/*`, any relationship with `TargetMode="External"`), embedded objects or ActiveX (`xl/embeddings/*`, `.bin` parts). Workbooks are opened `read_only=True, keep_links=False`. **Formulas are never evaluated and never read for their cached value**: a data cell (columns A-F, rows >= 2) that holds a formula makes **that row Invalid** ("formulas are not accepted; paste the value"); formulas elsewhere (Instructions sheet) are ignored. Every cell is data: text that merely starts with `=`, `+`, `-` or `@` is stored as text. Hard cap **500 non-blank data rows** (a row is non-blank when any of A-F holds non-whitespace); the 501st makes the **whole file** fail with `invalid_file` / `too_many_rows` ("This file has 812 account rows. The limit is 500 per import. Split the file and import it in parts."), nothing is previewed. The scan itself stops at 10,000 physical rows (a sheet padded with blank formatted rows is `too_many_rows` as well). | A user-supplied workbook is untrusted input (§37, §55). Cheap structural checks first keep the heavy parser away from hostile files. |
| D-39 | **Inspect / Preview / Apply (§37, §25). Nothing writes before an explicit Apply.** `POST .../inspect` parses, validates and matches, and stores the parsed rows **in server memory** (one import session per `import_id`, 60 minutes idle expiry, at most 3 sessions; lost on restart: `import_expired` 410, the user re-uploads). It returns counts (Valid, New, Updates, Needs review, Invalid), every row and its errors, and a `plan_hash`. It performs **no database write of any kind** (no audit, no backup). The user's decisions live in the browser until Apply. **Apply is one atomic transaction**: validate decisions (D-44), take a **safety backup** with the online backup API (`pre-import`, an automatic backup reason, retained with the other automatic ones per D-22), `BEGIN IMMEDIATE`, re-check `row_version` of every touched account, write all creates and fills, write **one `audit_events` row per created or updated account** (`category crm`, `object_type client`, `action created` or `updated`, `source 'Bulk Import'`, `reason` = `Bulk import: <file name>, row(s) N`), `COMMIT`. Any failure rolls back everything. A malformed workbook is refused at Inspect, so it can never partially write. No backup, no transaction and no audit rows when the plan changes nothing. Backup failure -> `backup_failed` 500 and nothing is written. **No schema change** (the `Bulk Import` source and `import` object type already exist; sessions are memory only). | §25 and §37 ("do not perform blind import"), §35, §36. |
| D-40 | **Name normalisation and exact match.** `exact_key(name)` = Unicode NFC, trim, collapse every whitespace run (including tab, CR, LF) to one space, `casefold`. Two names with the same `exact_key` are **the same account automatically**: a row that exactly matches an existing account is an **Update** (fill blanks, D-43) and needs no confirmation; two rows in one file with the same `exact_key` are merged automatically into the earlier row (the later row's values only fill blanks), because `clients.name` is unique case-insensitively and a second account of that name cannot exist. `match_key(name)` (used for similarity) = NFKD, drop combining marks (accents), casefold, `&` -> ` and `, delete `.` and `'` without a gap (`L.L.C.` -> `llc`, `O'Brien` -> `obrien`), every other non-alphanumeric character -> space, split into tokens. **Noise tokens** are then dropped: `ltd limited inc incorporated llc llp lp plc group holdings holding the co company corp corporation and sa ag gmbh nv bv pty pte srl`. What remains is the **core**; if the core would be empty (a name made only of noise words) the unfiltered tokens are the core. The stored name is the trimmed value with whitespace runs collapsed to one space; control characters are never stored. | The user's liberal-matching rule, made deterministic. Exactness stays strict (case, spacing) so an automatic merge is never a surprise. |
| D-41 | **Similarity algorithm (deterministic; no network, no external service, no randomness, no locale).** Compare two names A and B by their cores. *Token equality* of tokens x, y: identical; or **abbreviation** (shorter has >= 3 characters, the same first letter, is a subsequence of the longer, and the longer is >= 2 characters longer: `mgmt`/`management`, `intl`/`international`); or **near-spelling** (Damerau-Levenshtein, restricted/optimal-string-alignment form: both tokens >= 5 characters and distance <= 1 for length 5-8, <= 2 for length >= 9; tokens of 4 characters or fewer must be identical). A **split word** also pairs: two adjacent tokens of one name whose concatenation is identical to one token of the other name (`bright water` / `brightwater`) pair with that token. Tokens are paired one-to-one, greedily by best kind (identical, then split word, then abbreviation, then near-spelling), ties broken by position. *Strong* key words are matched tokens of >= 3 characters that are not in the **weak list** (`capital partners management mgmt asset assets investment investments global international financial finance bank fund funds trust securities insurance services advisory advisors markets trading pension credit union mutual reinsurance`); weak words alone never flag. A candidate is produced when **any** of these rules fires: **R1 same core** (core token sequences are identical); **R2 same words, different spelling** (every token of the longer core is paired, at least one pair is not identical); **R3 contained name** (every token of the shorter core is paired, the longer core has more tokens, and the shorter core contains at least one strong word); **R4 shared key words** (>= 1 strong paired token); **R5 spelling of the whole name** (the cores joined with single spaces are >= 6 characters and their optimal-string-alignment distance <= `floor(length of the longer / 6)`, minimum 1); **R6 same BPID** (BPIDs equal after trim and `casefold`, both non-blank, on a different name). Thresholds and both word lists are constants in one module (`server/dupes.py`) covered by golden tests; changing one is a PM-visible change. Complexity: an inverted index on core tokens plus a length-bucket scan for near-spelling keeps 500 rows against 5,000 accounts well under 2 seconds. | Liberal on purpose: a false flag costs one click, a missed duplicate costs a dirty account list. Single weak words ("Capital", "Fund", "Trust") are excluded because they would flag half the portfolio. |
| D-42 | **How a match is explained: reasons, three words, no numbers.** Every candidate carries `strength` in `High`, `Medium`, `Low`, a `reasons[]` list and a `differences[]` list. **There is no percentage, score or number-of-points anywhere**, in the API or the UI (this supersedes "Similarity 88%" in mockup 06). Reasons are fixed backend-generated sentences, so the import review and the Add dialog read identically: `same_core_name` "Same name once words like Ltd, Inc or Group are ignored"; `same_words_spelled_differently` "Same words, spelled differently: {a} / {b}"; `abbreviation` "{short} may be short for {long}"; `contained_name` "Every word of {shorter} also appears in {longer}"; `shared_key_words` "Shares key word(s): {w1}, {w2}"; `similar_spelling` "Similar spelling"; `same_bpid` "Same BPID: {bpid}"; `exact_name` (existing account only) "Same name (case and spacing ignored)". `differences[]` holds `different_bpid` "Different BPID: file {x}, existing {y}" (shown, never used to hide a candidate). **Strength is a fixed table, highest applicable wins:** *High* = R1, or R6, or R2; *Medium* = R3, or R5, or R4 with >= 2 strong paired words; *Low* = R4 with exactly one strong paired word and no other rule. When R3 fires, `shared_key_words` is not repeated. Candidates are ordered High, Medium, Low, then by number of reasons (more first), then name (casefold), then id; at most 5 are returned per row. | The user asked for strength with reasons and no score. Because strength is a lookup, a tester can predict it by hand. |
| D-43 | **Decisions and merge semantics.** Every flagged row (candidates present, not an exact match) needs one of: **Same account** (merge into the chosen candidate, an existing account or an earlier row of the file), **Different account** (create as a new account), **Skip**. There is **no default** selection; the UI never pre-selects. With more than one candidate, "Same account" requires the user to pick which one (`target`). **Merge = fill blanks only:** a field of the target that is NULL or empty is set from the row; a non-blank target value is never changed, appended to, or replaced (not even `Notes`). The preview and the result show, per row, `fills` (field -> value that will be written) and `kept` (field -> existing value that wins, with the file value alongside when they differ). `Status` is never blank on an existing account, so it is always kept; for a new account a blank Status means `Active`. **Same account onto an Inactive existing account:** allowed, blanks filled as usual, **the account stays Inactive** (never reactivated by an import, whatever the file's Status says); the row shows the note "Existing account is Inactive and stays Inactive". Exact matches onto Inactive accounts behave the same. In-file chains: a later row merged into an earlier row follows that row's own resolution (into the same existing account, or into the same new account); the earlier row's values win over the later row's, existing values win over both. "Same account" onto an earlier row that is Invalid or marked Skip is refused (the UI disables it, the server returns 422). | The user's decision (3). |
| D-44 | **Apply is guarded twice.** (a) *Unresolved:* any flagged row without a valid decision -> **409 `unresolved_duplicates`** listing the rows; nothing happens (no backup). (b) *Stale plan:* at Apply the server **re-runs the whole validation and matching** against the current database and recomputes `plan_hash` (a hash over, per row: state, candidate ids or row refs, fills, and the `row_version` and name of every matched or candidate account). A different hash -> **409 `preview_stale`** (an account changed, was deleted or created since Preview; also a stale `row_version`). The UI then fetches the refreshed plan, keeps decisions for rows whose candidate set is unchanged, and asks again for the rest. The `row_version` of each touched account is checked **again inside the write transaction**. Decisions are re-validated against the fresh candidates (a `target` that is no longer a candidate -> `preview_stale`, an unknown row or a decision on a non-flagged row -> 422). A second Apply of the same `import_id` -> 409 `already_applied` with the stored result. | "The server must re-run matching at Apply time and re-validate decisions." |
| D-45 | **Single add uses the same engine** (`server/dupes.py`). `POST /api/client/check-similar` returns `exact` and `candidates` (same shapes as the import). The Add account dialog calls it on submit and on name blur; when there are candidates it shows the panel of mockup 06 (existing account facts, reasons, strength word) and requires one of **Same account** (closes the dialog, **discards the typed values**, opens the existing account's workspace; nothing is written), **Different account** (creates it), **Cancel** (back to the form). An exact name match offers only Same account and Cancel (a second account of that name cannot exist, `conflict`). The server enforces it: `POST /api/client/save` without an id now returns **409 `possible_duplicate`** (with the candidates) unless the body carries `duplicates_confirmed: true`; this is raised as **PM-AC-4** in `docs/qa/API_CHANGE_REQUEST.md` because it changes a frozen route's behaviour (backend decides the final form and updates the existing tests). | One duplicate rule everywhere; a bypassed UI cannot create a near-duplicate silently. |
| D-46 | **The result page offers "Download skipped rows"**: `GET /api/import/accounts/{import_id}/skipped.xlsx` (an `.xlsx`, same engine as the template). One `Accounts` sheet with the six import columns in the original order plus `Source row` and `Reason` (and `Possible duplicate of` when the user skipped a flagged row). Values are written as typed strings (never as formulas), so the file can be corrected and re-imported (columns after F are ignored with a warning). It contains invalid rows and rows the user marked Skip; the endpoint is available for 24 hours or until restart. | The user's decision (5). |
| D-47 | **Edge-case rulings.** Blank rows: ignored, not counted, not reported; row numbers always match the Excel sheet. Trailing/leading spaces: trimmed silently. Name longer than 200, BPID > 32, Products > 500, Notes > 20000: the row is **Invalid** with a clear message (never truncated), and an invalid row takes no part in matching. Header row: row 1, matched by name (case-insensitive, trim, a trailing `*` ignored), any column order; `Account name` is required, a missing optional header is fine, an unknown extra column is ignored with a file-level warning, a duplicated header is `invalid_file`; the sheet must be named `Accounts` (case-insensitive) else `invalid_file` / `sheet_missing` with the sheet names found. Dates: a real Excel date, or text exactly `YYYY-MM-DD` that is a real calendar date; any other text or a bare number is Invalid ("Next contact date: use YYYY-MM-DD"); a time part is dropped. Status: matched case-insensitively and stored in canonical case; anything else is Invalid, naming the allowed values. BPID typed as a number is converted to text without a trailing `.0`; non-integer numbers and booleans are Invalid; the template formats column B as text so leading zeros survive. Duplicate BPID inside the file: same BPID on two rows with different names flags the later row against the earlier (R6); same BPID with the same name merges as an exact in-file duplicate. A BPID that equals another existing account's BPID on an exact-name Update is a row warning, not a flag. A file BPID that differs from the matched account's BPID is kept-existing with a `different_bpid` note. Two new rows that collide after normalisation ("ACME, Inc." / "Acme Inc") are flagged against each other (R1, High); they are not exact, so never auto-merged. **Re-importing the same file is idempotent**: every row now exact-matches, matched rows with nothing to fill are `unchanged` (no write, no `row_version` bump, no audit), and a second import changes nothing. Rows that were earlier merged or created as "Different" with a merely similar name are asked again (decisions are not remembered; remembering would need a schema change and is out of scope). | Closes every case in the user's list. |
| D-48 | **Where the approved mockups differ from this spec, the spec wins (as D-35).** (1) Mockup 06 shows "Similarity 88%"; the build shows the strength word and reasons only (D-42). (2) Mockups 02/03 show a Products list and reject "Terminall"; Products is free text (D-37), so that row is valid. (3) The mockup's Updated tile counts every matched row; the build separates **Updated** (at least one field filled) from **Unchanged** (matched, nothing to fill). (4) The "View in Settings, Activity" link on the result page is built only if a screen that lists audit events exists; otherwise it is omitted. (5) Sample counts, names and file sizes in the mockups are illustrative. Out of scope, still: importing contacts, servers, tasks or notes; `.xls`, `.xlsm`; export; restore; remembering duplicate decisions; renaming an account through the similarity check; any merge that deletes or re-parents an account's contacts, tasks or notes. | Keeps the build testable. |

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

**US-3.1** Today is the default landing page and shows a prioritized work queue. *Trace:* §7, D-04, D-05. *(Run 2: the layout and default list are superseded by D-26/D-27 and US-3.6 to US-3.9 in §10.7. The ranking ACs below still hold.)*
- AC1: Queue items are ranked by the tiers in §3.1 below.
- AC2: Each item shows the account, type label, title, urgency/status, date with a relative label, and context (waiting owner, server, or metric).
- AC3 **[§52]**: An overdue task appears before a normal upcoming task.
- AC4 **[§52]**: An active BAMS alert (seeded) appears as an actionable item.
- AC5 **[§52]**: A seeded upgrade within 14 days appears in the queue.
- AC6 **[§52]**: Clicking an item navigates to the underlying object, following the route table in §4.2. Pressing Enter on a focused item does the same.
- AC7: The landing page honours the "default landing page" setting.

**US-3.2** *(Run 2: shown as a tab under the list, D-30.)* Upcoming shows the next 14 days of obligations (30 days for upgrades), excluding anything already in the queue. *Trace:* §7.
- AC1: Items are grouped by date ("Tomorrow", then weekday or date headings) and include tasks, next client touches and server upgrades.

**US-3.3** *(Run 2: shown as a tab under the list, D-30.)* Recently Changed shows the latest 20 account-level changes as one-line sentences. *Trace:* §7.
- AC1: The list includes note created, task completed, upgrade updated, BAMS alert opened, recovered or closed, and contact changed. Settings and backup events are excluded.
- AC2: Clicking a row opens that account's Activity tab.

**US-3.4** *(Run 2: shown as a tab under the list, D-30.)* Account Load is a compact table below the queue. *Trace:* §7.
- AC1: Columns are Account, Open, Overdue, Waiting, Alerts and Next Contact. Rows are sorted by overdue (descending), then open (descending). At most 8 rows are shown, with an "All accounts" link.
- AC2: Clicking a row opens the account Overview.
- AC3: The table is visually subordinate to the queue (smaller heading, lower position).

**US-3.5** Today refreshes on the "dashboard auto-refresh" setting (Off/1/5/15 min) and after every mutation. *Trace:* §39.

### E4 Accounts directory (§8)

**US-4.1** Accounts is a dense, sortable table. *Trace:* §8. *(Run 2: columns and the tile strip are amended by D-31 and US-4.2 in §10.7.)*
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

**US-5.5** The context column is a grouped panel (D-31, D-36; guidelines §15) that shows the following. *(Run 1 wording was "a continuous context rail, one surface with internal dividers, not separate cards"; superseded.)* *Trace:* §10.
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
| 1 | Overdue / Critical | Task with `due < T`; BAMS event `status=open` with `severity=Critical`; upgrade with `scheduled_date < T` and status not in (Completed, Deferred) | Critical alerts first, then tasks by priority High→Low then date ascending, then upgrades by date ascending (D-32) |
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
> **Superseded in Run 2 by D-26 and §10.1** (Triage Split). The wireframe below is kept for history; do not build it. Tier headings, the six-column row and the 360px right column no longer exist.

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
> **Amended in Run 2 by D-31, D-34, D-36 and §10.4.** The header gains meters, Overview gains a due histogram, server tiles and an upgrade timeline, and the context rail becomes a grouped panel. Routes, tabs, URL state and breakpoints below still hold.

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
| **Run 2 (D-26 to D-36):** `TriageList`/`TriageRow`, `TriageDetail`, `SummaryChips`, `ProgressRing`, `LaterTabs` | Today | §10.1, guidelines §15. Replace `QueueList`/`QueueRow`/`UpcomingList` layout (the data components are reused inside `LaterTabs`). |
| **Run 2:** `GroupedPanel`, `Tile`, `MeterBar`/`StackBar`, `Sparkline`, `DueHistogram`, `TimelineTrack`, `TileStrip`, `DotRow` | Workspace, Accounts, Today | Pure presentational, props in, no data fetching. Each has a text equivalent (§15.5). |
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

**Run 2 task board (2026-10-13; D-26 to D-36).** No packaging or release tasks. Owners as above. Paths relative to repo root. Every task also ends with T-50 (state and changelog).

| ID | Phase | Owner | Task | Inputs | Outputs | Depends on | Definition of done |
|---|---|---|---|---|---|---|---|
| T-60 | R2-1 | PM | Record D-26 to D-36, guidelines §15, API change requests, state and changelog | user approval | this doc §10, `02_DESIGN_GUIDELINES.md`, `qa/API_CHANGE_REQUEST.md`, state, changelog | none | **Done 2026-10-13.** |
| T-61 | R2-2 | DA | Seed and query support. (a) `db/seed_mock.py`: add today's `task.completed` audit rows covering the §10.2 cases (several plan tasks completed today; one completed then reopened; one completed today that was due in the future; one completed today with `due` NULL; one completed on an Inactive account; one completed yesterday); keep the seed deterministic and relative-dated. (b) `bams_metric_samples` for at least 3 servers across 7 days (4-hourly is enough) including one with an open alert on a non-CPU metric and one server with no samples. (c) `db/queries/day_progress.sql` reference query for `progress`; `db/queries/activity_trend.sql` for the 14-day per-account series. (d) Document both in `03_DATA_MODEL.md`. **No schema change** (if the DA finds one is needed, write `docs/qa/SCHEMA_CHANGE_REQUEST.md` and stop). | §10.2, §10.4 | the files listed | T-60 | Seed verifier and `db/tests` pass; `sql_safety_scan.py` 0 violations; query output on the seed matches a hand-computed table in the doc; index use confirmed with `EXPLAIN QUERY PLAN` (`ix_audit_ts`, `ix_audit_client_ts`, `ix_bams_metric_samples_metric_ts`). |
| T-62 | R2-3 | BE | `progress` on `GET /api/today`: `{day, total, done, open, done_other}`, local-day UTC window computed in Python from the same `today` the endpoint returns (DST-safe, §10.2), executing `day_progress.sql`. Update `docs/04_API_CONTRACT.md`. | T-61(c), PM-AC-1 | `server/` | T-61 | pytest: every §10.2 case; a DST day (23h and 25h) test with an injected timezone; midnight boundary; `done <= total` property test; ranking output of `queue` unchanged (existing tests untouched). |
| T-63 | R2-3 | BE | `GET /api/accounts/activity-trend?days=14` (PM-AC-2) using `activity_trend.sql` (same union as `activity_timeline.sql`, bucketed by local day). | T-61(c) | `server/`, contract doc | T-61 | pytest: bucket edges, deleted notes, Inactive accounts excluded by default, accounts with no activity return 14 zeros. |
| T-64 | R2-3 | BE | Per-server tile data in `GET /api/client/{id}/infrastructure` (PM-AC-3): `environment`, `version`, `spark` (metric name, window, up to 28 points) or null, per distinct server name, rules in §10.4. | T-61(b) | `server/`, contract doc | T-61 | pytest: alert-metric choice, CPU fallback, server with upgrade rows only (no spark), server with no samples (spark null), points never exceed 28, no sample rows loaded outside the window (§45). |
| T-70 | R2-4 | FE | Tokens and instruments: the three `--surface-*` solid tint tokens and layout tokens (§15.2), `GroupedPanel`, `Tile`, `MeterBar`/`StackBar`, `Sparkline`, `DueHistogram`, `TimelineTrack`, `ProgressRing`, `SummaryChips`, `DotRow`, each with its text equivalent; sandbox page entries. | guidelines §15 | `frontend/src/components/ui`, `styles/tokens.css` | T-60 | Vitest per component (props to DOM, a11y name present, no inline colours); repository guards still pass (no raw hex outside `tokens.css`, plus a new guard: no `gradient(`, no `backdrop-filter`, no `animation`/`@keyframes` in `src/`). |
| T-71 | R2-4 | FE | Today Triage Split: chips, top 10, View all, `?show=` URL state, arrow-key list, detail pane (why sentences, key facts, open link), progress ring, `LaterTabs`. Remove the old right column. | §10.1, §10.2 | `frontend/src/pages/TodayPage.tsx` and children | T-70, T-72 | Vitest + App tests for every AC in US-3.6 to US-3.9; keyboard matrix test; no `steps`, "What to do" or "Mark complete" string exists in the Today components (guard test). |
| T-72 | R2-4 | FE | `MockDataSource` parity: `progress` (same rules as `day_progress.sql`), activity trend, tile spark, built over `mock_data.json`; extend `today.test.ts` parity to the new fields on three dates. | T-61 | `frontend/src/data/mock/` | T-61 | Parity tests prove TS equals the reference SQL on the seed for `progress` and `activity_trend`. |
| T-73 | R2-5 | FE | Workspace refresh: layered header meters, due histogram, server tiles, upgrade timeline, "Top item" panel, grouped context panel, breakpoints. | §10.4, §10.5 | `frontend/src/pages/workspace/` | T-70, T-72, T-64 | Vitest for each derivation (meter exclusivity, histogram bins, timeline clamping, tile fallbacks); screenshots at 1440, 1280, 1024, 768. |
| T-74 | R2-5 | FE | Accounts refresh: tile strip, load bars, servers dots, next upgrade/contact pills, activity trend column, Needs attention list (D-33). | §10.4 | `frontend/src/pages/AccountsPage.tsx` | T-70, T-72, T-63 | Vitest for the attention ordering key (all tie-breaks) and for column sorting; US-4.1 AC1-AC5 still pass. |
| T-75 | R2-5 | FE | `ApiDataSource` wiring for the three additive fields; contract tests against the live DEV backend. | T-62..T-64 | `frontend/src/data/` | T-62, T-63, T-64, T-71, T-73, T-74 | Adapter tests; one e2e run driving Today, a workspace and Accounts on the live DEV backend. |
| T-76 | R2-6 | QA | Run 2 gate: verify D-26 to D-36 and every AC in §10.7; ring edge cases against a real DB; tier order and the D-32 rule; instrument accessibility (text equivalents, contrast, reduced motion, keyboard); guideline greps (hex, gradients, blur, animation, native select); screenshots at four widths. | all | `docs/qa/ERROR_LOG_<n>.md` | T-62..T-75 | Verdict line present; loop to PASS (0 open Blocker/High). |
| T-77 | R2-7 | PM | Update the traceability matrix with the Run 2 rows and re-validate. | T-76 PASS | `docs/05_TRACEABILITY.md` | T-76 | No FAIL or MISSING for in-scope Run 2 items. |

Run 2 critical path: T-60 → T-61 → (T-62 ∥ T-63 ∥ T-64 ∥ T-70) → T-72 → (T-71 ∥ T-73 ∥ T-74) → T-75 → T-76 → T-77.

Critical path: T-01 → T-05 → (T-10…T-13 ∥ T-20…T-22) → T-23 → T-30 → T-31 loop → T-40 → T-41 → T-42.

---

## 8. Out of scope for this run

Each item is deferred to the named spec phase. The listed seam must be left clean.

| Out of scope | Phase | Seam to leave |
|---|---|---|
| Operations workbench, schedule sync/provider/parser, diagnostics, fallback, server-upgrade CRUD, bulk template and import (§15-§25) | 3 | Tables exist (D-02). Routes return 501. Infrastructure tab is read-only. |
| BAMS provider (BLPAPI/simulated), polling, rules, alert lifecycle writes, notifications, global BAMS UI, metric trend charts (§26-§29) | 4 | Tables exist. Today and Infrastructure read seeded events. Recharts is reserved for this phase. |
| Excel **export**, DB download, restore, legacy migration, task/action tracker import, ChatGPT Bridge (§30, §37, §5 data portability). **Account bulk import is now in scope (Run 3, D-37 to D-48, §11).** | 5 | Audit `source` enum already includes `Bulk Import` and `ChatGPT Bridge`. Routes other than `/api/import/accounts/*` return 501. |
| Run 3: **importing contacts, servers (§25 Bulk Server Upgrade), tasks or notes**, `.xls/.xlsm` upload, duplicate-decision memory, merging two existing accounts, rename similarity check, packaging of the new `openpyxl` dependency | 3 / 5 / later | Import engine and the duplicate engine (`server/dupes.py`) are written account-agnostic enough for the later server import to reuse the workbook reader. No packaging task in Run 3; release notes must say `openpyxl` is now required. |
| Bloomberg `{DRQS … <GO>}` link rendering (§38) | later | `RichText` component (D-16) |
| Settings for BAMS cadence, notifications, privacy mode, start with Windows (§39) | 4 / 6 | `app_meta` `setting.*` namespace |
| Windows desktop notifications (§28) | 4 | none |
| Production promotion; validation on the Bloomberg workstation (§56) | 6 / user | Packaging flags remain "untested on Windows" |
| Multi-user, auth/JWT/RBAC, vector DB/RAG, Docker/Terraform, health scores, sales fields, CMDB, support_cases UI | never (locked) | none |
| Creating tasks automatically from note Action Items | not planned | none |
| Run 2: "What to do" steps, any next-action field, a Mark complete button in the Today detail pane, per-account health or attention scores, a historical open-load trend (needs snapshots, a new table), a frozen start-of-day plan snapshot for the ring, "terminals affected" and other invented mockup context | not planned / needs user decision | none; see §10.4 and §10.5 |

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


---

## 10. Run 2: Today triage and visual refresh (D-26 to D-36)

Approved by the user on 2026-10-13 after reviewing `TAM_Command_Center/mockups/` (`today-C.html`, `account-workspace.html`, `accounts.html`). The mockups are not edited. Visual rules are in `docs/02_DESIGN_GUIDELINES.md` §15.

### 10.1 Today: Triage Split

```
Today · Tue 13 Oct 2026                    (ring) 3 of 8 tasks done      Last refreshed 14:05 ⟳
[ Top 10 ] [ Overdue / critical 6 ] [ Due today 5 ] [ Alerts 7 ] [ Waiting 14 ] [ Upgrades 8 ] [ Next 3 days 28 ] [ All 68 ]
┌ list (420px) ───────────────┐┌ detail pane ───────────────────────────────────────┐
│ 1 ▌ CPU sustained at 96%…  ││ ▌ BAMS alert · Overdue / Critical          [Critical]│
│     Castellan Peak  opened ││ CPU sustained at 96% on bxa-ln-02                    │
│ 2 ▌ Send entitlement…      ││ Castellan Peak Global Markets                        │
│ …                           ││ WHY IT IS HERE          │ KEY FACTS                  │
│ 10                          ││ Critical alert, still   │ Account / Type / Opened /  │
│ Showing 10 of 68  View all ›││ open. Critical alerts…  │ Urgency / Context          │
└─────────────────────────────┘│ [ Open infrastructure → ]            ↑↓ moves · Enter opens │
Later  [Upcoming (11)] [Recently changed (20)] [Account load]     (collapsed by default)
```

**Chips (`SummaryChips`).** One row, in this order, each showing a label and the count of the **full** queue for that scope (counts are never capped):

| Chip | Scope | Label source |
|---|---|---|
| Top 10 (default) | first 10 items of the queue array | count shown is `min(10, queue length)` |
| Overdue / critical | tier 1 | tier label |
| Due today | tier 2 | tier label |
| Alerts | tier 3 | short form of "Infrastructure alerts" |
| Waiting | tier 4 | short form of "Waiting / follow-up" |
| Upgrades | tier 5 | short form of "Upgrade actions" |
| Next 3 days | tier 6 | the spec tier label is "Upcoming tasks"; the chip says "Next 3 days" so it is not confused with the Upcoming **tab** (which is a different window, D-05) |
| All | the full queue | |

- Chips are a single-select group (`role="radiogroup"`, roving tabindex, Left/Right arrows). Empty tiers stay visible with a muted `0` and are not selectable. State is in the URL as `?show=top|all|t1..t6` (default `top`; unknown values fall back to `top`), so Back and reload keep it.
- A tier chip lists **every** item of that tier (the list scrolls inside its panel; no cap, no "Showing 7 of 11" truncation). `All` lists the whole queue with tier headings as dividers (`--fs-label`, with counts). `Top 10` has no headings; each row carries a tier colour bar instead.
- The footer under the list reads "Showing N of M" and, on `Top 10` only, a "View all (M)" link that sets `?show=all`. "Show everything" in the mockup is this link.
- The list contains **only queue items**. Upcoming-only objects never appear in it.

**List rows.** Number (position within the current list, 1-based), tier colour bar (3px; tier 1 danger, 2 accent, 3 warning, 4 warning, 5 info, 6 neutral, matching the mockup), title (ellipsis, full text in `title`), account name below it (muted), and on the right the date label ("3d overdue", "Today", "opened 09:12", "19 Oct") with `--fs-sm` tabular numerals. One badge at most, per guidelines §4. Row height 44px.

**Selection and keyboard.** The list is `role="listbox"`; rows are `role="option"`; the listbox is focusable and uses `aria-activedescendant`.

| Key | Effect |
|---|---|
| Down / Up | Move the selection one row; no wrap |
| Home / End | First / last row |
| Enter | Open the selected item's underlying object (the §4.2 target) |
| Left / Right when focus is on a chip | Move between chips |
| Click on a row | Select it (does not navigate) |
| Double-click on a row | Open the object |

The first row is selected on load and whenever the chip changes. After a refresh the selection stays on the same `(kind, id)` if it is still in the list, otherwise on the row now at the same index (clamped). Selection is not stored in the URL.

**Detail pane (`TriageDetail`) shows exactly these fields, all taken from the existing `QueueItem` (no new API fields):**

| Field | Source |
|---|---|
| Header: type label and tier label, optional status/priority/severity badge, title, account name | `type_label`, `tier_label` (frozen labels), `priority`/`severity`/`status`, `title`, `client_name` (account name links to the workspace; "No account" for unassigned tasks) |
| Why it is here | A sentence generated by the frontend from `tier`, `urgency`, `priority`, `severity`, `days_delta`, `date`, `context`. Table below. |
| Key facts | Account; Type; the date with its kind label ("Due", "Next update", "Next client touch", "Opened", "Scheduled") and relative text; Urgency (tier label); Priority, Severity or Status when present; Context (Waiting on …, Next Client Touch, alert message, upgrade summary) when present. Facts that are null are omitted, never shown as blank. |
| Open link | One primary button, "Open task", "Open account" or "Open infrastructure", to the §4.2 target. Enter does the same. |

It shows **no steps, no next-action text, no Mark complete** (D-28). The pane footer hint is "Up/Down moves · Enter opens".

Why-it-is-here sentences (deterministic, frontend constants; `{…}` filled from the item):

| `urgency` (and kind) | Sentence |
|---|---|
| `critical` | "Open Critical alert on {server_name}. Critical alerts always rank first." |
| `overdue` (task) | "Overdue: due {date}, {n} days ago. {Priority} priority." |
| `overdue` (server_upgrade) | "Upgrade scheduled for {date}, {n} days ago, and not Completed or Deferred." |
| `due_today` | "Due today. {Priority} priority." |
| `alert` | "Open {severity} alert on {server_name}." |
| `recovered` | "Alert recovered and waiting to be closed." |
| `waiting` | "Waiting{ on {waiting}}. Next update {date or "is not set"}." |
| `follow_up` | "Next client touch is due {date}." |
| `upgrade` | "Upgrade scheduled for {date}, within 14 days." or, for status Exception, "Upgrade exception: needs attention at any date." |
| `validation` | "Upgrade needs validation: {Validation Required / validation Failed / Completed with validation Pending}." |
| tier 6 task (`upcoming` with a tier) | "Due {date}, within the next 3 days." |

Plural and singular are handled ("1 day ago"). A missing value drops its clause rather than printing a placeholder.

**States.** Loading: skeleton list rows and a skeleton pane. Empty queue: the list panel reads "Nothing needs attention." plus "Next item: {first Upcoming}" when one exists; the detail pane is hidden; the ring and chips still render. Error and stale banners per guidelines §12.

**Layout.** Content max width 1240px. List 420px and detail fluid; below 1200px the list is 340px and the detail's two columns stack; below 900px the detail pane moves under the list and is no longer sticky. The detail pane is sticky below the top bar on wide screens. Primary work (the list and the detail) is never hidden or collapsed (§44).

**Later tabs (D-30).** `role="tablist"` with Upcoming (n), Recently changed (n), Account load. `aria-selected` on the open tab; none selected means collapsed. Panel contents reuse US-3.2, US-3.3, US-3.4 unchanged except Account load shows at most 8 rows. Items in the Upcoming tab link to their object exactly as queue items do.

### 10.2 The "done today" progress ring (D-29)

**What it is.** A small ring plus text "N of M tasks done" in the Today header. It counts tasks only. BAMS alerts, upgrades and client touches are never in the ring (they are cleared by other lifecycles, and tier 1/2 non-task items still appear in the list and chips).

**Definitions.** `T` = the server's local date (D-06). Window = `[local midnight of T, local midnight of T+1)` converted to UTC instants. The backend converts each of the two local midnights separately, so a 23-hour or 25-hour DST day is exact. All times come from the same clock/timezone the endpoint uses for `today`.

| Term | Rule |
|---|---|
| Plan task | A task with `due IS NOT NULL AND due <= T` whose account is Active or null, and that is either **open** (status not Complete, `archived = 0`) or **done today**. These are exactly the tier 1 and tier 2 tasks, plus tasks that were in them and have since been completed. |
| Done today (N) | A plan task with `status = 'Complete'` now AND at least one `audit_events` row with `object_type='task'`, `object_id=task.id`, `action='completed'`, `timestamp` inside the window. Counted once per task however many times it was completed. Source (`GUI`, `System`, `Bulk Import`…) is ignored. `archived` is ignored for done tasks (completing then archiving still counts). |
| Open (R) | Plan tasks that are open now. |
| Total (M) | `N + R`. |
| done_other | Tasks completed today under the same rules but not in the plan (`due > T` or `due IS NULL`). Not in the ring; shown only in the ring's tooltip as "+K other tasks completed". |

**Can N exceed M?** No. M is defined as N + R, so `N <= M` always. M is **live** and can move during the day: it grows when a task is created or re-dated into the plan, and shrinks when an open plan task is re-dated to the future, archived, deleted, or its account becomes Inactive. N falls when a completed task is reopened (it returns to R and M is unchanged). The ring fraction is `N / M`.

**Why live, not a start-of-day snapshot.** A frozen denominator needs a stored snapshot (a new table or an `app_meta` blob), which is a schema/persistence cost for a cosmetic benefit. The live rule never lies about what is still open. This is a deliberate trade-off; if the user wants a frozen M, it needs a schema change request.

**Display rules.**
- `M = 0`: no ring; text "No tasks due today". `N = M > 0`: full ring with a check and "All done" in addition to "N of M". Otherwise the ring fills `N/M` in `--accent` over a `--surface-3` track. Never red/green: it is progress, not alarm. The text "N of M tasks done" is always present (the ring is decorative, `aria-hidden`; the text carries the meaning, plus `role="img"` `aria-label` on the group only if the text is visually hidden at narrow widths).
- It refreshes with Today (auto-refresh and after every mutation). When the local date changes (`today` in the payload differs from the previous one, or the tab becomes visible on a new day) Today refetches immediately, which resets the ring at local midnight.
- A completed-then-reopened task is not counted. A task completed yesterday and reopened and completed again today is counted today.

**Edge cases the tests must cover:** completed today then reopened; completed today with `due` in the future (done_other); completed today with `due` NULL (done_other); completed on an Inactive account (excluded); completed and archived (counted); deleted after completing (not counted; the task row is gone); completed yesterday 23:30 local vs today 00:30 local, in a non-UTC timezone; a DST day; `M = 0`; `N = M`. Known limit: the plan test uses the task's **current** `due`; if a user clears the due date while completing, that completion counts as done_other. Accepted.

**API (additive, PM-AC-1).** `GET /api/today` gains:
```json
"progress": {"day": "2026-10-13", "total": 8, "done": 3, "open": 5, "done_other": 1}
```
`day` echoes `today`. No existing field changes. Reference query: `db/queries/day_progress.sql` (T-61), parameters `:today`, `:day_start_utc`, `:day_end_utc`. It uses `ix_audit_ts` for the range and primary-key lookups on `tasks`. **No schema change is required, so `docs/qa/SCHEMA_CHANGE_REQUEST.md` is not created.**

### 10.3 Ranking inside tier 1 (D-32) and D-04 consistency

The full tier 1 order is the `ORDER BY` in `db/queries/today_queue.sql` (and the mirrored comparator in `frontend/src/data/mock/today.ts`):

1. open Critical BAMS alerts, by `opened_at` ascending, then id;
2. overdue tasks: priority High, Medium, Low, then `due` ascending, then id;
3. overdue upgrades (`scheduled_date < T`, status not Completed or Deferred): `scheduled_date` ascending, then id.

Upgrades have no priority field, so they are never ranked against task priorities. D-04 (six tiers, one tier per object, tier 2 sorted by priority then title, "first qualifying tier") is unchanged; only the previously unstated tier 1 upgrade position is now written down. No code change is needed. The parity test in `today.test.ts` already pins this.

Tier 2 note: within equal priority the order is **title ascending**, not insertion order (mockup C lists "Prepare QBR agenda" before "Confirm terminal count for renewal"; the build lists "Confirm…" first).

### 10.4 Rulings on new derived data (D-31, D-33)

Verdicts: **Include** = built from existing tables/columns with no schema change. **Include (limits)** = built with the stated limits. **Defer** = not built this run, with the note.

| # | Data (mockup) | Derivation | Verdict | API |
|---|---|---|---|---|
| 1 | Header meter: open tasks split Overdue / Waiting / Other | From open tasks. Segments are **mutually exclusive** in the order Overdue, then Waiting (not overdue), then Other. The labelled header counts keep the §3.2 definitions (a task that is overdue and Waiting is counted in both counts but only once in the bar). The legend carries a tooltip saying so. | Include | existing `/api/state` |
| 2 | Header: Servers "PROD 4 · DEV 1", "1 warning" | Distinct server names (US-5.1). Environment from `bams_objects.environment`, else `server_upgrades.environment`. Servers with no known environment are counted in the total but not in PROD/DEV ("+n unknown" if any). "warning" = servers with an open Warning alert. | Include (limits) | existing infra data |
| 3 | Header: Alerts with worst metric ("Disk 87%") | Highest-severity open alert, then earliest `opened_at`; text from the alert message/metric. | Include | existing |
| 4 | Header: Next upgrade, "2 open upgrades" | `account_summary.sql` rule; count of upgrades not Completed or Deferred. | Include | existing |
| 5 | Due histogram (20 bars, overdue / today / future) | Open non-archived tasks bucketed by `due`: bins for T-6 … T+13 (20 bars). Older overdue tasks fall into the first bin; due after T+13 or with no due date are not drawn (the axis says "+14d"). Bar colours: overdue danger, today accent, future `--surface-3`/`--border-strong`. Each bar has a title "{date}: {n} tasks" and the chart has a text summary. | Include | existing tasks |
| 6 | Server tiles (name, version, health dot) | One tile per **distinct server name** (US-5.1). Dot = worst of its open alerts (Critical danger, Warning warning, otherwise none; a healthy server shows a muted dot with the word "healthy" in text). Version = `current_version` of the server's earliest open upgrade, else the `target_version` of its latest Completed upgrade, else omitted. | Include | `GET /api/client/{id}/infrastructure` additive (PM-AC-3) |
| 7 | Server tile sparkline ("CPU 7 days") | `bams_metric_samples` for one metric per server: the metric of its highest-severity open alert, else a metric whose name contains "cpu" (case-insensitive), else none. Window = the last 7 days or the span available, whichever is shorter, downsampled server-side to at most 28 points (bucket maximum). Label states the metric and real window ("CPU 24h", "Disk 7d"). Servers with no samples, and servers that exist only as upgrade records, show no sparkline and the text "No trend data". The seed has 24 hourly samples only, so T-61 extends it to 7 days; **PROD shows no sparklines until the Phase 4 monitor writes samples** (cached data is never invented, §55). Freshness wording follows `metric_freshness.sql`. | Include (limits) | PM-AC-3 |
| 8 | Upgrade timeline (30 days) | Upgrades with `T <= scheduled_date <= T+30` not Completed or Deferred, plus any Exception at any date. Past or beyond-window markers are pinned to the left/right edge and labelled with their real date. A "today" tick at 0. Marker colour by status via the §4 status map. The track has a list equivalent (visually hidden table). | Include | existing upgrades |
| 9 | "Top item for this account" panel | D-34. | Include | existing `GET /api/today` |
| 10 | Contacts with initials avatars | Initials from the contact name; role and team text. Avatars may be circles (guidelines §15.4). | Include | existing |
| 11 | Account details: Regions | Distinct `bams_objects.region`, else "-". | Include | existing |
| 12 | Accounts tile: Portfolio "24 active · 5 overdue · 4 alerts · 15 clear" | Counts of **accounts**: with overdue > 0; with active alerts > 0 (open or recovered); with neither ("clear"). An account with both counts in both numbers, so the three need not sum to the total; "clear" is the neither group. | Include | existing `/api/state` |
| 13 | Accounts tile: Open load by account (6 bars) | Top 6 accounts by overdue desc, open desc, then name (same order as Account Load). Exclusive segments as in #1. | Include | existing |
| 14 | Accounts tile: next 15 days strip (upgrades 6, client touches 9) | Day cells T … T+14 (15 cells). Upgrade marker: an upgrade not Completed or Deferred scheduled that day. Contact marker: an Active account `next_contact` that day. The two counts are totals over the window. | Include | existing |
| 15 | Accounts table: Load stacked bar | Open count text plus the exclusive bar from #1. `aria-label` "12 open: 3 overdue, 2 waiting, 7 other". Sorts by open count. | Include | existing |
| 16 | Accounts table: servers dots | One dot per distinct server; a dot is warning-coloured only if **that** server has an open alert (the mockup colours the first dot; the build uses the real server). Accessible name "5 servers, 1 with an alert". Sorts by server count. | Include | existing infra summary |
| 17 | Accounts table: Next upgrade / Next contact pills | Existing derived dates with relative text. | Include | existing |
| 18 | Accounts table: Activity trend sparkline (12 pts) | Count of Activity-timeline entries (D-03: manual notes plus the system events listed in §3.2) per **local day** for the last 14 days, per account, 14 points (the mockup's 12 is illustrative). Deleted objects are excluded as in Activity. Not sortable. New aggregate endpoint so `/api/state` stays light (§42). | Include (limits) | `GET /api/accounts/activity-trend` (PM-AC-2) |
| 19 | "Needs attention" list (4 rows with reasons) | D-33. Accounts with at least one signal, ordered by the key: (1) has an open Critical alert; (2) has an overdue upgrade; (3) overdue task count, descending; (4) has an open Warning alert; (5) has a client touch due today or overdue; (6) name ascending. At most 4 rows. Reason text lists up to two signals in key order ("Critical alert, upgrade 3d overdue"). Dot colour: danger if rule 1 or 2 applies, else warning. No numeric score is shown or stored. | Include | existing `/api/state` + infra summary |
| 20 | "Open load history" / trend of open tasks over time | Needs a daily snapshot table. | **Defer** | needs a schema change; out of this run |
| 21 | "3 terminals affected", ticket numbers, "Pilot group of 12 users" and other free-text context in mockup items | Not data the system holds. The build shows `context` as served (alert message, waiting owner, upgrade summary). | **Defer / not applicable** | none |
| 22 | Frozen start-of-day ring denominator | See §10.2. | **Defer** | needs a schema change request if wanted |

### 10.5 Where the mockups deviate from the spec, and what the build does

| Mockup | Deviation | Build rule |
|---|---|---|
| today-C | Default chip "Plan" = tiers 1-2 only (11 items), list capped at 7 | Default is "Top 10" across all tiers, strict cap 10 (D-27). No "Plan" chip. |
| today-C | Tier-1 order places an upgrade between a High and a Medium task | Upgrades rank after all tier 1 tasks (D-32, §10.3). |
| today-C | Tier-2 order puts "Prepare QBR agenda" before "Confirm terminal count" (both High) | Priority, then title ascending (`today_queue.sql`). |
| today-C | Detail pane has "What to do" steps and a "Mark complete" button | Removed (D-28). |
| today-C | Hand-written "why" strings and invented context/facts (SR-41872, 3 terminals, "Pilot group of 12 users", "Last contact 29 Sep" as ctx) | Generated why-sentences (§10.1); facts only from `QueueItem` fields. |
| today-C | Titles such as "Waiting: sign-off from J. Okafor" | Title is the task text; "Waiting on …" appears as context. |
| today-C | "Upcoming" chip for tier 6 and an Upcoming tab with a different meaning | Chip is "Next 3 days" (§10.1). |
| today-C | "Account load (24)" tab | Tab lists at most 8 rows; the count belongs to the "All accounts (24)" link (D-30). |
| today-C | "Alerts" chip count 7 includes only tier 3; Critical alerts are in "Overdue / critical" | Same, and intended. Chip labels stay short forms of the frozen tier labels. |
| today-A/B | Not selected | Not built. |
| account-workspace | "Do first for this account" with 3 steps and Mark complete | "Top item for this account" without steps or Mark complete (D-34). |
| account-workspace | Header meter "Overdue 3 · Waiting 2 · Other 7" | Exclusive segments (§10.4 #1); the labelled counts stay §3.2. |
| account-workspace | Server tile uses a `linear-gradient` to tint an alert tile; avatars, dots, step circles use 50% radius | Use the solid tint-surface tokens, no gradients (guidelines §15.2). Round shapes only where §15.4 allows. |
| account-workspace | Sparklines show 7-day CPU for every server | Only where samples exist (§10.4 #7). |
| account-workspace | Upgrade timeline marker at a fixed position for an Exception | Real position; past or out-of-window markers pinned to an edge with the real date. |
| accounts | Dots: the first server dot is warning when the account has an alert | The dot of the server that has the alert. |
| accounts | Activity sparkline of 12 points | 14 daily points (§10.4 #18). |
| accounts | Attention reasons are prose | Generated from the D-33 signals only. |
| all three | Static sample data (dates, counts, names) | Never copied into code or tests; the real data and the seed drive everything. |

Mockup "Do next" items versus tier logic: apart from the tier 1 and tier 2 ordering rows above, the mockup's tier assignments agree with §3.1 (critical alert and overdue upgrade in tier 1; due-today tasks in tier 2; Warning and recovered alerts in tier 3; Waiting tasks with `next_update <= T` and a due client touch in tier 4; scheduled, Exception and Validation Required upgrades in tier 5; tasks due T+1 to T+3 in tier 6). Its chip counts (6, 5, 7, 14, 8, 28 = 68) are sample data.

### 10.6 API additions (all additive; no existing field, route or code changes)

Recorded in `docs/qa/API_CHANGE_REQUEST.md` as PM-AC-1 to PM-AC-3. The backend freezes final shapes in `docs/04_API_CONTRACT.md` (T-62 to T-64).

| ID | Change |
|---|---|
| PM-AC-1 | `GET /api/today` adds `progress {day, total, done, open, done_other}` (§10.2). |
| PM-AC-2 | New `GET /api/accounts/activity-trend?days=14` returns `{"ok": true, "today": "…", "days": 14, "series": {"<client_id>": [n, … 14 ints, oldest first]}}` for Active accounts. |
| PM-AC-3 | `GET /api/client/{id}/infrastructure` adds a `servers` array: `{name, environment, version, alert_severity, spark}` per distinct server name, where `spark` is `{metric, window_hours, points: [[iso_utc, value], … ≤ 28]}` or `null`. |

**Schema:** none of D-26 to D-36 needs a schema change. The ring uses `audit_events` (`ix_audit_ts`); the trend uses `ix_audit_client_ts` and `notes`; sparklines use `bams_metric_samples` (`ix_bams_metric_samples_metric_ts`). The only items that would need one are the deferred #20 and #22.

### 10.7 User stories and acceptance criteria (Run 2)

**US-3.6** The Today list is a top-10 triage list with a detail pane. *Trace:* §7, D-26, D-27, D-28.
- AC1: On load the list shows the first 10 items of the queue in queue order, numbered 1 to 10, with the first selected and its detail visible. With fewer than 10 queue items, all are shown.
- AC2: "View all" and the `All` chip show the whole queue, with tier headings; tier chips show every item of that tier. `?show=` restores the state after reload and Back.
- AC3: Chip counts equal the number of queue items per tier, regardless of the 10-item cap.
- AC4: Up/Down/Home/End move the selection, Enter opens the underlying object per §4.2, double-click opens it, single click only selects.
- AC5: The detail pane shows the fields in §10.1 and **no** steps, next-action text or Mark complete. Null facts are omitted.
- AC6: Item order equals `GET /api/today` `queue` order, including D-32 and the tier 2 title tie-break.
- AC7: Upcoming-only objects never appear in the list.

**US-3.7** The "done today" ring is correct. *Trace:* D-29.
- AC1: N, M, open and done_other equal the §10.2 rules on the seeded DB, for each listed edge case.
- AC2: `N <= M` always. Reopening a completed task lowers N by one and leaves M unchanged.
- AC3: The ring resets when the local date changes without a page reload.
- AC4: M = 0 shows "No tasks due today" and no ring; N = M > 0 shows "All done".
- AC5: Text "N of M tasks done" is present for assistive tech.

**US-3.8** Later tabs. *Trace:* D-30.
- AC1: Upcoming, Recently changed and Account load are tabs below the list, collapsed by default, with counts; Account load shows at most 8 rows and an "All accounts" link.
- AC2: No drawer exists for these panels.

**US-3.9** Today stays calm. *Trace:* D-36.
- AC1: In steady state the only saturated colour areas on the Today screen are tier bars, the selected-row outline, status badges and at most the ring fill; no gradients, no animation beyond the 120ms colour/opacity transitions.

**US-4.2** Accounts overview instruments. *Trace:* D-31, D-33.
- AC1: The tile strip shows Portfolio, Open load by account and Next 15 days per §10.4 #12-#14.
- AC2: Table columns are Account, Load (bar), Overdue, Waiting, Alerts, Servers (dots), Next upgrade, Next contact, Activity (trend); US-4.1 AC2-AC5 still hold (no health score; filter; row opens Overview; "+ Account").
- AC3: Needs attention follows the D-33 key with every tie-break tested; it never shows a number that implies a score.
- AC4: Each bar, dot row and sparkline has a text equivalent.

**US-5.6** Workspace instruments. *Trace:* D-31, D-34.
- AC1: Header meters, due histogram, server tiles, upgrade timeline and Top item panel follow §10.4 #1-#11.
- AC2: A server with no samples or only upgrade records shows its tile without a sparkline and with "No trend data".
- AC3: The context column is a grouped panel; Run 1 content of US-5.5 is unchanged.

---

## 11. Run 3: Account bulk import with duplicate detection (D-37 to D-48)

Approved by the user on 2026-10-13 after reviewing `TAM_Command_Center/mockups/import/` (`01-accounts-import-file`, `02-template-workbook`, `03-preview`, `04-review-duplicates`, `05-result`, `06-add-single-account`). The mockups are not edited. Trace: §25 (bulk flow, template generated with openpyxl, Preview before write, atomic apply), §37 (Inspect, Preview, Apply; no blind import), §35 (audit), §36 (safety backup with the online backup API), §55 (tie-breaker: safe, explicit, quiet). **No schema change** was found necessary (see §11.7); `docs/qa/SCHEMA_CHANGE_REQUEST.md` is therefore not written.

### 11.1 Screens and flow (frontend-dev-agent)

Route `/accounts/import` (a four-step page, no drawer), reached from the "Import accounts" button on the Accounts page. Steps: **1 Choose file, 2 Preview, 3 Review duplicates, 4 Result**. Step 3 is skipped when nothing needs review.

1. **Choose file** (mockup 01). Drop zone or file picker, `.xlsx` or `.csv`, "up to 500 account rows". After the upload the file card shows rows found, size and sheet name (from `inspect`), "Remove", and a "Download template" button (`GET .../template`). Errors from `invalid_file` show in place with the server message; the Preview button is disabled until a file was inspected successfully.
2. **Preview** (mockup 03). Five tiles from `counts`: Valid (= New + Updates + Needs review), New, Updates, Needs review, Invalid. A filter row (All / New / Updates / Needs review / Invalid) and a table: Row (Excel row number), Account name, BPID, Products, Status, Next contact, Result badge, Detail (errors, fills/kept sentence, reasons summary). Footer: "Nothing has been written yet." and the primary button "Review N duplicates" (or "Apply import" when N = 0). Invalid rows are visibly "will be skipped".
3. **Review duplicates** (mockup 04). "k of N resolved". One card per flagged row: the file row, then each candidate (existing account facts or "row 13 of this file"), strength word with its reasons and differences, `fills` / `kept`. Three radio choices (Same account, Different account, Skip), none selected on arrival; with several candidates "Same account" needs one candidate picked. "Apply import" stays disabled until every card is resolved. No percentage anywhere.
4. **Result** (mockup 05). Tiles Created, Updated, Unchanged, Skipped, Overwritten (always 0, "fill blanks only"); safety backup name and size; "All changes written together" note; audit event count; fields filled; a skipped-rows list with reason; **Download skipped rows**; Done.
5. **Add account dialog** (mockup 06): the similar-account panel of D-45 inside the existing dialog.

Accessibility and states: step list with `aria-current="step"`; every radio group labelled by its row and account name; reasons are text (strength is never colour only); busy, error and expired-session states (`import_expired` -> "This import timed out. Choose the file again."); keyboard only operation.

### 11.2 Epic E13 and user stories

**E13 Account bulk import** (§25, §37, §35, §36, D-37 to D-48).

**US-13.1** Download the import template. *Trace:* §25 template rules, D-37.
- AC1: `GET /api/import/accounts/template` returns an `.xlsx` (default) or, with `?format=csv`, a `.csv` template; the xlsx opens with the sheets `Instructions`, `Accounts`, `Lists` in that order; `Lists` is hidden.
- AC2: `Accounts` row 1 headers are exactly `Account name`, `BPID`, `Products`, `Status`, `Next contact date`, `Notes`, in that order; `Account name` is marked required.
- AC3: Column D has a list data validation whose source is the `Lists` Status range, containing exactly the values of the `clients.status` CHECK (`Active`, `Inactive`); a test reads the CHECK text from `db/schema.sql` and compares.
- AC4: The date column is formatted `yyyy-mm-dd` with a header note; column B is text-formatted; validation covers rows 2 to 501.
- AC5: The file is generated on each request (no stored file); it contains no account data; it contains no formula, macro or external link; re-importing the empty template reports "no rows" (`invalid_file` / `no_rows`).
- AC6: `openpyxl` is pinned in `server/requirements.txt`, imported lazily-safe (the app still starts and every other route works if it is missing; the import routes then return `internal` with a clear log line).

**US-13.2** Upload and inspect a workbook safely. *Trace:* §37, D-38, D-47.
- AC1: A name that is neither `.xlsx` nor `.csv`, an `.xlsx` that is not a ZIP workbook (incl. renamed `.xls`/`.csv`), a `.csv` that is binary or a ZIP, an encrypted file, a corrupt ZIP, a file over 5 MiB, a macro-enabled workbook (`vbaProject.bin`), a workbook with external links, embedded objects, a ZIP over the entry/size/ratio limits, and an XML part with a DOCTYPE/ENTITY are each refused with `invalid_file` (or 413) and a `details.reason`; the database is untouched and no import session exists afterwards.
- AC2: A data cell holding a formula makes that row Invalid; the formula is never evaluated (proved by a formula whose cached value would be valid but whose row is still Invalid, and by a cell `=1+1` typed as text elsewhere staying text). Text starting `=`, `+`, `-`, `@` in Notes is imported verbatim as text.
- AC3: 500 non-blank rows are accepted; 501 make the whole file fail with `invalid_file` / `too_many_rows` carrying `found` and `limit`; blank rows do not count; a sheet padded with 20,000 blank formatted rows and 10 data rows is accepted or rejected per the 10,000-physical-row scan rule, never hangs (returns in < 5 s).
- AC4: Missing `Accounts` sheet, missing `Account name` header, duplicated header: `invalid_file` with the reason. Unknown extra columns: accepted with a file-level warning. Columns in any order are read by header.
- AC5: Row errors (`Account name` required or > 200, BPID > 32, Products > 500, Notes > 20000, Status not in `Active`/`Inactive`, date not `YYYY-MM-DD`, formula in a cell) mark only that row Invalid with a message that names row, field and the fix; trailing spaces are trimmed with no error; tabs/newlines in a name become one space; the rest of the file is previewed.
- AC6: Inspect writes nothing: row counts and `audit_events` of the database are unchanged and no backup file appears (checked by file listing and a SQLite change counter).

**US-13.3** Preview with counts. *Trace:* §25 steps 6-8, §37 (rows detected, fields mapped, warnings, expected creates and updates), D-39.
- AC1: Counts Valid / New / Updates / Needs review / Invalid; `valid = new + updates + needs_review`; `valid + invalid = rows`.
- AC2: Every row has an Excel row number, its normalised values, its state, and errors or the match explanation. Update rows list `fills` and `kept`.
- AC3: The response carries `plan_hash`, the file name, the sheet, the rows found and an expiry.
- AC4: The wizard's "Apply" is unreachable from step 1; there is no endpoint that writes before `apply`.

**US-13.4** Duplicate detection finds the right rows. *Trace:* D-40 to D-42, D-47.
- AC1: Exact name, case-insensitive and trimmed (and whitespace-collapsed), against an existing account -> `update`, not flagged. Exact in-file duplicates merge automatically into the earlier row.
- AC2: Each pair in the golden table of §11.5 produces the stated candidate list, strength and reasons (including `Web Ltd` vs `Web Mgmt Ltd`, `Tidewater Capital Ltd` vs `Tidewater Capital`, `Halvorsen Fjord Asset Mgmt` vs `Halvorsen Fjord Asset Management`, `Norrland Fund` vs `Norrland Sovereign Fund`).
- AC3: Pairs that must **not** flag do not flag (single weak shared word such as `Capital`, `Fund`, `Trust`; unrelated names).
- AC4: Accents, case, punctuation, `&`/`and`, and noise words never change the result (`Société Générale` = `Societe Generale`; `Smith & Sons Ltd.` = `Smith and Sons Limited`).
- AC5: A row with the same BPID as an existing account on a different name is flagged `same_bpid` / High; the same BPID inside the file on two different names flags the later row.
- AC6: Output is deterministic: the same input twice gives byte-identical JSON; candidate order follows D-42; at most 5 candidates per row; there is no numeric score or percentage in any field.
- AC7: Inactive accounts are candidates.

**US-13.5** Review and confirm every flagged row. *Trace:* D-43, D-44.
- AC1: Each flagged row offers exactly Same account, Different account, Skip, with none preselected; the Apply button is disabled until all are chosen.
- AC2: Same account shows the exact `fills` (field and value) and `kept` (existing value wins); an existing non-blank value is never overwritten, including Notes (verified for every field).
- AC3: Same account onto an Inactive account fills blanks, keeps it Inactive and shows the note; with an Active file Status it still stays Inactive.
- AC4: In-file duplicates (row B similar to earlier row A) offer the same three choices; Same account merges B into A (A wins conflicts); if A is Invalid or marked Skip, "Same account" for B is disabled in the UI and rejected with 422 by the server.
- AC5: A flagged row with several candidates needs a chosen target before Same account counts as resolved.
- AC6: Different account creates a new account with the file's values; Skip writes nothing and the row appears in the skipped list with reason "Skipped by you (possible duplicate of ...)".

**US-13.6** Apply atomically with a safety backup and audit. *Trace:* §25 step 10, §35, §36, D-39, D-44.
- AC1: Apply with an unresolved flagged row -> 409 `unresolved_duplicates`; nothing written, no backup file.
- AC2: A successful Apply creates one `pre-import` backup (online backup API, `integrity_check` ok) **before** the first change, then writes all changes in one transaction. Injecting a failure on the last write (test hook) leaves the database byte-identical in content to before (except the backup file existing) and returns an error.
- AC3: Exactly one `audit_events` row per created account and one per updated account (not per row, not per field), `source = 'Bulk Import'`, `object_type = 'client'`, `action` `created`/`updated`, old/new values holding only the changed fields, `reason` naming file and row(s); no audit row for Unchanged or Skipped rows.
- AC4: Apply fills blanks only: a test that imports a file whose every value differs from the stored account leaves all non-blank stored values unchanged (`overwritten = 0`), `row_version` bumps once per updated account.
- AC5: If the backup cannot be written -> 500 `backup_failed`, nothing written.
- AC6: Concurrent edit between Preview and Apply: editing a matched or candidate account (so its `row_version` changes), deleting it, or creating a new similar account makes Apply return 409 `preview_stale`; nothing written; the refreshed plan keeps decisions for unchanged rows. An edit that lands between the check and the write is caught by the in-transaction `row_version` check.
- AC7: A malformed or hostile workbook never reaches Apply (refused at Inspect); a session id that does not exist or expired -> 410 `import_expired`; a second Apply of one session -> 409 `already_applied` with no further writes.
- AC8: Re-importing the same file: every row is an Update with nothing to fill (Unchanged), or a previously flagged row; no created accounts; no audit rows for unchanged accounts; counts `created = 0` and `updated = 0`; no backup file is created when nothing changes.
- AC9: A name collision on `clients.name` can never surface as a database error: exact matches are merged before the write.

**US-13.7** Result page and skipped rows. *Trace:* D-46.
- AC1: The result shows Created, Updated, Unchanged, Skipped (invalid and user-skipped), Overwritten 0, backup name and size, audit event count, fields filled.
- AC2: "Download skipped rows" returns a file in the upload's format (`.xlsx` or `.csv`) with the six import columns plus `Source row` and `Reason`; values are strings (a value `=SUM(A1)` stays text in the file); re-uploading it (after fixing) is accepted, the extra columns being ignored with a warning. With nothing skipped the button is not shown.

**US-13.8** Single add uses the same similarity check. *Trace:* D-45.
- AC1: Typing `Web Ltd` and submitting with `Web Mgmt Ltd` existing shows the panel with candidate, reasons and strength word; nothing is created yet.
- AC2: Same account closes the dialog, discards the typed values and opens the existing account; nothing is written (no audit, no `row_version` change).
- AC3: Different account creates the account (`duplicates_confirmed: true`); Cancel returns to the form with typed values intact.
- AC4: An exact (case-insensitive) match offers only Same account and Cancel; the server still answers 409 `conflict` to a direct create.
- AC5: A name with no candidates creates directly, as today.
- AC6: Calling `client/save` (create) with candidates and without `duplicates_confirmed` returns 409 `possible_duplicate` with the candidates.
- AC7: `check-similar` and the import give identical candidates, reasons and strength for the same name and BPID (shared-engine parity test).

### 11.3 Business rules in one place (cross-reference, details in §0)

Fill-blanks-only (D-43); Inactive stays Inactive (D-43); exact vs similar (D-40, D-41); strength table and sentences (D-42); decisions and 409/410 codes (D-44); audit shape (D-39); limits (D-38, D-47).

### 11.4 API (proposed by PM; backend writes the final contract first)

Routes, request and response shapes are in `docs/04_API_CONTRACT.md` §10 "Account bulk import (PROPOSAL, proposed by PM, finalized by backend)". Change request: `docs/qa/API_CHANGE_REQUEST.md` PM-AC-4 to PM-AC-9.

### 11.5 Test cases

**Golden similarity table** (existing accounts E; the engine returns exactly the stated result; QA and backend extend it; frontend's mock adapter must reproduce it from the shared fixture `server/tests/fixtures/dupes_golden.json`):

| New name (BPID) | Existing (BPID) | Expected |
|---|---|---|
| `Castellan Peak Global Markets` | `Castellan Peak Global Markets` | exact -> Update, no flag |
| `  castellan  peak GLOBAL markets ` | same | exact -> Update |
| `Web Ltd` (104233) | `Web Mgmt Ltd` (104233) | High: `contained_name`, `same_bpid` |
| `Web Ltd` | `Web Mgmt Ltd` (BPID differs/blank) | Medium: `contained_name` |
| `Halvorsen Fjord Asset Mgmt` | `Halvorsen Fjord Asset Management` | High: `same_words_spelled_differently`, `abbreviation` |
| `Tidewater Capital Ltd` (103390) | `Tidewater Capital` (103390) | High: `same_core_name`, `same_bpid` |
| `Norrland Fund` | `Norrland Sovereign Fund` | Medium: `contained_name` |
| `Pinecrest Advisory Group` | row 13 `Pinecrest Advisory` | High: `same_core_name` (candidate is a file row) |
| `Bright Water Holdings` | `Brightwater Pension Trust` | Low: `shared_key_words` (split word `brightwater`) |
| `Norland Sovereign Fund` | `Norrland Sovereign Fund` | High: `same_words_spelled_differently` |
| `Acme Capital` | `Beta Capital` | no flag (weak word only) |
| `Capital Trust` | `Fund Trust` | no flag |
| `Meridian Re` | `Meridian Reinsurance` | Low: `shared_key_words` (`re` is under 3 characters, so no abbreviation) |
| `ACME, Inc.` | `Acme Inc` | High: `same_core_name` (not exact) |
| `Société Générale` | `Societe Generale` | High: `same_core_name` (accents) |
| `Smith & Sons Ltd.` | `Smith and Sons Limited` | High: `same_core_name` |
| `The Group` | `Group` | both cores fall back to unfiltered tokens (`the group`, `group`): Medium, `contained_name` |
| `Fund 1` | `Fund 2` | no flag |
| `Zeta Corp` (500100) | `Omega Corp` (500100) | High: `same_bpid` |
| name of 200 / 201 characters | any | 200 ok, 201 Invalid, no matching run on 201 |

**Backend test classes** (T-80 to T-86): `dupes` unit and golden; property tests (normalisation idempotent, case/accent/noise invariance, symmetric candidate sets for non-containment rules, determinism); workbook reader (every refusal in US-13.2 with a crafted fixture built in the test, including a 100:1 ZIP bomb of a few KB, a DOCTYPE bomb, a 10,000-blank-row sheet); template content; Inspect-no-write (hash of the database file pages unchanged, `audit_events` and `clients` counts unchanged, no new file in the backup folder); Apply atomicity with an injected failure; backup-before-write ordering; audit counts and shape; fill-blanks matrix (every field existing/blank x file blank/present x Active/Inactive); `row_version` stale cases (edit, delete, new similar account, edit during the write transaction); unresolved 409; target validation; idempotent re-import; skipped file content and formula safety; route/OPENAPI/CSP/Origin checks like existing routes; `client/save` enforcement and the existing suite updated for `duplicates_confirmed`.

**Frontend test classes** (T-87 to T-91): wizard step machine; decision state (none preselected, apply gating, multi-candidate target, disabled Same on skipped/invalid target); counts/tiles from fixture; the text rules (no `%`, no score field rendered: guard test greps the components and fixture rendering); Add dialog panel (Same discards values and navigates, Different sends `duplicates_confirmed`, Cancel keeps values); `import_expired`, `preview_stale` (refresh and keep decisions), `unresolved_duplicates`, upload errors; keyboard and accessible names; mock adapter parity on the golden file for `check-similar`.

**QA gate scenarios** (T-92 to T-94): live DEV backend with crafted workbooks: valid 40-row file mirroring the mockup (24/6/7/3 split), 500 and 501 rows, every hostile file, the concurrency scenario with a second browser tab, kill the server between Preview and Apply (`import_expired`), re-import idempotency, restore-from-backup check (open the `pre-import` backup and compare to the pre-state), formula-injection round trip through the skipped file, screenshots at 1440, 1280, 1024, 768 against mockups 01-06 as amended by D-48.

### 11.6 Task board (Run 3)

| ID | Owner | Task | Inputs | Outputs | Depends on | Definition of done |
|---|---|---|---|---|---|---|
| T-80 | BE | **Final API contract first.** Take the PROPOSAL in `docs/04_API_CONTRACT.md` §10, resolve every "BE decides" item, and publish the final section (routes, shapes, error codes, the 5 MiB route cap, the `possible_duplicate` change). Update `docs/qa/API_CHANGE_REQUEST.md` PM-AC-4..9 status. Mark the PROPOSAL banner "finalized". | §11, D-37..D-48, proposal | `docs/04_API_CONTRACT.md` §10 final | none | FE and QA can implement against it without asking; any deviation from the proposal is listed in a "Backend notes" paragraph in `API_CHANGE_REQUEST.md`. |
| T-81 | BE | **Duplicate engine** `server/dupes.py`: `exact_key`, `match_key`, token matching, rules R1-R6, strength table, reason/difference sentences, candidate ordering; pure functions over `(name, bpid)` and a list of accounts or rows; no I/O, no network. Golden fixture `server/tests/fixtures/dupes_golden.json` generated from §11.5 and extended. | D-40..D-42 | `server/dupes.py`, tests, fixture | T-80 | Golden table passes; property tests pass; 500 rows x 5,000 accounts < 2 s on the DEV machine; no numeric score in any output. |
| T-82 | BE | **Dependency and template.** Pin `openpyxl` (and its transitive dependencies) in `server/requirements.txt`, record it in `requirements-dev.txt` notes and the release-requirements note in `TAM_PROJECT_STATE.md`; run `pip-audit`; `GET /api/import/accounts/template` with sheets, validation, formats, hidden `Lists`; status constant pinned to the schema CHECK. | D-37 | `server/importer/template.py` (or equivalent), route, tests | T-80 | US-13.1 AC1-AC6. App starts and other routes work if `openpyxl` is absent. |
| T-83 | BE | **Workbook reader and validator**: ZIP/XML safety, size and row limits, header mapping, per-row parsing and errors, formulas rejected, text normalisation. | D-38, D-47 | `server/importer/reader.py`, crafted-file test fixtures built in code | T-80 | US-13.2 AC1-AC5; every refusal reason covered by a test with a generated hostile file. |
| T-84 | BE | **Inspect/Preview**: `POST /api/import/accounts/inspect`, `GET /api/import/accounts/{id}`, session store (memory, TTL, max 3), matching against DB and in-file, `fills`/`kept`, counts, `plan_hash`. No DB write. | T-81, T-83 | routes, tests | T-81, T-83 | US-13.2 AC6, US-13.3, US-13.4. |
| T-85 | BE | **Apply and skipped download**: `POST /api/import/accounts/apply`, `pre-import` backup reason (added to the automatic reasons and retention), single transaction, in-transaction `row_version` check, audit rows, errors `unresolved_duplicates`/`preview_stale`/`import_expired`/`already_applied`; `GET .../skipped.xlsx`. | T-84, T-82 | routes, `backups.py` reason, tests | T-84 | US-13.5 (server side), US-13.6, US-13.7. |
| T-86 | BE | **Single add**: `POST /api/client/check-similar`; `client/save` create returns `possible_duplicate` unless `duplicates_confirmed`; update the existing tests for the flag; contract §4 note. | T-81 | route, tests | T-81 | US-13.8 AC4-AC7; the full existing suite is green. |
| T-87 | FE | **Types and adapters**: `ImportPlan`, `Candidate`, `Reason`, `Decision` types; `DataSource` methods (`getImportTemplateUrl`, `inspectAccountsFile`, `getImportPlan`, `applyAccountsImport`, `checkSimilarAccount`); `ApiDataSource` (raw-body upload); `MockDataSource` with a canned plan and a TypeScript port of the matcher for `check-similar` only, proven against the golden fixture. | T-80 | `frontend/src/data/` | T-80 | Adapter tests; parity test on the golden fixture; no `%` or score field in the types. |
| T-88 | FE | **Wizard steps 1-2**: route `/accounts/import`, "Import accounts" button on Accounts, drop zone, file card, template download, upload errors, Preview tiles, filter and table. | mockups 01, 03, T-87 | `pages/import/` | T-87, T-84 | US-13.1 AC (button), US-13.2 AC (messages), US-13.3. |
| T-89 | FE | **Review duplicates (step 3)** and decision state: cards, reasons, strength word, fills/kept, three radios (none preselected), multi-candidate target, apply gating, stale/unresolved/expired handling. | mockup 04, T-87 | `pages/import/ReviewDuplicates.tsx`, `lib/importDecisions.ts` | T-88 | US-13.5, US-13.6 AC1, AC6, AC7 (UI side). |
| T-90 | FE | **Result (step 4)** and skipped download; navigation after Done. | mockup 05 | `pages/import/ImportResult.tsx` | T-89, T-85 | US-13.7. |
| T-91 | FE | **Add account dialog** similar-account panel; Same account navigates and discards; Different sends `duplicates_confirmed`; exact-match variant. | mockup 06, T-87, T-86 | `components/AddAccountDialog` | T-87, T-86 | US-13.8 AC1-AC5; guard test (no `%`, no score text) across the import and dialog components. |
| T-92 | QA | **Schema/API gate**: confirm no schema change is needed, review the final contract against D-37..D-48, review `dupes.py` thresholds against the golden table, security review of the reader (US-13.2). | T-80..T-86 | `docs/qa/ERROR_LOG_<n>.md` | T-86 | Verdict line; 0 open Blocker/High. |
| T-93 | QA | **Run 3 functional gate** on the live DEV stack: every AC of US-13.1..13.8, the scenarios of §11.5, screenshots at four widths, accessibility and keyboard. | T-87..T-91 | `docs/qa/ERROR_LOG_<n>.md` | T-88..T-91, T-92 | Verdict line; loop to PASS. |
| T-94 | QA | **Safety regression**: hostile files, atomic failure injection, backup restore check, idempotent re-import, concurrency, formula round trip; run the whole existing backend, db and frontend suites. | T-85, T-86 | `docs/qa/ERROR_LOG_<n>.md` | T-93 | No regression; `sql_safety_scan` 0 violations. |
| T-95 | PM | **Traceability update**: add the E13 rows (US-13.1..13.8, D-37..D-48), mark the §52 "imported malformed workbook does not partially write" test PASS or FAIL for accounts with evidence, update the coverage index and totals. | T-94 PASS | `docs/05_TRACEABILITY.md` | T-94 | No FAIL or MISSING for in-scope Run 3 items. |

No packaging task is included. Release note for the future packaging run: `openpyxl` is a new required runtime dependency (offline `wheelhouse\` must include it and its transitive dependencies).

### 11.7 Schema position

No new table, column, index or trigger is needed: `clients` already has every field, `UNIQUE (name COLLATE NOCASE)` makes exact merges mandatory (D-40), `row_version` supports stale detection (D-44), `audit_events.source` already allows `Bulk Import`, and import sessions are held in memory (D-39). Two assumptions QA must confirm in T-92: (1) a `pre-import` backup file reason needs only a filesystem name (not a database value); (2) per-account audit rows for 500 rows complete in one short transaction. If either fails, backend writes `docs/qa/SCHEMA_CHANGE_REQUEST.md` and stops.

### 11.8 Open items for the user

None blocking. Optional: (a) confirm Products stays free text (D-37; the alternative is a products catalogue in `app_meta` or a table, which is a schema or settings decision); (b) confirm that an Inactive account matched by an import stays Inactive (D-43); (c) confirm that duplicate decisions are not remembered across imports (D-47).

---

## 12. Run 4: BAMS monitoring dashboard, first cut (D-49 to D-62)

**Status: planning only; AMENDED 2026-10-14 with user answers (manual paste only, user-typed source URL, region/environment window inference: D-80, D-81, D-101 to D-106; Q8 answered: one DEV date, no schema change). MOCKUP GATE (hard rule): the frontend produces the mockups in `docs/qa/OPERATIONS_MOCKUP_BRIEF.md` and the user approves them before ANY UI build (T-149 onward). Parser, intake, routes, fixtures and QA planning touch no UI and may start now,.** Trace: SPEC §15-§25, §32-§34, §41, §52, §55, §56. The schema already holds `quarterly_upgrade_windows`, `server_upgrades`, audit object types and `app_meta` `schedule.*`; `source_sync_method` allows `manual`. Read-only upgrades already appear in the Account Workspace Infrastructure tab and Today (D-24). `/api/operations/*` returns 501 until T-141. **No network code exists in this run.**

### 12.1 Decisions

| # | Decision | Why |
|---|---|---|
| D-49 | **First cut = a trustworthy DEV dashboard, not a Bloomberg integration.** Built: provider interface, simulated DEV provider, monitor loop, samples and highs, rules, lifecycle, freshness, in-app notifications, Windows desktop notification seam, global BAMS page, metric detail with trend, account integration (workspace tab and Today stay as they are, now fed by live state). Deferred: real BLPAPI provider (cannot be tested here; interface and fail-closed PROD path are built), alert-config bulk tools, reminders. **Amended 2026-10-14 (D-63): appliance + metric bulk import (xlsx/csv) is IN Run 4, built after the dashboard core (section 12.8).** | Value now, no unverifiable code claimed as done. |
| D-50 | **PROD never simulates.** Provider is chosen only from channel/mode: DEV (`TAM_DEV_MODE=1`) -> `SimulatedProvider`; PROD -> `BlpapiProvider`, which in this run is a stub that reports `unavailable` ("BLPAPI provider not implemented/connected"). PROD with no working provider: monitor state `provider_unavailable`, every metric shows **No data** (never a number), lifecycle frozen, a visible banner. No env var, setting or fallback may enable simulation in PROD (a prod-channel build already ignores `TAM_BAMS_TEST_MODE`). Simulated rows carry a visible "SIMULATED" badge in DEV. | SPEC §4, §26, §56. |
| D-51 | **Monitor runs in the Python process** (thread/async task), default poll 60 s (options 60 s, 2 min, 5 min, 10 min, custom >= 30 s), start/stop from the UI and persisted in `app_meta`. UI polling of `/api/bams/state` (default 15 s) reads cached state and never triggers a provider call. DEV starts stopped-by-default? **No: DEV starts running; PROD starts stopped until the user presses Start** (and fails closed anyway). | §26, §39, §45. |
| D-52 | **Freshness** per metric from `last_source_update` age, thresholds from §27: Live <= 75 s, Delayed 76-120 s, Stale > 120 s, No data = no value yet. The per-metric `stale_after_seconds` overrides the Stale boundary only. Poll interval above 60 s makes Live impossible, so freshness is measured against `max(poll interval + 15 s, 75 s)` for Live (recorded; shown in the tooltip). | Keeps §27 defaults honest with slower polling. |
| D-53 | **Lifecycle engine** (`server/bams/lifecycle.py`, pure and fully unit-tested): evaluates only fresh (non-stale) samples; stale or provider outage **freezes** evaluation (no open, no recover, breach counters untouched). `consecutive_updates` counts consecutive fresh breaching samples. Breach with no non-closed event -> open (respect cooldown since last close and `suppress_until_clear`); breach with an open/recovered event -> update `last_triggered_at`, `current_value`, `peak_value`, and if `recovered` set it **back to open** (clear `recovered_at`); no new event (one non-closed event per metric/rule is DB-enforced). Clear -> `recovered` (never `closed`). User **Close** (optional note <= 2000) -> `closed`; closing while still breaching sets suppression until the metric clears (stored per rule, `suppress_until_clear`). A separate `stale` alert type is **not auto-raised** in this cut (freshness is a badge, not an alert storm); the column stays for later. | §27. |
| D-54 | **Historical highs** (30/60/90 day) are computed from `bams_metric_samples` by the monitor after each poll and stored on the metric; the DEV provider back-fills 90 days of coarse history on first run of a fresh DEV DB so the highs and trend are meaningful. Samples older than 100 days are pruned daily; sample writes batched per poll. Trend endpoint returns a downsampled series (max 500 points) for 24 h / 7 d / 30 d / 90 d. | §26, §45. |
| D-55 | **Rules**: all three types, four operators, severities, consecutive updates, cooldown, enabled, suppress-until-clear, per metric (`bams_alert_rules`). `bams_alert_configs` are **starter templates** (match by metric name GLOB) that the user can apply to metrics; applying is explicit and previews how many metrics get a rule (no silent bulk write). Rule edits use `row_version`; rule or config changes write audit events (`source`=UI, category `bams`). | §26, §35. |
| D-56 | **Notifications**: in-app (bell/inbox count and an Alerts view; no tab flashing, no title change) and Windows desktop (opened, optional recovered, closed is in-app only). Each attempt is logged to `bams_notification_log` (unique per event/kind/channel, so a restart or repeat breach never re-notifies). **Privacy Mode** (setting, default ON for desktop): the toast says "BAMS alert opened (Critical)" with no account, appliance or value. The desktop sender is behind a `Notifier` interface; DEV records the attempt as `desktop` success=1 with detail `dev: not displayed`; the Windows implementation (PowerShell toast, best-effort, failure logged and never raised) is **unverified until tested on Windows** and is listed as such in the state file. | §28. |
| D-57 | **Add appliance** (object plus its metrics with Bloomberg tickers) is in; edit, disable and delete are in (delete blocked while a non-closed alert exists; deleting also removes samples via cascade after an explicit confirmation that states the counts). **Import is IN (user decision 2026-10-14, amends the earlier "import is out"): see D-63 to D-72 and section 12.8; the "Import appliances" button appears on `/bams` only once T-125 ships.** | §29 lists import; deferred, see §12.4. |
| D-58 | **Global page = the §29 table and quick views exactly** (All, Active Alerts, Delayed/Stale, Live, No Data; filters Location, Appliance, Metric, Status, Search; account filter; columns Appliance, Location, Metric, Current, 30D/60D/90D High, Last Update, Status). Status shows the worst of: alert state (open/recovered), freshness. Row click opens the metric detail drawer (trend, rules, alert history for that metric, close action). Alerts view lists non-closed events first with Close, plus a closed-history filter. | §29, §55: the page answers "is the infrastructure healthy?". |
| D-59 | **Account integration**: the workspace Infrastructure tab keeps its panels but shows live status/active alert counts per appliance and a link "Open in BAMS" (`/bams?account=<id>`); Today's `bams_alert` rows stay and now link to the event in `/bams/alerts`. Active-alert counts everywhere = events with status `open` or `recovered` (recovered awaiting close still needs a human). | §14, §27. |
| D-60 | **API**: new `/api/bams/*` routes (v1 list in §12.3, BE publishes the final contract first, T-100). The 501 stub for `/api/bams/*` is replaced. Writes carry `row_version`; errors use the existing envelope. No route can switch provider or enable simulation. `/api/dev/bams/*` (DEV only, absent in PROD): force a value, simulate stale, simulate outage, reset history, so QA can drive every lifecycle path deterministically. | Testability without weakening PROD. |
| D-61 | **Time is injectable** (`Runtime.clock` style) in the monitor, lifecycle and freshness code so QA tests never sleep. | Determinism. |
| D-62 | **Charts**: Recharts line chart for the metric trend only, with the 30/60/90 highs as reference lines; every chart has a text equivalent (min, max, last value, range). Sparkline in the table row is the existing static SVG instrument, not Recharts. | Locked stack; §54 accessibility. |

### 12.2 User stories (acceptance, trace)

- **US-14.1** See infrastructure health at a glance on `/bams`. *AC:* top strip shows counts Active alerts, Delayed/Stale, Live, No data; quick views and filters per D-58 work together and are reflected in the URL; table is sortable; empty states say why (no appliances / provider unavailable / filter matches nothing). *§29*
- **US-14.2** Trust the data. *AC:* every row shows value, last update age, freshness word and icon (never colour alone); DEV shows SIMULATED; PROD with no provider shows No data and the banner, never numbers (test with prod-mode runtime). *§26, §4*
- **US-14.3** Control the monitor. *AC:* Start/Stop reflects real state, persists, shows last poll time and next poll; changing UI refresh does not change poll cadence (test counts provider calls). *§26, §39*
- **US-14.4** Alerts open, recover, and wait for me. *AC:* breach opens one event; repeated breach updates it (no duplicate); clearing sets `recovered` and keeps it visible; only Close closes; closing while breaching suppresses reopening until clear; stale/outage freezes everything (no events created or recovered, counters unchanged); cooldown honoured. *§27*
- **US-14.5** Define rules. *AC:* create/edit/disable/delete a rule for all three types and four operators with validation messages that match the schema CHECKs; preview text "Alerts when <metric> > 800 for 3 updates (Warning)"; starter templates apply with a count preview. *§26, §35*
- **US-14.6** Get told, quietly. *AC:* opening an alert adds an in-app notification and (if enabled) a desktop one exactly once per event/kind; recovered notifications are optional (setting); Privacy Mode strips names and values; browser title and favicon never change; attempts are logged and failures never break the monitor. *§28*
- **US-14.7** Inspect a metric. *AC:* detail drawer shows current value, highs with dates, freshness, trend for 24 h/7 d/30 d/90 d with reference lines, rules, and this metric's alert history. *§29, §45*
- **US-14.8** Manage appliances. *AC:* add appliance (account, name, region, location, environment) with at least one metric (name, ticker unique), edit, disable, delete per D-57; duplicate name per account and duplicate ticker rejected with clear messages. *§26*
- **US-14.9** Account view stays consistent. *AC:* D-59; workspace badge counts equal the BAMS page counts for that account. *§14*
- **US-14.10** Fail closed. *AC:* PROD-mode runtime with the stub provider starts, serves `/bams` with the banner, runs no simulation, creates no events. *§4, §56*

### 12.3 API v1 (BE finalises in `docs/04_API_CONTRACT.md` section 11)

`GET /api/bams/state` (summary counts, monitor status, provider status/mode, rows with latest value, freshness, alert status; filters by query), `GET /api/bams/metric/{id}` (detail, rules, history), `GET /api/bams/metric/{id}/trend?range=`, `GET /api/bams/alerts?status=`, `POST /api/bams/alert/{id}/close`, `POST /api/bams/monitor/start|stop`, `GET|POST /api/bams/settings` (poll interval, recovered notifications, desktop notifications, privacy mode), `POST /api/bams/object/save|delete`, `POST /api/bams/metric/save|delete`, `POST /api/bams/rule/save|delete`, `GET /api/bams/configs`, `POST /api/bams/configs/apply` (preview then apply), `GET /api/bams/notifications` and `POST /api/bams/notifications/read`. DEV only: `/api/dev/bams/{force-value,simulate-stale,simulate-outage,reset}`.

### 12.4 Out of scope for Run 4

Real BLPAPI provider; BAMS export (import is now IN, section 12.8; it excludes alert rules, samples, values and highs); stale-as-alert; reminders and escalation; alert snooze; mobile/email/Teams notifications; multi-user; ChatGPT Bridge BAMS context; Operations (Phase 3); packaging or release; any PROD claim.

### 12.5 Mockup screens (frontend produces, user approves; no build before approval)

1. `/bams` global dashboard, default view with summary strip, quick views, filters, table (mixed Live/Delayed/Stale/No data, one open and one recovered alert), SIMULATED badge.
2. `/bams` empty and failure states: PROD provider unavailable banner with all No data; no appliances; filter with no matches.
3. Metric detail drawer: trend chart with 30/60/90 reference lines and range switch, highs, rules, alert history.
4. Alerts view: open, recovered (awaiting close) and closed history; Close dialog (note, "still breaching, will not reopen until clear" warning).
5. Alert configuration: rules list per metric, rule editor for each of the three types with preview sentence, starter templates with apply preview.
6. Add/edit appliance dialog with metric rows; delete confirmation with counts.
7. Monitor and notification settings panel: Start/Stop, poll interval, desktop/recovered/Privacy Mode toggles, notification inbox popover (bell).
8. Account workspace Infrastructure tab with live status and "Open in BAMS".

### 12.6 Task board (Run 4)

| ID | Owner | Task | Depends | Definition of done |
|---|---|---|---|---|
| T-100 | BE | Publish final API contract section 11 (routes, shapes, errors, DEV routes) | none | section marked FINAL; every route in §12.3 covered; 501 stub removed for `/api/bams/*` |
| T-101 | DA | Review schema for Run 4: need for settings keys in `app_meta`, sample pruning index, any gap in `bams_*` for D-53/D-54 (suppression state, notification read flag); write `docs/qa/SCHEMA_CHANGE_REQUEST.md` only if required; extend DEV seed with 90 days of coarse history and a believable mix (live, delayed, stale, no data, open, recovered) | none | migration (if any) passes `sql_safety_scan` and schema tests; seed test asserts the mix |
| T-102 | BE | Provider interface, `SimulatedProvider` (deterministic with seed, supports force/stale/outage), `BlpapiProvider` stub reporting unavailable, provider selection by mode only | T-100 | test: PROD-mode runtime never constructs the simulator and metrics read No data |
| T-103 | BE | Monitor loop, start/stop, poll cadence, samples, highs, pruning, injectable clock | T-102, T-101 | tests: provider call count independent of UI refresh; highs correct; pruning |
| T-104 | BE | Lifecycle engine and freshness (pure, D-52/D-53) | T-101 | unit tests for every path in US-14.4 including freeze, cooldown, reopen from recovered, close-while-breaching |
| T-105 | BE | Read routes: state, metric detail, trend (downsampled), alerts; counts match Infrastructure/Today | T-100, T-103 | route tests; trend <= 500 points; counts equal `infra.py` |
| T-106 | BE | Write routes: close alert, rules, objects, metrics, configs apply with preview, settings; audit events; row_version conflicts | T-100, T-104 | tests incl. delete blocked by open alert, duplicate name/ticker |
| T-107 | BE | Notifications: in-app log and read state, `Notifier` interface, Windows toast best-effort, Privacy Mode, once-only per event/kind/channel | T-104 | tests with fake notifier; failure never raises; privacy text asserted |
| T-108 | BE | DEV-only `/api/dev/bams/*` routes, absent in PROD | T-103 | test: 404 in PROD runtime |
| T-109 | BE | Update `TAM_PROJECT_STATE.md` for provider/monitor status and the unverified-on-Windows list | T-107 | file current |
| T-110 | FE | Produce mockups of §12.5 in `TAM_Command_Center/mockups/bams/` (static HTML, no build) | none | 8 screens, `README` with decisions to confirm; **STOP: user approval required** |
| T-111 | PM | After approval, record the amendments as D-63+ and release T-114 | T-110 + user | decisions logged |
| T-112 | QA | Test plan `docs/qa/BAMS_TEST_PLAN.md` from §12.2 (lifecycle matrix, fail-closed, freshness boundaries 75/76/120/121 s) written before BE finishes | T-100 | plan reviewed |
| T-113 | QA | Schema/API review of T-100 and T-101 (severity rules from memory: only Blocker/High block) | T-100, T-101 | review file |
| T-114 | FE | Build `/bams`, drawer, alerts, configuration, appliance dialogs, settings, bell, adapters (mock + API) with Recharts trend | T-111, T-105..T-107 | Vitest for filters, freshness words, mock lifecycle; mock adapter parity with the API |
| T-115 | FE | Account workspace and Today link-through (D-59) | T-114 | tests |
| T-116 | QA | Gate: run lifecycle matrix end to end in DEV through the dev routes, prod-mode fail-closed check, a11y spot check, performance check with 200 metrics | T-114, T-115 | gate report; Blocker/High findings return to owner |
| T-117 | PM | Traceability update for §26-§29 and final validation; state file and CHANGELOG | T-116 | `docs/05_TRACEABILITY.md` rows PASS/FAIL/MISSING with evidence |

### 12.7 Open questions for the user (defaults apply if unanswered)

1. Desktop notifications: default ON with Privacy Mode ON? (default yes)
2. PROD starts with the monitor stopped until you press Start? (default yes)
3. Starter alert templates: which metrics matter first? (default: one `exceeds_high 90d` Warning and one 90%-of-90d-high Critical template; you edit them)
4. ~~BAMS object/metric import from Excel now or later?~~ **ANSWERED 2026-10-14: now (section 12.8).** Residual questions are in 12.8.5.
5. Is the real BLPAPI provider the next run, tested on the Bloomberg workstation? (default yes)

### 12.8 Appliance and metrics bulk import (user decision 2026-10-14; D-63 to D-72)

Trace: SPEC §29 (import on the BAMS page), §25 (template/preview/validate/commit), §26 (objects, metrics), §35-§37 (audit, backup), §46 (upload safety). It deliberately **reuses the Run 3 account-import design** (section 11, `docs/04_API_CONTRACT.md` section 10, `mockups/import/`): same wizard, session store, Inspect/Preview/Apply, decisions, 409/410 codes, skipped-rows download, `pre-import` backup. Where this section is silent, section 11 and D-37 to D-48 apply unchanged. Mockup numbering: section 12.5 items 9-13 (new).

#### 12.8.1 Decisions

| # | Decision | Why |
|---|---|---|
| D-63 | **Scope.** One import adds **appliances (`bams_objects`) and their metric definitions (`bams_metrics`)** for **existing accounts**. One file row = one metric of one appliance (appliance fields repeat on each of its rows). It never creates accounts, and never imports alert rules, samples, current values, highs, freshness or alert history (those belong to the monitor and the rules UI). New metrics appear as **No data** until the next poll (DEV simulated provider generates values for any new ticker deterministically). Mockup-driven amendments later start at D-73. | The user asked for appliance + metrics; §55: setup data, not monitoring data. |
| D-64 | **Columns (template, header names fixed, order free).** Required: `Account` (name; or `BPID`, at least one of the two, as in D-37), `Appliance`, `Metric`, `Ticker`. Optional: `Region`, `Location`, `Environment` (`PROD`/`DEV`, case-insensitive), `Enabled` (`Yes`/`No`, default Yes), `Stale after (s)` (integer > 0, default 120). Field limits are the schema CHECK limits (name 200, region 100, location 200, ticker 200, no control characters). Template = same engine as accounts (xlsx with `Instructions`, `Import`, `Example` sheets, or `?format=csv`), generated per request, no formulas, no data. | Mirrors D-37; every column maps to an existing column. |
| D-65 | **Account resolution.** `BPID` first (exact), else `Account` exact NOCASE match on `clients.name`. No match, ambiguous match, or BPID and name pointing to different accounts -> row Invalid with a plain sentence. No fuzzy account matching and no account creation. Inactive accounts are accepted (infrastructure still exists). | Wrong-account writes are the costly error; keep it exact. |
| D-66 | **Duplicate keys (exact, no decision needed).** Appliance identity = (resolved account, appliance name, NOCASE, trimmed, collapsed spaces), matching the schema `UNIQUE (client_id, name)`. Metric identity = (appliance, metric name), matching `UNIQUE (object_id, metric_name)`; **ticker is globally unique** (`bams_metrics.ticker UNIQUE`). Outcomes per row: **New** (appliance and/or metric absent, ticker unused); **Update** (appliance and metric both exist and ticker is equal: fill blanks only, D-43; otherwise Unchanged); **Invalid, ticker conflict** (ticker already used by a different metric or appliance, anywhere, or the same metric name already exists with a *different* ticker: sentence names the existing owner; never overwritten by import; change it in BAMS). Duplicate keys inside the file: identical repeat rows -> later row Invalid "repeats row N"; same ticker on two different metrics -> both Invalid. | Uses the schema's own constraints as the rule; tickers feed Bloomberg, so a silent change would corrupt monitoring. |
| D-67 | **Similar appliance (flagged, needs a decision).** Scoped **within one account**: a new appliance name that is not an exact match but normalises to the same or close key as an existing appliance of that account (or another appliance name in the file for that account) is a candidate, using the Run 3 engine (`server/dupes.py` normalisation, reasons, High/Medium/Low words, no numbers) with the account's appliances as the pool. Decisions per flagged appliance (one decision covers all its rows): **Same appliance** (merge: rows target the chosen existing appliance, metrics added/updated under it), **Different** (create new), **Skip** (all its rows skipped). None preselected; apply blocked until resolved (409 `unresolved_duplicates`, D-44). Same name in a different account is **never** a duplicate. | Typos like "BAMS-NY-01" vs "BAMS NY 01" are the realistic failure; per-account scope removes false positives. |
| D-68 | **Merge semantics (as D-43).** Fill blanks only for Region, Location, Environment; `enabled` and `stale_after_seconds` on an existing metric are never changed; a disabled existing appliance stays disabled; ticker/metric name of an existing metric never change. Merging into an existing appliance may add new metrics but never removes any. Appliance not in file is untouched. Never delete anything. | Import is additive and non-destructive. |
| D-69 | **Safety, same as Run 3.** Same upload limits and sniffing (D-38, 500 data rows, 5 MiB), formulas rejected, malformed file refused at Inspect, **no partial write**: Apply is one transaction preceded by a `pre-import` backup, rolled back wholly on any error. Audit: one event per created/updated appliance and per created metric (`source`=Import, category `bams`, entity, summary, counts), no ticker lists dumped in one event. Re-import of the same file = all Unchanged, no new audit rows. Apply is not blocked by a running monitor: the monitor reads metric lists at the start of each poll, so new metrics are picked up on the next poll; no locking or restart is needed, and writes use the normal write path. | Reuses the proven path; D-61 keeps it testable. |
| D-70 | **Environment guard.** Import is allowed in DEV and PROD (it only defines monitored items; it never produces values). In PROD, new metrics show **No data** under the provider-unavailable banner (D-50). The Environment column must equal `PROD` or `DEV`; a value that conflicts with the running mode is **accepted** (it is the appliance's environment, not the app's), and the result page does not warn. | §14 environment is per appliance. |
| D-71 | **Routes** (additive, mirror section 10): `GET /api/import/bams/template[?format=csv]`, `POST /api/import/bams/inspect`, `GET /api/import/bams/{import_id}`, `POST /api/import/bams/apply` (body: `import_id`, decisions per flagged appliance), `GET /api/import/bams/{import_id}/skipped[.xlsx|.csv]`. Final shapes in `docs/04_API_CONTRACT.md` section 12 "BAMS import" (BE publishes first, T-120). Counts in the preview/result: appliances New / Updated / Unchanged, metrics New / Updated / Unchanged, Needs review, Invalid, Skipped. | Same flow, same client code patterns. |
| D-72 | **UI placement.** Route `/bams/import` (four-step page, identical structure to `/accounts/import`), entered from an "Import appliances" button on `/bams` header and in the empty state "No appliances". After Done: return to `/bams` filtered to the touched accounts (`?account=`). The existing Add appliance dialog stays for one-offs; no similar-appliance panel is added to it in this run (it already rejects exact duplicates and tickers). | §55: one obvious path; no scope creep into the dialog. |

#### 12.8.2 User stories

**E14b BAMS appliance and metrics import** (§25, §26, §29, §35, §36, §37, §46; D-63 to D-72).
- **US-14.11** Download the template. *AC:* xlsx and csv, columns per D-64, no data, no formulas; re-import of the filled example validates.
- **US-14.12** Upload and preview with no write. *AC:* counts per D-71 appear; per-row errors name the sheet row and field; unknown account, bad Environment, ticker conflict, repeated row and over-limit values are Invalid; hostile/malformed/over-limit files refused; nothing in the DB changes before Apply (row counts of `bams_objects`/`bams_metrics`/`audit_events` asserted).
- **US-14.13** Resolve similar appliances. *AC:* D-67 candidates shown with reasons and strength words; none preselected; apply gated; same name in another account is not flagged.
- **US-14.14** Apply safely. *AC:* one `pre-import` backup before the first change, one transaction, rollback on injected failure (no partial rows), fill-blanks-only asserted with an all-different file, existing tickers/metric settings unchanged, audit per D-69, re-import is a no-op.
- **US-14.15** See the result. *AC:* result counts equal the DB delta; "Download skipped rows" works in the upload format; new metrics show on `/bams` as No data, and as live once the monitor polls in DEV (test with injected clock); Done returns to `/bams`.
- **US-14.16** Account/infrastructure stays consistent. *AC:* workspace Infrastructure tab and `/bams` counts for the account include the imported items (D-59).

#### 12.8.3 Schema position

**No schema change.** `bams_objects` already has `UNIQUE (client_id, name)` with NOCASE name, `region`, `location`, `environment`, `enabled`; `bams_metrics` has `UNIQUE (object_id, metric_name)`, `ticker UNIQUE`, `stale_after_seconds`, `enabled`; both have `row_version` and the update-uniqueness triggers. The import writes only these two tables plus `audit_events` and a backup file. The `pre-import` backup reason already exists (Run 3). DA confirms this in T-122 and writes `SCHEMA_CHANGE_REQUEST.md` only if a gap is found (a candidate to check: an index on `bams_objects(client_id)` for the per-account pool; the UNIQUE index already serves it).

#### 12.8.4 Mockup screens needed (T-121, FE; user approval before T-127 onward; reuse `mockups/import/` structure and `bams.css`)

9. `/bams/import` step 1: choose file, template download (xlsx/csv), column legend (required/optional), upload errors.
10. Step 2 preview: tiles (appliances New/Updated, metrics New/Updated, Needs review, Invalid), filter row, rows table grouped by appliance with row-level error sentences (ticker conflict, unknown account).
11. Step 3 review similar appliances: card per flagged appliance with candidate(s) in the same account, reasons, strength word, three radios, fills/kept.
12. Step 4 result: counts, skipped download, "Open BAMS" Done; plus the failure/no-write state.
13. Entry points: `/bams` header "Import appliances" button and the "No appliances" empty state (small annotated crop of mockups 01/02).

#### 12.8.5 Task board (Run 4 import; IDs continue after T-117)

| ID | Owner | Task | Depends | Definition of done |
|---|---|---|---|---|
| T-120 | BE | Final contract `docs/04_API_CONTRACT.md` section 12 "BAMS import" (D-71), reusing section 10 shapes and error codes; resolve open items | none | section FINAL; every route/error code listed |
| T-121 | FE | Mockups 9-13 (section 12.8.4) in `TAM_Command_Center/mockups/bams/` (static HTML), README of decisions to confirm | none | 5 screens; **STOP: user approval** |
| T-122 | DA | Confirm no schema change (12.8.3), add import fixtures (accounts with appliances, tickers, near-duplicate appliance names) to DEV seed/test fixtures | none | statement in the review file; fixtures tested |
| T-123 | BE | Reader/validator for BAMS rows (reuse account import reader, limits, sniffing), account resolution (D-65), exact keys and ticker conflicts (D-66) | T-120 | unit tests incl. in-file duplicates, formula rejection, 500/501 rows |
| T-124 | BE | Similar-appliance matching scoped per account via `dupes.py` (D-67), Inspect/session endpoints, template and skipped download | T-123 | golden tests; parity of reasons/strength with Run 3 engine |
| T-125 | BE | Apply: backup, one transaction, merge rules (D-68), audit (D-69), monitor pickup without restart; atomic-failure injection | T-124 | tests: no partial write, fill-blanks-only, idempotent re-import, new metric polled with injected clock |
| T-126 | PM | After approval, record mockup amendments as D-73+ and release T-127 | T-121 + user | decisions logged |
| T-127 | FE | Build `/bams/import` steps 1-4 on the existing wizard components, button + empty state entry points, mock adapter parity | T-126, T-124 | Vitest: step machine, decision gating, error rendering |
| T-128 | FE | Result, skipped download, navigation back to filtered `/bams` | T-127, T-125 | tests |
| T-129 | QA | Test plan appended to `docs/qa/BAMS_TEST_PLAN.md` from US-14.11..16 | T-120 | plan reviewed |
| T-130 | QA | Schema/API review of T-120 and T-122 | T-120, T-122 | review file |
| T-131 | QA | Gate: live DEV with crafted files (valid, ticker conflicts, cross-account same name, near-duplicates, hostile, 500/501 rows, injected failure, backup restore, re-import, concurrent monitor); also run the Run 3 account-import suite unchanged | T-125, T-128 | gate report; Blocker/High returned to owner |
| T-132 | PM | Traceability: add US-14.11..16, D-63..D-72 rows; mark the §52 malformed-workbook test for BAMS; state file and CHANGELOG | T-131 | `docs/05_TRACEABILITY.md` rows with evidence |

Open questions (defaults apply): (a) Should an ambiguous account name block only that row (default) or the whole file? (b) Is a differing ticker for an existing metric an error (default) or an explicit "replace ticker" decision later? (c) Should export of appliances/metrics in the template format come next (default: later, it is the natural round trip)?



---

## 13. Run 5: Operations, appliance upgrade tracker (D-107 to D-125)

**Status: planning only; MOCKUP GATE: the user approves the mockups in `docs/qa/OPERATIONS_MOCKUP_BRIEF.md` before any UI build.** Trace: SPEC §15, §22-§24 (cut down), §25 (replaced by the BAMS appliance import), §32 (account link), §55, §56 item 11.

**Scope reset (2026-10-14, user rejected the first Operations mockups as too dense).** The earlier Run 5 plan (D-73 to D-106, tasks T-133 to T-163, schedule paste/parse, Diagnostics, source URL, release selector, six lenses, separate server-upgrade bulk upload, Environment+Region window inference) is **SUPERSEDED and void**; it remains in git history only. Nothing from it was built. Task IDs T-133 to T-163 are retired and not reused.

### 13.1 What Operations is now
One page that lists **every BAMS appliance** and shows, for a chosen quarter, **when it will be upgraded, to which version, and its status**. Quarters, dates and target versions are **typed by the user**. No network, no parsing, no sync, no Diagnostics, no source URL, no second upload.

### 13.2 Decisions

| # | Decision | Why |
|---|---|---|
| D-107 | **Single source of appliances = the BAMS appliance import (Run 4).** There is no server-upgrade importer. Operations reads `bams_objects` (one row per appliance, all of them, enabled or not). Appliances added by the BAMS import or the Add appliance dialog appear in Operations with no extra step. | User: one upload only. |
| D-108 | **Import additions (extend D-64, no new importer).** Run 4 already has `Environment` (PROD/DEV, stored in `bams_objects.environment`) and `Region` (free text up to 100, stored in `bams_objects.region`). Polarity East/West is **stored in `region`** (no schema change). Template header stays `Region`; `Polarity` is accepted as an alias; the template Instructions and the Example sheet say "Region / Polarity: East or West (used by Operations)"; the Region column gets a soft (warning-style) list East/West. Merge rule unchanged (D-68: fill blanks only). Non-East/West text still imports (it is valid BAMS data) and the preview/result add one note line "N appliances need East or West set for Operations" (no error, no new tile). Environment keeps D-64/D-70 rules; an appliance with no Environment is also counted in that note. | Reuses what exists; fail soft; no schema change. |
| D-109 | **Polarity of an appliance** = `region` case-insensitively equal to `East` or `West`, else "not set". Environment = `environment` (`PROD`/`DEV`) or "not set". Both can be fixed inline in Operations (row edit) through the existing BAMS appliance save route (row_version honoured), so a missing value never needs a re-import. | One source of truth, editable. |
| D-110 | **Quarter record (manual, minimal).** The **Target version** field is part of the Add/Edit quarter dialog (it is the quarter's **default** version, used by appliances that have no version of their own). Table `quarterly_upgrade_windows`, one row per (year, quarter), entered and edited by the user. Fields shown: **Year, Quarter (Q1-Q4), Target version** (`apics_version`), **DEV date** (`dev_upgrade_date`), **PROD East date** (`east_prod_date`), **PROD West date** (`west_prod_date`); all dates optional. Stored `source_sync_method = 'manual'`. Unused columns (notification, CD/MFA versions, maintenance window, source fields) stay NULL and are never shown. Quarter label is "2026 Q4". Edited inline in a small dialog; delete is blocked while appliances reference it (FK RESTRICT) with the message "N appliances have a status in this quarter". Assumed, unconfirmed: DEV has one date, East/West apply to PROD only (earlier Q8). | Fits the existing table; no schema change. |
| D-111 | **How an appliance gets its date and version (derived, overridable).** For the selected quarter: window = DEV -> `dev_upgrade_date`; PROD+East -> `east_prod_date`; PROD+West -> `west_prod_date`. **Target version** = the appliance record's own `target_version` if set (D-119), else the quarter's default `apics_version`, else "Not set". If the needed date is empty or polarity/environment is not set, the cell shows "Not set" with the reason ("Set East or West", "No PROD East date in 2026 Q4"). The user may **override the date** per appliance and quarter (blank = follow the quarter); the version is set per appliance as described in D-119. Derivation is computed on read, so editing a quarter's date moves every appliance that follows it, no re-derivation job. | Simple, no stale copies. |
| D-112 | **Per-appliance record = `server_upgrades`.** A row exists only after the user changes something for that appliance in that quarter. Mapping: `client_id` and `server_name` = the appliance's account and name; `schedule_year`/`schedule_quarter` = the quarter; `environment`/`polarity` copied from the appliance at save (DEV -> polarity `DEV`, PROD -> East/West; the table CHECK requires it, so a PROD appliance without East/West cannot get a record until polarity is set); `scheduled_date` holds **only an override** (NULL = derived) and `target_version` holds the **appliance's own version** (NULL = use the quarter default); `status`; `notes`; `row_version`. `validation_status` stays default and is hidden; `waiting_on`, `reference`, `maintenance_window`, `source_url` are unused. Identity = account + name + quarter (existing unique index). If the appliance is later renamed in BAMS the record no longer matches (known limit; the row is orphaned and shown nowhere; QA records it as Low). | Reuses the table and its triggers; no schema change. |
| D-113 | **Status (simple).** The row menu offers **Planned (default), Awaiting Client, Scheduled, In Progress, Completed, Deferred**. Existing records with Validation Required or Exception display their value read-only-in-menu (still selectable to change away). A row is tagged **Overdue** when its effective date is before today and status is not Completed or Deferred. No validation workflow in this run. | User: simple status. |
| D-114 | **Quarter in view.** The page shows one quarter at a time through a compact **Quarter** dropdown (not a release workbench): default = the entered quarter with the earliest date on or after today, else the latest quarter; options are only entered quarters. Because status and overrides are per quarter, an appliance deferred in Q4 is simply Deferred in Q4. "Add quarter" sits next to the dropdown. Assumed, unconfirmed: this one-quarter-at-a-time model. | Per-quarter status is the natural shape of `server_upgrades`. |
| D-115 | **The page** (`/operations`): header (title, Quarter dropdown with edit and "Add quarter", target version for the quarter, three date chips DEV / PROD East / PROD West), a one-line summary ("38 appliances: 20 Planned, 6 Scheduled, 3 Overdue, 9 Completed"), filter row (account search, status, environment, polarity, Reset), a single table, and nothing else. Table is **grouped by account** (D-120) with a checkbox column (D-119); appliance columns: **[ ] | Date | Appliance | Env / Polarity | Target version | Status | Note | edit**, date-first inside an account (empty dates last); account groups sorted by account name. Account name links to the Account Workspace (§32). Status is changed inline from the cell; everything else in a small row-edit dialog (date override, version, note, polarity/environment fixes, "Reset to quarter"). Empty state when there are no appliances ("Import appliances in BAMS") and when there are no quarters ("Add your first quarter"). Client Notice is never shown. | §15 trimmed; §55. |
| D-116 | **Routes** (additive, replace the 501 stub): `GET /api/operations?year=&quarter=` (quarters, selected quarter, rows with derived and effective values, summary counts; server-side filters), `POST /api/operations/quarter/save`, `POST /api/operations/quarter/delete`, `POST /api/operations/appliance/save` (object id + quarter; creates or updates the `server_upgrades` record; blank overrides stored as NULL; carries `row_version`), `POST /api/operations/appliance/set-version` (body: quarter, list of appliance ids, `target_version` or null to clear; one transaction; response lists updated and skipped with reasons), `POST /api/operations/appliance/reset` (deletes the record, back to derived). Appliance polarity/environment edits reuse the existing BAMS appliance save route. Errors use the existing envelope; every write audits (`server_upgrade`, `quarterly_upgrade_window`). Final shapes in `docs/04_API_CONTRACT.md` section 13 (T-164). | Smallest API that does the job. |
| D-117 | **Today and Workspace stay as they are** (Today already ranks `server_upgrades` by D-24; Workspace Infrastructure tab shows them read-only). The Workspace notice text gains a link "Open in Operations". Their upgrade data now comes from the same records. | Scope. |
| D-118 | **Out of scope:** schedule parsing/paste/sync/Diagnostics/source URL; any network code; release selector and lens strip; separate server-upgrade bulk upload or template; validation workflow; Next-weekend card and countdowns; export; reminders; auto-carry of appliances to the next quarter; ad-hoc upgrades without a quarter. | User scope cut. |
| D-119 | **Software version is manual and per appliance.** Only **Target version** exists in this run (assumed, unconfirmed: no Current version; `server_upgrades.current_version` stays unused). The version lives in `server_upgrades.target_version` on the appliance's record for that quarter (text, up to 50, trimmed); the quarter's `apics_version` is only a default shown greyed ("default 4.78.0"). Setting a version on an appliance creates its record if none exists (same PROD-needs-polarity rule). **Selection and "Set version":** every appliance row has a checkbox; the account row has a tri-state checkbox that selects or clears all of that account's appliances (including collapsed ones); a header control "Select all (N)" selects every appliance matching the current filters in the quarter. A selection bar appears when anything is selected: "N selected | Set version | Clear". Set version opens a one-field dialog "Apply to N appliances" (blank = clear, back to the quarter default) and applies in one action and one transaction with one audit event per appliance; appliances that cannot take a record (PROD without East/West) are skipped and named in the result toast ("Version set on 12; 2 skipped: set East or West first"). Selection survives expand/collapse and sorting, resets on quarter change or Clear; cap 500 per action. | User feedback 1. |
| D-120 | **Grouped by account.** One collapsible row per account showing: chevron, tri-state checkbox, account name (link to the Workspace), appliance count, and a compact status summary (e.g. "6 appliances: 3 Planned, 2 Scheduled, 1 Overdue"). Clicking the row (except the name link and checkbox) opens or closes all of that account's appliances. Toolbar has **Expand all** and **Collapse all**. **Proposed default: all accounts collapsed**; an account auto-expands when a search or filter is active and it has matching appliances, and the expand state is kept for the session (not stored). Accounts with no matching appliances are hidden while filtering. Keyboard: Enter/Space toggles, visible focus, `aria-expanded`. | User feedback 2. |
| D-121 | **Quarter dialog contains Target version** (default for the quarter), alongside Year, Quarter and the three dates (it was missing in mockup v2). | User feedback 3. |

### 13.3 Schema decision
**No schema change** (`server_upgrades.target_version` already holds the per-appliance version; `quarterly_upgrade_windows.apics_version` the quarter default). `quarterly_upgrade_windows` (manual rows, `source_sync_method='manual'` is allowed) and `server_upgrades` (override columns nullable, status CHECK covers the six statuses, identity index and triggers in place) fit. Polarity East/West reuses `bams_objects.region`. DA confirms in T-166 and writes `docs/qa/SCHEMA_CHANGE_REQUEST.md` only if a gap appears. Candidate to confirm: whether the audit CHECK accepts the sources/object types used (`server_upgrade`, `quarterly_upgrade_window`, `UI`). The earlier plan's "Schedule Sync" audit source is no longer needed.

### 13.4 User stories (E15, replaces US-15.1..15.13)

- **US-15.1** Appliances appear from BAMS. *Trace:* D-107. *AC:* an appliance imported or added in BAMS shows in Operations without another step; disabled appliances are listed; count equals `bams_objects` rows (test).
- **US-15.2** Import carries polarity. *Trace:* D-108, D-109. *AC:* template has Environment and Region/Polarity guidance; `Polarity` header accepted as Region alias; East/West (any case) stored as `East`/`West`; other text imports with the note line; blank-fill rule unchanged; Run 4 import suite still passes; preview and result show "N appliances need East or West set for Operations".
- **US-15.3** Add/edit a quarter. *Trace:* D-110. *AC:* create with year, quarter, optional version and three optional dates; duplicate (year, quarter) rejected plainly; dates validated; edit uses row_version; delete blocked with the count message; audited.
- **US-15.4** Derived date and version. *Trace:* D-111. *AC:* 3-case table test (DEV, PROD East, PROD West); empty date, missing polarity or environment show the specific "Not set" reason; editing a quarter date changes all following appliances without any write to them.
- **US-15.5** Override and reset. *Trace:* D-111, D-112, D-119. *AC:* date override and per-appliance version stored only when non-blank; "Reset to quarter" deletes the record; PROD appliance without East/West cannot be saved until polarity is set (message names the fix); stale row_version -> conflict, no overwrite.
- **US-15.6** Status. *Trace:* D-113. *AC:* six statuses offered, Planned default without a stored row, inline change persists and audits; Overdue tag boundary (yesterday yes, today no; Completed/Deferred never).
- **US-15.8** Select and set version. *Trace:* D-119. *AC:* appliance checkbox, tri-state account checkbox (incl. collapsed children) and "Select all (N)" over the filtered set select the expected ids; Set version writes `target_version` on all selected in one transaction with audit per appliance; blank clears to the quarter default; PROD-without-polarity appliances are skipped and named; atomic on injected failure; selection cap 500; selection bar shows count; nothing else changes (status, date untouched).
- **US-15.9** Account grouping. *Trace:* D-120. *AC:* one group row per account with count and status summary matching the rows; click toggles all children; Expand all / Collapse all; default all collapsed; auto-expand on active filter; keyboard and `aria-expanded`; summary counts equal the filtered table.
- **US-15.7** Page, filters, link. *Trace:* D-114, D-115, D-117. *AC:* default quarter rule at injected dates; summary counts equal filtered table counts (grouping per US-15.9); filters combine and Reset clears; account name opens the Workspace; empty states for no appliances and no quarters; keyboard operable with visible focus.

### 13.5 Task list (IDs T-164 onward)

| ID | Owner | Task | Depends | Definition of done |
|---|---|---|---|---|
| T-164 | BE | Contract `docs/04_API_CONTRACT.md` section 13 FINAL (D-116, incl. `appliance/set-version` and the account grouping/summary fields) and the import note-line field in section 12 | none | every route/error listed |
| T-165 | BE | Extend BAMS import: `Polarity` alias, East/West normalisation, note-line counts, template/Example/Instructions text, soft list | T-164 | Run 4 suite unchanged + new tests (alias, case, other text, counts) |
| T-166 | DA | Confirm no schema change (audit vocabulary, FK/triggers behave for manual windows and override rows); extend DEV seed: 3 quarters (one past), 12 appliances across PROD East/West/DEV/unset with a mix of statuses and 2 overdue; write nothing to schema unless a gap exists | none | review statement; seed test asserts the mix |
| T-167 | BE | Operations read (`GET /api/operations`), derivation function, summary, default-quarter rule | T-164, T-166 | table-driven tests (3 windows, not-set reasons, overrides, default quarter, overdue boundary) |
| T-168 | BE | Quarter save/delete (target version default included); appliance save/reset with row_version; `appliance/set-version` bulk (one transaction, skipped list, audit, cap 500); PROD-needs-polarity rule, audit; remove the `/api/operations/*` 501 stub | T-167 | validation, conflict, delete-blocked tests; existing suites green |
| T-169 | FE | Mockups per brief (replace the rejected files in `mockups/operations/`) | none | max 4 screens + import additions; **STOP: user approval** |
| T-170 | PM | Log mockup amendments (D-119+) and release T-171 | T-169 + user | decisions logged |
| T-171 | FE | Adapters (mock and API) + Operations page grouped by account (collapse, Expand/Collapse all, tri-state selection, selection bar, Set version dialog), quarter dialog with Target version, row-edit dialog, inline status, empty states, Workspace link, rail "Later" tag removed, import preview/result note line | T-170, T-167, T-168 | Vitest: derivation parity with backend golden cases, filters, default quarter, overdue, dialogs, selection logic (tri-state, select all over filter), grouping summary, auto-expand |
| T-172 | QA | Test plan, then gate on live DEV: every AC US-15.1..15.7, import regression (Run 3 and 4 suites), screenshots of Operations (§56) | T-165, T-168, T-171 | verdict line; only Blocker/High block |
| T-173 | PM | Short `docs/OPERATIONS_GUIDE.md`, traceability rows, state file, CHANGELOG | T-172 | PASS/FAIL/MISSING with evidence |

Order: T-164, T-166, T-169 in parallel -> T-165, T-167, T-168 -> (approval T-170) -> T-171 -> T-172 -> T-173.

### 13.6 Open questions (max 2; defaults apply)
1. **Is a Current version worth adding (D-119)?** Default: no, Target version only (`current_version` column exists, so adding it later needs no schema change).
2. **One quarter at a time (D-114), East/West in the existing `Region` field (D-108), one DEV date (D-110)** are still assumed, unconfirmed; the alternatives are one quarter per appliance and/or a new Polarity column (small migration). Default: as written, no schema change.
