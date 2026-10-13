# 03 Data Model: TAM Command Center, schema version 1

| | |
|---|---|
| Author | data-architect-agent (Phase 1.2, tasks T-01 to T-04). Revised for QA `SCHEMA_REVIEW_1` to `_4` (all REJECTED) and for PM decisions D-23 and D-24. |
| Date | 2026-10-12 |
| Inputs | `docs/SPEC.md` (§11-14, §22-27, §33, §35, §36, §42, §45, §46), `docs/01_PM_SPEC.md` (§0, §2, §3), `docs/qa/SCHEMA_REVIEW_1.md` |
| Next gate | QA re-review → `docs/qa/SCHEMA_REVIEW_5.md`. Finding dispositions are in §13 to §16 (reviews 1 to 4). |

## 0. Files

All paths are under `TAM_Command_Center/db/`.

| File | What it is |
|---|---|
| `schema.sql` | Canonical snapshot of the latest schema: 16 tables, 19 indexes, 51 triggers. |
| `migrations/0001_initial.sql` | Migration to schema v1. Its body is identical to `schema.sql`; `python db/migrate.py --verify-schema` proves it. v1 is **unreleased**, so it was edited in place for reviews 1 and 2, as QA allowed. From release on, the forward-only rule applies. |
| `migrate.py` | Reference migration runner. It includes the online-backup helper, the guard-trigger check (names **and** SQL), the channel stamp and the only audit-purge path. It is the executable form of §6. |
| `sql_safety_scan.py` | Codebase scanner for every spelling of the banned REPLACE algorithm and other destructive "replace" writes (§2.1). It uses a comment-aware lexer, root-anchored skips and an allow marker. Run it with `python db/sql_safety_scan.py [root]`; it exits 1 on any finding. A contract test runs it over the whole `TAM_Command_Center/` tree. |
| `queries/today_queue.sql` | Today queue tiers 1-6 plus Upcoming (PM §3.1). This is the source of truth for §9.1. |
| `queries/activity_timeline.sql` | Activity tab: notes merged with system events, with keyset pagination. |
| `queries/recent_changes.sql` | Today "Recently Changed". |
| `queries/account_summary.sql` | Accounts directory, Account Load and workspace header counts. |
| `queries/object_history.sql` | Audit history of one object. |
| `queries/metric_freshness.sql` | BAMS per-metric freshness state (Live, Delayed, Stale, No Data, Disabled) under the frozen mock clock rule (§8). |
| `seed_mock.py` | Deterministic mock generator, plus a loader that rebases dates to today and a verifier. |
| `mock_data.json` | The fixture (`tam-mock-v1`). The frontend `MockDataSource` (T-23) also reads it. |
| `tests/test_db_contract.py` | **77** stdlib `unittest` tests: the original contract tests, regression tests for every review-1 to -4 fix, D-23/D-24 queue tests, and the scanner corpus (572 generated banned statements, 44 ORM and other banned forms, 57 legitimate negatives). Run with `python -m unittest discover -s TAM_Command_Center/db/tests`. |

## 1. Decisions applied

The PM's recorded defaults are used for the open questions.

| Item | Applied as |
|---|---|
| D-01 / Q-1 | New schema line: `app_meta.schema_version='1'`. There is no legacy upgrade path. `PRAGMA application_id = 0x54414D43` ('TAMC') identifies TAM DB files. |
| D-02 | Every §33 table exists, including Operations, BAMS and `support_cases` (unused). |
| D-03 | `notes` holds manual notes only. `notes.source` cannot be `System`. System events are derived at read time from `audit_events` and `bams_alert_events` (§9.2). |
| D-04 / Q-4 | All due-today tasks go in tier 2, sorted by priority (`queries/today_queue.sql`). |
| **D-23** | One queue entry per follow-up obligation. If an account has an open, non-archived `Client Follow-Up` task whose `due` equals `clients.next_contact`, the account-level `client_follow_up` item is suppressed in **both** the queue and Upcoming, and that task gets context `Next Client Touch`. Different dates, or a Complete/archived task, leave both items in place (§9.1). |
| **D-24** | `Exception` upgrades are tier 5 at **any** date, or tier 1 when past due. `Deferred` upgrades never enter the queue, even with validation Failed, and appear in Upcoming only inside the +15..+30 window (§9.1). |
| D-05 | Horizons are literal offsets in the reference SQL: +14 for tier 5, +1..+3 for tier 6, +4/+1..+14 for Upcoming tasks and touches, and +15..+30 for Upcoming upgrades. |
| D-06 | All-day fields are `YYYY-MM-DD`. Instants are UTC with milliseconds. Alert `days_delta` uses the **local** calendar day of `opened_at` (§9.1). |
| D-07 / D-08 / Q-5 | No schema change was needed. Side effects are audited as `client.next_contact_changed` / `client.last_contact_changed` with `source='System'` and a `reason` that names the cause. The seed keeps `last_contact` equal to the latest Meeting or Call note date (verified). |
| **D-11** (revised by the PM) | Updates send **`expected_row_version`** (integer), compared with the row's `row_version` column. The DB advances `row_version` by exactly 1 on every UPDATE (QA-1-3). A mismatch returns 409 `stale_write`. Every read payload includes `row_version`. See §2.2. |
| D-12 / Q-3 | `ON DELETE CASCADE` runs from `clients` to every child table. `audit_events.client_id` has no FK, so history survives (tested). |
| D-22 / Q-2 | Retention is not a schema concern. Backups are named `tam_<UTC>_<reason>_v<schema>.db` so a retention job can prune only `pre-delete` and `pre-migration` files. |

## 2. Conventions

- **Instants:** fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` in UTC (`migrate.utc_now()`). String order equals time order. The CHECK is `x IS strftime('%Y-%m-%dT%H:%M:%fZ', x) AND substr(x,1,10) IS date(x,'+0 days')`.
- **All-day dates:** `YYYY-MM-DD`. The CHECK is `x IS date(x,'+0 days')`.
- **Why the CHECKs use `IS` and `'+0 days'`.** A CHECK whose expression is NULL *passes* in SQLite, and `date('2026-10-1')` is NULL. Separately, `date('2026-02-30')` echoes its input; only a modifier forces normalisation. Tests cover `'soon'`, `'garbage'`, `02-30`, `T25:00` and space-separated forms.
- **IDs:** entities use TEXT ids (UUIDs from the app; uuid5 in the seed). Append-only logs use `INTEGER PRIMARY KEY AUTOINCREMENT`.
- **Booleans** are `INTEGER` with `CHECK IN (0,1)`.
- **Identity text** (account, contact, server and BAMS object names, task titles) must be trimmed and contain **no tab, CR or LF** (CHECK).
- **Case-insensitivity:** `COLLATE NOCASE` on names folds ASCII only. The backend must also compare with `casefold()`.
- **Connection pragmas** are set by the opener (`migrate.connect`): `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- **Portability:** the minimum is SQLite 3.35. There is no STRICT, no generated columns and no JSON1 in the schema or the reference queries.

### 2.1 Upserts: `REPLACE` is banned; native upserts are allowed (QA-1-2, QA-2-1, QA-2-2)

**Banned everywhere, in every spelling:**
- `INSERT OR REPLACE`
- `REPLACE INTO`
- `UPDATE OR REPLACE`
- `ON CONFLICT REPLACE` in DDL
- ORM equivalents: SQLAlchemy `.prefix_with('OR REPLACE')` and `sqlite_on_conflict*='REPLACE'`

REPLACE resolves a conflict by *deleting* rows:
- On a primary-key clash it fires `ON DELETE CASCADE`. An "edit account" written as REPLACE wipes all the account's children.
- On a secondary-key clash it deletes a **different** row, such as the old primary contact or another account with that name, with no audit row.

**Allowed, and required for these use cases:**

| Use | Idiom |
|---|---|
| Create | Plain `INSERT` with a fresh uuid |
| Edit (D-09 / D-11) | `UPDATE t SET ..., updated_at=:now, row_version=row_version+1 WHERE id=:id AND row_version=:expected` |
| §25 re-import (Account + Server + Release) | `INSERT ... ON CONFLICT(client_id, server_name, schedule_year, schedule_quarter) DO UPDATE SET ...` |
| §33 notification "attempt at most once" | `INSERT ... ON CONFLICT(event_id, kind, channel) DO NOTHING`, or `INSERT OR IGNORE` |
| §37 imports | `ON CONFLICT(name) DO UPDATE` (accounts), `ON CONFLICT(ticker) DO UPDATE` (metrics), `INSERT OR IGNORE` |
| §27 repeated breach | `INSERT ... ON CONFLICT(metric_id, coalesce(rule_id,'')) WHERE status <> 'closed' DO UPDATE SET last_triggered_at = ...` |

All of these are tested as working.

**Design: why the enforcement is split, and why this design.** A BEFORE INSERT `RAISE` fires *before* conflict resolution. An INSERT-side guard therefore cannot tell `INSERT OR REPLACE` from `ON CONFLICT DO UPDATE`, `DO NOTHING` or `INSERT OR IGNORE` (verified empirically). Review 1's INSERT-side guards broke all the legitimate idioms above (QA-2-1), so they were removed. The resulting design:

1. **INSERT side: contract plus tested scanner** (rebuilt in review 3 and hardened in review 4: QA-3-1/2, QA-4-1/2/3). `db/sql_safety_scan.py`:
   - **Scope:**
     - code: `.py/.pyw/.pyi/.sql/.ts/.tsx/.js/.jsx/.mjs/.cjs`
     - launchers and scripts: `.sh/.bash/.zsh/.ps1/.psm1/.bat/.cmd`, for deployment-agent's launchers that call the `sqlite3` CLI
   - **Skips are anchored to the scan root:** `web/`, `db/tests/`, `frontend/dist/`, plus vendor and tool folders at any depth (`node_modules`, `.venv`, `venv`, `__pycache__`, `.git`). `server/web/`, `server/api/tests/` and the like **are** scanned.
   - **Decoding never drops content.** It is BOM-aware (UTF-8-SIG, UTF-16 LE/BE, UTF-32). BOM-less UTF-16 is detected by NUL density; otherwise strict UTF-8 with a latin-1 fallback.
   - **Comment-aware lexer:** removes only real comments, and never text inside a string literal:
     - Python `#`
     - SQL `--` and `/* */`
     - JS/TS `//` and `/* */`
     - sh/PowerShell `#` at the start of a word, and `<# #>`
     - batch `REM` / `::` lines

     **In `.sql` files the contents of single-quoted literals are dropped too**, because there they are data, never code. Seed text such as `'Do not REPLACE INTO prod (seriously)'` is therefore not flagged (QA-4-3 F10).
   - **String seams** (quotes, backticks, `+`, `,`, escaped `\n`/`\t`, line continuations) are erased so split statements match. Each finding reports its source line.
   - **Patterns.** The table is **any non-space token**, so placeholders match: `{table}`, `{}`, `{0}`, `%s`, `%(t)s`, `${table}`, `[t]`, `` `t` ``, `main.t`, or a variable joined with `+` (QA-4-1).
     - `INSERT OR REPLACE INTO`
     - `UPDATE OR REPLACE <t> SET`
     - `REPLACE INTO <t> [AS alias]` followed by `(`, VALUES, SELECT, DEFAULT or WITH, and not after `.`
     - `ON CONFLICT REPLACE`
     - SQLAlchemy `prefix_with([text(]'OR REPLACE')` and `sqlite_on_conflict*='REPLACE'`
     - peewee `.on_conflict_replace()`, `.on_conflict('replace')`, `Model.replace(kw=…/**…)` and `.replace_many(…)`. `Model.replace` only matches a Capitalised receiver, so `datetime.replace(hour=0)`, `os.replace`, `dataclasses.replace` and `df.replace` stay clean.
     - sqlite-utils `replace=True`
     - Kysely `.orReplace()`
     - pandas `if_exists=replace`, including options passed through a dict (`"if_exists": "replace"`). Pandas `to_sql` must never target entity tables in any mode.
     - a bare `OR REPLACE` in `.sql` unless followed by `(` (the `replace()` function)
   - **Allow marker:** a finding is exempt only if one of its lines carries `sql-safety: allow <reason>` with a reason of at least 3 characters. **A bare marker exempts nothing** and the finding says so (QA-4-2 E11). `python db/sql_safety_scan.py --list-allow` lists every marker with its reason for QA 3.2 review. The tree currently has none (tested).
   - **Accepted false positives (QA-4-3, fail closed).** UI copy or non-SQL string data that literally reads like a statement is flagged and needs a reasoned marker. Examples: "Insert or replace into the list", "Replace into list (3 items)", and a Python message `"Do not REPLACE INTO prod (seriously)"`. These are tested as flagged without a marker, cleared with one, and still flagged with a bare one. Telling such prose from SQL would mean weakening the patterns that catch real statements, and a missed REPLACE costs far more than one marker.
   - **Tests:**
     - **Generated corpus:** 572 cases (11 banned idioms × table forms × wrappers). Python covers dq, sq, raw, bytes, f-string, `%`, `%()`, `.format`, `+` concatenation, implicit concatenation, triple-quoted multi-line and backslash continuation. JS/TS covers dq, sq, templates with `${}`, multi-line templates, concatenation and array join. SQL covers plain, multi-line, comments between every word, and statements after tricky literals. Scripts cover sh/bash/bat/cmd/ps1.
     - 44 ORM and other banned forms.
     - 57 legitimate negatives (string, datetime, os, pandas and router `replace`; allowed upsert idioms; comments; UI copy; SQL `replace()`; script comments).
     - A scratch tree covering encodings, launchers, an E1 repository helper and allow-marker listing.
     - A mutation check during review 4 confirmed the corpus discriminates: the review-3 `REPLACE INTO` pattern would miss 102 of the 572.
   - **Known limit:** a statement whose **keywords** are assembled at runtime (`"INSERT OR %s INTO" % verb`, `f"{verb} INTO …"`) cannot be seen statically. Placeholder *table names* are covered. The contract forbids the pattern, and QA 3.2 reviews it.
   - The single INSERT-side guard kept is `trg_contacts_one_primary_on_insert`, because no keyed upsert of a *primary* contact is ever legitimate.
2. **UPDATE side: database triggers.** `UPDATE OR REPLACE` fires no INSERT trigger. A legitimate UPDATE never moves a key onto another row's value, because it would fail UNIQUE anyway. So BEFORE UPDATE guards cost nothing legitimate. They cover every secondary unique key:
   - `clients.name`
   - primary contact
   - upgrade identity, both release and ad-hoc
   - window PK
   - `bams_objects` (client, name)
   - `bams_metrics` ticker and (object, metric)
   - the single active alert
   - `bams_alert_configs.name`
   - `bams_notification_log` keys

   **Ids are immutable** on all 13 id-keyed tables, which also closes `UPDATE OR REPLACE SET id = <other id>`. Tested on 14 `UPDATE OR REPLACE` statements, with no row lost.
3. **`audit_events`**: any insert that reuses an existing id is refused, and UPDATE and DELETE are always refused.

This is the sounder design. The database guarantees what it can without false positives (the UPDATE side, the primary contact, audit). The one gap a trigger cannot close without breaking §25, §33 and §37 is covered by a scanner that is tested against adversarial spellings and runs on every test run.

**Duplicate-key error contract (QA-2-1).** Every uniqueness failure, whether raised natively by SQLite or by a guard trigger, is an `sqlite3.IntegrityError` whose message **starts with `UNIQUE constraint failed: <table>`**. Examples:
- `UNIQUE constraint failed: clients.name`
- `UNIQUE constraint failed: contacts.client_id (one primary contact per account)`

The backend maps that prefix to 409 `conflict`. One behavioural note: `INSERT OR IGNORE` of a *second primary contact* raises instead of silently ignoring it. Creating a contact must never be silently dropped.

### 2.2 Optimistic concurrency: `row_version` (QA-1-3)

- Every editable entity table has `row_version INTEGER NOT NULL DEFAULT 1`. The 12 tables are: clients, contacts, tasks, notes, support_cases, quarterly_upgrade_windows, server_upgrades, bams_objects, bams_metrics, bams_alert_rules, bams_alert_events, bams_alert_configs.
- **Triggers guarantee that every UPDATE advances it by exactly 1.**
  - A statement may set `row_version = row_version + 1` itself.
  - If it doesn't touch the column, `trg_<t>_row_version_bump` (AFTER UPDATE) does it.
  - Any other value is refused by `trg_<t>_row_version_guard`.
  - FK `SET NULL` actions bump it too.
  - The token is clock-independent and cannot be forgotten by a write path.
- Write pattern: `UPDATE ... WHERE id=:id AND row_version=:expected`. If rowcount is 0, the backend checks whether the row exists and returns 404 `not_found` or 409 `stale_write`. Two stale writers were tested: the result was `(1, 0)`.
- **RETURNING trap (QA-2-3).** `UPDATE ... RETURNING row_version` reports the *pre-trigger* value when the statement relies on the auto-bump (tested: it returns 1 while 2 is stored). **Writers must always bump explicitly (`row_version = row_version + 1`)**, which RETURNING reports correctly. Count changes with `cursor.rowcount`, never `total_changes`: the auto-bump trigger's inner UPDATE adds to `total_changes`.
- **Monitor writes (QA-2-6).** On `bams_metrics` and `bams_alert_rules` the auto-bump fires only for user-editable configuration columns:
  - metrics: `object_id`, `metric_name`, `ticker`, `enabled`, `stale_after_seconds`, `stale_suppressed`
  - rules: `metric_id`, `rule_type`, `operator`, `threshold`, `reference_period`, `consecutive_updates`, `severity`, `cooldown_minutes`, `enabled`

  60 s poller writes (`current_value`, `last_*`, `high_*`, `breach_count`, `suppress_until_clear`) therefore never cause a 409 on a user's edit (tested). On those two tables `updated_at` means "configuration last edited". **Alert close** does not use the token: it is `UPDATE bams_alert_events SET status='closed', closed_at=:now, closed_note=:n WHERE id=:id AND status IN ('open','recovered')`, and rowcount 0 means it was already closed.
- `updated_at` remains informational (the "Updated" column). The app still sets it on each UPDATE. **The `updated_at >= created_at` CHECK was removed**, so a wall-clock step back can no longer turn an edit into a 500 (tested). The seed verifier still checks that ordering on mock data.

## 3. ER diagram

```mermaid
erDiagram
    clients ||--o{ contacts : "has (cascade)"
    clients ||--o{ tasks : "has, nullable client_id (cascade)"
    clients ||--o{ notes : "has (cascade)"
    clients ||--o{ support_cases : "has (cascade, unused)"
    clients ||--o{ server_upgrades : "has (cascade)"
    clients ||--o{ bams_objects : "has (cascade)"
    quarterly_upgrade_windows ||--o{ server_upgrades : "release (RESTRICT, nullable)"
    bams_objects ||--o{ bams_metrics : "cascade"
    bams_metrics ||--o{ bams_alert_rules : "cascade"
    bams_metrics ||--o{ bams_alert_events : "cascade"
    bams_alert_rules |o--o{ bams_alert_events : "SET NULL (only closed events; guard)"
    bams_metrics ||--o{ bams_metric_samples : "cascade"
    bams_alert_events ||--o{ bams_notification_log : "cascade"
    clients ||..o{ audit_events : "client_id, NO FK (survives delete)"

    clients { text id PK; text name UK "NOCASE"; text status; text bpid; text products; text last_contact; text next_contact; text notes; int row_version }
    contacts { text id PK; text client_id FK; text name; text role; text email; text team; int is_primary "<=1 per client"; int row_version }
    tasks { text id PK; text task; text client_id FK "nullable"; text category; text priority; text due; text next_update; text status; text waiting; int archived; int row_version }
    notes { text id PK; text client_id FK; text note_type; text timestamp; text subject; text body; text action_items; text source; int row_version }
    audit_events { int id PK; text timestamp; text category; text client_id; text object_type; text object_id; text object_label; text action; text old_value; text new_value; text reason; text source }
    quarterly_upgrade_windows { int schedule_year PK; text schedule_quarter PK; text dev_upgrade_date; text east_prod_date; text west_prod_date; text apics_version; int row_version }
    server_upgrades { text id PK; text client_id FK; text server_name; text environment; text polarity; int schedule_year FK; text schedule_quarter FK; text scheduled_date; text status; text validation_status; int row_version }
    bams_objects { text id PK; text client_id FK; text name "UK per client"; text region; text location; text environment; int enabled; int row_version }
    bams_metrics { text id PK; text object_id FK; text metric_name; text ticker UK; real current_value; text last_received; int row_version }
    bams_alert_rules { text id PK; text metric_id FK; text rule_type; text operator; real threshold; text reference_period; text severity; int row_version }
    bams_alert_events { text id PK; text metric_id FK; text rule_id FK; text severity; text status; text opened_at; text recovered_at; text closed_at; int row_version }
    bams_metric_samples { int id PK; text metric_id FK; text sampled_at; real value }
    bams_alert_configs { text id PK; text name UK; text metric_match; text rule_type; text severity; int starter; int row_version }
    bams_notification_log { int id PK; text event_id FK; text kind; text channel; int success }
    support_cases { text id PK; text client_id FK; text case_type; text reference_id; int escalated; int row_version }
    app_meta { text key PK; text value }
```

## 4. Table-by-table rationale

| Table | Purpose and key decisions |
|---|---|
| `app_meta` | Key/value store (`WITHOUT ROWID`). Keys are listed in §10. It is the only table where REPLACE is harmless; `ON CONFLICT DO UPDATE` is still preferred. |
| `clients` | `name` is UNIQUE NOCASE, trimmed, with no control characters. Status is Active or Inactive. The legacy `contact` column is kept per §33. There are no health, sales or CMDB fields. `ix_clients_next_contact_active` serves Today tier 4 and Upcoming touches. |
| `contacts` | **`ux_contacts_one_primary ON contacts(client_id) WHERE is_primary=1`** enforces zero or one primary contact. UNIQUE is checked per row, so a primary switch must clear the old flag first, then set the new one, in one transaction. `trg_contacts_one_primary_on_insert/_on_update` refuse a second primary on any path, including REPLACE, OR IGNORE and UPDATE OR REPLACE, with the native-style message. |
| `tasks` | §11 enums are CHECKed with defaults (Other, Medium, Not Started). `client_id` may be NULL (D-20). `ix_tasks_open_due` (partial: open, non-archived) is the Today single-pass index. `ix_tasks_client_open` serves the account tab, Overview and counts. |
| `notes` | Manual notes only. `source` is one of GUI, Migration, Bulk Import or ChatGPT Bridge (**not System**). Subject or body is required. `ix_notes_client_ts` serves the timeline. |
| `support_cases` | Exists with an FK and CHECKs. It has no UI, API or seed rows (§33 "optional"). |
| `audit_events` | Append-only (§35). Three triggers protect it: `no_update`, `no_delete` (unconditional) and **`no_replace`** (refuses reuse of an existing id, QA-1-1). The only delete path is `migrate.purge_audit_events()` (§7). `client_id` has no FK (D-12). `object_label` is an addition (§7). Indexes: `ix_audit_client_ts` (timeline), `ix_audit_ts` (Recently Changed), `ix_audit_object` (object history). |
| `quarterly_upgrade_windows` | PK is `(schedule_year, schedule_quarter)` per §33. |
| `server_upgrades` | §22/§23 enums. PROD requires East or West and DEV requires DEV (CHECK). A release is both columns or neither. The FK to windows is **ON DELETE RESTRICT** (§20). Identity indexes: `ux_server_upgrades_identity` (Account + Server + Release, §25) and **`ux_server_upgrades_adhoc_identity`** `(client_id, server_name, coalesce(scheduled_date,'')) WHERE schedule_year IS NULL` for ad-hoc upgrades. The `coalesce` makes undated ad-hoc duplicates collide too (QA-1-7 residual). |
| `bams_objects` | Name UNIQUE per client (NOCASE, no control characters). **Addition:** nullable `environment`. **Precedence (QA-1-15):** the header and environment summary take environment from the server's `server_upgrades` rows, using the most recent release. `bams_objects.environment` is used only for BAMS-only appliances with no upgrade record. |
| `bams_metrics` | `ticker` is UNIQUE, and `(object_id, metric_name)` is UNIQUE. `last_received` NULL with `current_value` NULL means **No Data**. `updated_at` and `row_version` track configuration edits only (QA-2-6). |
| `bams_alert_rules` | Rule shape is CHECKed. **`trg_bams_alert_rules_no_delete_active`**: a rule with non-closed events cannot be deleted directly (QA-1-8). Cascades from metric, object or account deletion still work, because the parent row is already gone when the trigger fires (tested). |
| `bams_alert_events` | The §27 lifecycle is a CHECK, plus **`closed_at >= recovered_at`** (QA-1-6). `ux_bams_alert_events_one_active` allows one non-closed event per (metric, rule), or per metric for stale alerts. |
| `bams_metric_samples` | Read only by `(metric_id, sampled_at)` range. |
| `bams_alert_configs` | Starter and reusable rule templates. |
| `bams_notification_log` | `UNIQUE(event_id, kind, channel)`. |

**Invariants enforced in the database:**
- one primary contact
- unique account names
- every enum
- date and instant formats
- no control characters in identity text
- polarity rules
- release integrity
- §25 identity, including ad-hoc upgrades
- alert lifecycle and ordering
- single active alert
- rule-delete guard
- audit immutability (update, delete, replace)
- `UPDATE OR REPLACE` and id-change refusal on every key
- second primary contact on any insert path
- `row_version` monotonicity
- cascade versus survival on delete

**Left to the app** (QA-1-9; QA 3.2 tests these in the backend):
- trimming before insert
- the REPLACE ban on the INSERT side (§2.1: scanner)
- non-ASCII case folding
- strict email syntax (`a@@b..c` passes the basic CHECK)
- JSON validity of audit values
- pairing of audit `category` with `object_type`
- `high_30 <= high_60 <= high_90` (provider data is stored as received, not rejected)
- `scheduled_date` / `target_version` derivation
- the D-07 and D-08 side effects

## 5. Cascade matrix

| Delete of | Effect |
|---|---|
| client | Cascades to contacts, tasks, notes, support_cases, server_upgrades and bams_objects, and from there to metrics, rules, events, samples and the notification log. Audit rows stay. This works even with open alerts (tested). |
| bams_alert_rule (direct) | **Refused while it has non-closed events.** Close them first, then delete. The closed events keep `rule_id = NULL`. |
| quarterly_upgrade_window | **RESTRICT** while any upgrade references it. |
| task, note, contact | The row only. The audit `deleted` row keeps `old_value` and `object_label`. |

## 6. Migration runner contract (T-02)

`migrate.py` implements this contract and the tests prove each point.

1. Files are named `migrations/NNNN_<snake>.sql`, numbered from 0001 with no gaps. They are forward-only and immutable once released. Each file ends by raising `schema_version` to its own number. All 0001 statements are `IF NOT EXISTS` or a guarded upsert.
2. The runner reads `app_meta.schema_version`:
   - No `app_meta` and no tables means fresh (version 0). **An empty file with a foreign `application_id` is refused** (QA-1-14d).
   - Tables present without `app_meta`, or a wrong `application_id`, means refuse.
   - A version above the newest known migration means refuse.
3. If nothing is pending, there are no schema writes and no backup.
4. **Pre-migration safety backup.** If the DB is at version ≥ 1 and migrations are pending:
   1. Run `quick_check`.
   2. Call `backup_hook(conn, "pre-migration")` using **`sqlite3.Connection.backup()`**, never a file copy. `online_backup()` also runs `integrity_check` on the copy.
   3. If the hook raises, or there is no hook, nothing is migrated.
5. Each migration runs in one `BEGIN IMMEDIATE` transaction with its version bump and a `migration.NNNN.applied_at` stamp. The runner checks the version and `foreign_key_check` before COMMIT. Any error rolls back the whole migration.
6. **Guard check on every open** (QA-1-4, QA-2-5). `assert_guards()` builds `schema.sql` in memory and compares the **normalised SQL** of all 51 declared triggers. A missing trigger is refused ("missing"), as is a same-name trigger with a different or neutered body ("altered"), and **any undeclared extra trigger** ("undeclared triggers present", QA-3-4). **Packaging (deployment-agent):** `db/schema.sql` must ship with the app, because the runner reads it at startup.
7. **Channel stamp** (QA-1-14c, QA-2-4, QA-3-3). `channel` is a **required keyword argument** of `migrate()`. The app passes `'dev'` or `'prod'` on every open, and the CLI requires `--channel`. Only tooling and tests may pass `channel=None` explicitly, which skips the channel check and emits a `UserWarning`. All refusals are decided **before anything is written**:
   - a PROD open of a DB carrying **either** `db.mock_seed` **or** `bams.mock_clock` is refused, and nothing is stamped, so DEV can still open it (tested)
   - a channel mismatch is refused
   - only then is `db.channel` stamped on first open
8. Future table rebuilds follow sqlite.org/lang_altertable.html (12 steps, `foreign_keys=OFF` outside the transaction). The runner will grow a `-- tam:foreign_keys=off` directive when needed. A rebuild must also re-create the table's guard triggers; `assert_guards` catches an omission.
9. The backend logs the result dict at startup and writes a `schema`/`migrated` audit row with `source='Migration'` when anything was applied.

Online backup under live WAL writes was tested: the copy passes `integrity_check`, contains every row committed before the backup, and has no FK violations.

## 7. Audit conventions (US-1.5, §35)

- **One row per logical write, in the same transaction as the data.** A primary switch writes one `primary_changed` row. D-07 and D-08 side effects write their own row (`source='System'`, `reason` names the cause).
- **`category`**: `crm`, `operations`, `bams`, `settings`, `data`, `system`.
- **`object_type`**: client, contact, task, note, support_case, server_upgrade, quarterly_upgrade_window, bams_object, bams_metric, bams_alert_rule, bams_alert_event, bams_alert_config, setting, backup, schema, import, bridge.
- **`action`** (snake_case):
  - `created`, `updated`, `deleted`
  - task: `completed`, `reopened`, `archived`, `unarchived`
  - contact: `primary_changed`
  - client: `status_changed`, `next_contact_changed`, `last_contact_changed`
  - schema: `migrated`
  - later phases: `imported`, `applied`
- **`old_value` / `new_value`**: JSON of the changed fields only. On create, `new` is a snapshot. On delete, `old` is a snapshot. No secrets or BSSO material.
- **`object_label`** (addition) is the display label at write time (task title, contact name, note subject, server, account, setting key, backup file). It lets Activity render after deletes. **Privacy note (§46):** a deleted contact's *name* persists in `audit_events.object_label` and `old_value`. This is consistent with §35 (history must survive). Removing it would need a deliberate audit purge, which only `purge_audit_events()` can do.
- **`source`**: `GUI`, `System`, `Migration`, and later `Bulk Import` and `ChatGPT Bridge`.
- **Immutability:** UPDATE is always refused. DELETE is always refused. An INSERT that reuses an existing id is refused, which blocks REPLACE and upsert rewrites.
- **The only purge path is `migrate.purge_audit_events(conn, where_sql)`.** It must run inside the caller's open transaction. It reads the delete-guard DDL from `sqlite_master`, drops the trigger, deletes, and re-creates the trigger. DDL is transactional, so a crash or ROLLBACK can never leave deletes enabled, and there is **no persistent flag** (the old `maintenance.audit_purge_allowed` key is gone and ignored; tested). Users: the DEV reseed now, and a retention job if ever specified.
- **Activity mapping (D-03 / PM §3.2)** in `activity_timeline.sql`. The backend generates these sentences:

  | object.action | Sentence |
  |---|---|
  | task.created / completed / reopened / archived / deleted | "Task {action}: {label}" |
  | contact.created / updated / deleted | "Contact added / updated / removed: {label}" |
  | contact.primary_changed | "{label} is now primary (was {old.primary_contact})" |
  | note.deleted | "{old.note_type} deleted: {label}" |
  | client.next_contact_changed | "Next client touch set to {new.next_contact}" |
  | client.status_changed | "Account marked {new.status}" |
  | server_upgrade.* | "Server upgrade {created→scheduled, updated→new status}: {label}" |
  | bams_alert.opened / recovered / closed | "BAMS alert {what}: {subject} ({severity})" |

## 8. Mock data (T-03)

**Determinism.** `random.Random(20261012)`, uuid5 ids and anchor date **2026-10-12** produce a byte-identical `generate`. A test also fails if the committed JSON is stale. Names, organisations, `MOCK.*` tickers and `*.example.com` emails are fictional. **Release versions are deliberately fictional** (`7.1.4` / `7.2.0` / `7.3.0`, `mock-cd-*`, `mock-mfa-*`), not the §21 fixture values (QA-1-13).

**Rebase rules** (the loader and `MockDataSource` must both apply them; they are embedded in the JSON's `rebase` block):

1. `delta = today_local − anchor_date` (days). `date_fields` shift by `delta`. `instant_fields` shift by `delta` days, keeping the time of day. Inside audit `old_value`/`new_value`, keys in `json_date_keys` / `json_instant_keys` shift the same way.
2. **BAMS freshness fields** (`now_relative_fields`: `bams_metrics.last_received`, `last_source_update`; `bams_metric_samples.sampled_at`, `source_update`) shift by **exactly `load_now − anchor_now`** (`anchor_now = 2026-10-12T12:00:00.000Z`), not by whole days. This keeps every metric's freshness state at any load time (QA-1-5). `load_now` is the real UTC time when seeding for the real local today; otherwise it is `today 12:00Z`.
3. `(schedule_year, schedule_quarter)` shift by whole quarters (`qidx(today) − qidx(anchor)`).
4. Apart from rule 2, nothing is stamped later than "yesterday 20:00Z".

**BAMS freshness states (§27 bands, ages at load time):**

| State | Definition | Seed rows |
|---|---|---|
| Live | ≤ 75 s | 75 metrics |
| Delayed | 76-120 s | 4 metrics (KMC second object) |
| Stale | > 120 s | 12 metrics: OLP's first object, 33 h, matching its open stale alert; the Inactive AVC account, ~40 days |
| No Data | `last_received`, `current_value` and highs all NULL | 4 metrics: the disabled CPG appliance and one MEM metric on an enabled MRA object |

**Frozen mock clock rule (QA-1-5, binding on backend and frontend).** Nothing updates BAMS metrics in this run; the provider is Phase 4. Load-time-correct ages would decay to all-Stale within 2 minutes. Therefore:

- **DEV DB / backend.** The loader writes `app_meta['bams.mock_clock']` (the load instant). **While that key exists, the channel is `dev`, and no BAMS provider is running, freshness age = `bams.mock_clock − last_received`**, not wall time. `queries/metric_freshness.sql` implements the rule (params `:wall_now`, `:provider_running`, `:channel`; with `channel='prod'` the wall clock always applies, QA-3-3), and the backend must compute freshness through it or an identical expression. When a provider runs (Phase 4, BLPAPI or the DEV simulator), the wall clock applies. PROD never carries the key, because mock-seeded DBs are refused in PROD.
- **`MockDataSource`.** Compute age as `anchor_now − last_received` on the *un-rebased* JSON values, which is the same frozen instant. Equivalently, use your own load instant against the rebased values, and never the live clock.
- **Verification uses real elapsed time.** The verifier evaluates `metric_freshness.sql` at the **real** UTC now, not the stamp. Tests advance the wall clock by 130 s, 1 day and 30 days and still see Live, Delayed, Stale, No Data and Disabled. They also show that with `provider_running=1` the wall clock applies and nothing stays Live. A verifier run against real time, for a DB whose load instant was set about 36 h in the past, still reported Live 75, Delayed 4, Stale 12, No Data 1 (enabled metric), and Disabled 3 (the disabled CPG appliance).

**Accepted drift (QA-1-13).** Window labels shift by quarters while window dates shift by days. For some load dates a window's dates fall outside its labelled quarter or on a different weekday. **Accepted for mock data:**
- the Today tiers need day-relative dates (East at T+12, West at T+19, DEV at T−23)
- labels must stay distinct and consecutive
- relabelling by date can make two 91-day-apart windows collide in a 92-day quarter

Real windows come from the Phase 3 schedule sync and never use the rebase rule.

**Volume** (as loaded):

| Rows | Table |
|---|---|
| 12 | clients (10 Active, 2 Inactive) |
| 35 | contacts |
| 166 | tasks (every status, priority and category) |
| 210 | notes |
| 756 | audit_events (every row has `object_label`) |
| 3 | windows |
| 79 | server_upgrades (all 8 statuses) |
| 25 | bams_objects |
| 95 | bams_metrics |
| 165 | bams_alert_rules |
| 26 | bams_alert_events |
| 576 | bams_metric_samples |
| 5 | bams_alert_configs |
| 21 | bams_notification_log |

Entity rows carry `row_version` 1, or 2 if edited.

**Scenario catalogue**

| Purpose | Rows |
|---|---|
| Tier 1 | Overdue tasks at every priority plus one with no account. A Waiting task with a past due date lands in tier 1, not 4. Open Critical alerts (HFA, CPG). Overdue upgrades: DEV In Progress (BRS), past-dated Validation Required (CPG), previous-quarter Exception (HFA). |
| Tier 2 | Due today at High, Medium and Low, plus a Waiting task due today, which lands in tier 2, not 4. |
| Tier 3 | Open Warning (NWH, MRA), Info (KMC), stale (OLP, no rule), recovered Warning (BRS) and recovered Critical (TBF). |
| Tier 4 | Waiting tasks with `next_update` today, in the past or NULL. Touches at or before T (NWH, HFA, TBF). |
| Tier 5 | East upgrades at T+12; Completed + Pending (NWH); Completed + Failed (MRA, KMC). |
| Tier 6 | Due T+1..T+3, including a Waiting task whose `next_update` is in the future. |
| Upcoming | Tasks T+4..T+14; a Waiting task with `next_update` T+5; touches; West upgrades at T+19; an ad-hoc upgrade at T+26. |
| Exclusions | Inactive account AVC (overdue task, open Critical alert, upgrade within 14 days). Archived and Complete overdue tasks. Deferred and Completed + Not Required upgrades. Upgrades beyond 30 days. A disabled appliance. |
| Edge cases | SCS has zero primary contacts. LHF has no BAMS objects. NWH primary moved A to B. A contact with no email. A deleted contact, deleted tasks and deleted notes (audit only). An alert closed while breaching, with `suppress_until_clear`. A failed desktop notification. `NWH-BPIPE-NY-01` and `nwh-bpipe-ny-01` count as one server. `Migration`-sourced notes. |

**Commands**

```
python db/seed_mock.py generate
python db/seed_mock.py load   --db dev_data/tam_dev.db [--today YYYY-MM-DD]
python db/seed_mock.py load   --db ... --reset           # DEV reseed (backend: safety backup first)
python db/seed_mock.py verify --db ... [--today YYYY-MM-DD]
```

**Seed safety (QA-1-14, QA-2-4).** These guards live **inside `load()`**, so `/api/dev/reseed` inherits them:
- It refuses a main DB file named `tam_command_center.db`. The CLI also pre-checks the name, so it doesn't create an empty file.
- It refuses a DB whose `db.channel` is `prod`.
- It refuses a populated DB unless `reset=True`.
- **Reseed keeps the user's `setting.*` rows**: defaults are inserted with `ON CONFLICT DO NOTHING`.
- The audit purge goes through `purge_audit_events()`.
- It stamps `db.channel='dev'`, `db.mock_seed` and `bams.mock_clock`.

## 9. Query patterns

### 9.1 Today queue (PM §3.1). Authoritative SQL: `queries/today_queue.sql`

Each object kind is classified by **one CASE expression whose WHEN order is the tier order**, so "first qualifying tier only" is structural:

```sql
-- tasks (archived=0, status<>'Complete', client NULL or Active)
CASE WHEN due <  :t THEN 1
     WHEN due =  :t THEN 2
     WHEN status='Waiting' AND (next_update IS NULL OR next_update <= :t) THEN 4
     WHEN due BETWEEN :t+1 AND :t+3 THEN 6 END
-- clients (Active, next_contact NOT NULL, and NOT EXISTS an open non-archived
-- 'Client Follow-Up' task with due = next_contact: D-23 suppression, queue AND Upcoming)
CASE WHEN next_contact <= :t THEN 4 END
-- bams_alert_events (status open|recovered, account Active, object AND metric enabled)
CASE WHEN status='open' AND severity='Critical' THEN 1 ELSE 3 END
-- server_upgrades (account Active, NOT (Completed AND validation IN (Passed, Not Required)))
CASE WHEN scheduled_date < :t AND status NOT IN ('Completed','Deferred') THEN 1
     WHEN status <> 'Deferred'                                        -- D-24
      AND (   (scheduled_date BETWEEN :t AND :t+14 AND status <> 'Completed')
           OR status IN ('Validation Required','Exception')            -- D-24: any date
           OR validation_status='Failed'
           OR (status='Completed' AND validation_status='Pending')) THEN 5 END
-- Upcoming upgrades: T+15..T+30 and status <> 'Completed' (Deferred included, D-24)
-- tasks: context = 'Next Client Touch' when category='Client Follow-Up' AND due = next_contact (D-23)
```

Within-tier sort follows §3.1:

| Tier | Sort |
|---|---|
| 1 | Critical alerts, then priority (non-tasks after Low), then date |
| 2 | Priority, then title |
| 3 | Open before recovered, Warning before Info, then `opened_at` |
| 4 | Date |
| 5 | Date |
| 6 | Due date, then priority |

**NULL dates sort last in every tier** (QA-1-11a). The final tie-breakers are `kind` and `id`.

**Review-1 decisions:**
- **Alerts on a disabled BAMS object or disabled metric are excluded** from Today and from the alert counts (`account_summary.sql`). Monitoring that is switched off is not actionable. Infrastructure still lists the objects. (QA-1-11c: intent confirmed.)
- **Alert `days_delta`** uses `date(opened_at,'localtime')`. SQLite's `localtime` is the process timezone, which is the workstation's, as D-06 requires (QA-1-11b). The backend must not recompute it in UTC.

Seed counts for today = 2026-10-12, in a fresh run:

| Tier | Items | Breakdown |
|---|---|---|
| 1 | 15 | 2 alerts, 10 tasks, 3 upgrades |
| 2 | 5 | |
| 3 | 6 | |
| 4 | 17 | 14 tasks, 3 touches |
| 5 | 15 | |
| 6 | 7 | |
| Upcoming | 45 | |

Every tier has at least 2 items.

### 9.2 Index-to-query map (corrected, QA-1-10)

Every row below is from `EXPLAIN QUERY PLAN` of the reference queries on the seeded DB (SQLite 3.38.2). Indexes that no reference query or FK needed were **dropped**: `ix_tasks_waiting_next_update`, `ix_server_upgrades_open_date`, `ix_server_upgrades_validation` and `ix_bams_alert_events_active`. Phase 3 and 4 add their own indexes by forward migration when their queries exist.

| Query | Plan (relevant lines) |
|---|---|
| `today_queue.sql` | tasks: `SCAN tk USING INDEX ix_tasks_open_due` (one pass over the open-task partial index; every task tier comes from it). Touches: `SEARCH c USING INDEX ix_clients_next_contact_active`. Primary contact: `ix_contacts_client`. Alerts: `SCAN m` → `ix_bams_alert_events_metric`. Upgrades: `SCAN c` → `ix_server_upgrades_client_date`. The alert and upgrade predicates live inside CASE expressions, so these are per-account or per-metric scans. That is fine at hundreds of rows (§45). |
| `account_summary.sql` | `ix_tasks_client_open` (covering), `bams_objects(client_id,name)`, `bams_metrics(object_id,metric_name)`, `ix_bams_alert_events_metric`, `ix_server_upgrades_client_date`, `ux_server_upgrades_identity` (covering, for the server count). |
| `activity_timeline.sql` | `ix_notes_client_ts`, `ix_audit_client_ts`, `bams_objects(client_id,name)` → metrics → `ix_bams_alert_events_metric`. |
| `recent_changes.sql` | `SCAN a USING INDEX ix_audit_ts`. The audit branch is ordered and LIMITed on its own (`INDEXED BY ix_audit_ts`), so it walks newest-first and stops early instead of sorting the unbounded audit table on every refresh. **Note (QA-2-7):** `INDEXED BY` makes renaming or dropping `ix_audit_ts` a hard query error. That is deliberate: fail loudly rather than silently degrade. Any migration touching that index must update this query. The BAMS branch now has a full tie-break (`ts DESC, id DESC, what DESC`), so its top-N is deterministic (tested). |
| `metric_freshness.sql` | Per-metric join over `bams_metrics` → `bams_objects` (PK). Small table; no extra index. |
| `object_history.sql` | `ix_audit_object`. |

These indexes exist for FKs, cascades and integrity rather than for a reference query: `ix_support_cases_client`, `ix_server_upgrades_release`, `ix_bams_alert_rules_metric`, `ix_bams_alert_events_rule`, `ix_bams_metric_samples_metric_ts` (also the §45 trend access path), and the four `ux_*` unique indexes.

Activity pagination (seed): page 1 has 50 rows and page 2 has 19, with no overlap. Each filter returns only its own type. The cursor key `entry_key` is unique across sources. Search covers note text, audit `object_label` and JSON, and BAMS message and server name, using `ESCAPE '\'`.

## 10. `app_meta` keys

| Key | Value |
|---|---|
| `schema_version` | `'1'` |
| `migration.NNNN.applied_at` | instant |
| `db.channel` | `dev` \| `prod`, stamped on first open (§6.7) |
| `db.mock_seed` | JSON stamp: `format`, `anchor_date`, `rebased_to`, `bams_now`, `loaded_at` (DEV only) |
| `bams.mock_clock` | Frozen BAMS freshness clock, an instant (DEV mock only; §8) |
| `setting.default_landing` | `today` \| `accounts` \| `tasks` |
| `setting.time_display` | `local` \| `gmt` |
| `setting.auto_refresh_minutes` | `off` \| `1` \| `5` \| `15` |
| `setting.log_level` | `INFO` \| `DEBUG` |
| `setting.open_browser_on_start` | `0` \| `1` |
| `schedule.*` (Phase 3) | schedule diagnostics cache |

The `maintenance.audit_purge_allowed` flag from review 1 no longer exists and has no effect.

## 11. Explicitly not built

- **No vector index, embedding table or RAG store** exists or is planned. The spec replaced RAG with the ChatGPT Bridge (copy context out, paste a structured update back, Preview, Apply). Bridge writes are audited with `source='ChatGPT Bridge'`.
- There are no health scores, sales fields, CMDB or dependency tables, or multi-user, auth or RBAC tables.
- There is no FTS5 index this run. `LIKE` is fast enough at hundreds of rows. FTS5 can be added by migration if needed.

## 12. Hand-offs and limitations

- **Backend (T-10 to T-13)** must:
  - Open DBs via `migrate.connect()` and call `migrate.migrate(conn, backup_hook, channel=<mode>)` on every startup. `channel` is required. That covers the guards and the channel check.
  - **Never use REPLACE in any spelling** (§2.1). Use the allowed idioms table. The scanner test fails the build.
  - Map `IntegrityError` starting with `UNIQUE constraint failed:` to 409 `conflict`.
  - Use `row_version` for D-11 and **always bump explicitly**, especially with RETURNING. Report 404 versus 409 when rowcount is 0. Use rowcount, not `total_changes`.
  - Close alerts with the status-conditional UPDATE (§2.2).
  - Compute BAMS freshness with the frozen mock clock rule (§8, `metric_freshness.sql`).
  - Write the primary switch as two UPDATEs (clear, then set).
  - Write exactly one audit row with `object_label` per write.
  - Casefold-check names.
  - Build `:q_like` with escaping.
  - Take the online pre-delete backup before `/api/dev/reseed` calls `seed_mock.load(..., reset=True)`.
  - Leave alert `days_delta` local, as computed in SQL.
- **PM:**
  - Resolved: D-11 now uses `expected_row_version`; QA-1-12 is answered by D-23 and D-24, which are implemented in `today_queue.sql` and tested. The backend service and `MockDataSource` must mirror the same predicates.
- **Frontend (T-23)** must apply both rebase rules in §8, including the exact-offset BAMS freshness rule, and compute freshness against the frozen mock clock, never the live clock.
- **Deployment (T-42)** must ship `db/schema.sql`, `db/migrations/` and `db/queries/` with the app. `assert_guards` reads `schema.sql` at startup. The JSON is about 869 KB with one row per line; samples and audit rows make up most of it.
- **Windows:** validated on macOS only (Python 3.9.12 / SQLite 3.38.2 here; QA also ran 3.10, 3.12 and 3.14). It remains **untested on the Windows workstation** (§56).

## 13. QA `SCHEMA_REVIEW_1` dispositions

| ID | Sev | Disposition | Where / test |
|---|---|---|---|
| QA-1-1 | High | **Fixed.** `trg_audit_events_no_replace` refuses inserts that reuse an id, which blocks REPLACE, INSERT OR REPLACE and upsert rewrites. | `QA_1_1_AuditReplace` (2 tests) |
| QA-1-2 | High | Superseded by the review-2 design (§2.1, §14: QA-2-1 and QA-2-2). | `QA_1_2_and_2_1_2_2_ReplaceDesign` |
| QA-1-3 | Medium | **Fixed.** `row_version` on 12 tables with a +1-only guard and an auto-bump trigger. The `updated_at >= created_at` CHECK was removed. | `QA_1_3_RowVersion` (5 tests) |
| QA-1-4 | Medium | **Fixed.** No persistent flag. `purge_audit_events()` does a transactional drop/delete/recreate. `assert_guards()` refuses a DB with missing triggers on every open. | `QA_1_4_AuditPurge` (5 tests) |
| QA-1-5 | Medium | **Fixed.** Exact now-relative rebase for BAMS freshness fields. The seed has Live, Delayed, Stale and No Data metrics. The verifier checks each band. | `QA_1_5_BamsFreshness`; verifier |
| QA-1-6 | Low | **Fixed.** CHECK `closed_at >= recovered_at`. | `test_1_6_*` |
| QA-1-7 | Low | **Fixed.** `ux_server_upgrades_adhoc_identity` plus a matching REPLACE guard. | `test_1_7_*` |
| QA-1-8 | Low | **Fixed in the DB** rather than by contract. `trg_bams_alert_rules_no_delete_active` refuses direct deletion of a rule with non-closed events, so it can never push an open event into the stale slot. Cascades still work. | `test_1_8_*` (2 tests) |
| QA-1-9 | Low | **Partly fixed:** `notes.source` excludes System; no tab, CR or LF in identity text. **Accepted, app-level (§4):** strict email syntax, because RFC email validation in CHECK is brittle; category/object_type pairing, because the backend's audit helper owns the pairing; `high_N` ordering, because provider data is stored as received; non-ASCII case, because NOCASE is ASCII-only and casefold happens in the backend. | `test_1_9_*` |
| QA-1-10 | Low | **Fixed.** Three unused indexes were dropped. Recently Changed was restructured to use `ix_audit_ts`. §9.2 now quotes real plans. `object_history.sql` was added. | §9.2 |
| QA-1-11 | Low | **Fixed:** (a) NULL dates last; (b) local-day `days_delta` for alerts; (c) disabled objects and metrics excluded (intent confirmed). | `test_1_11_*` |
| QA-1-12 | Low | **Resolved by PM D-23 and D-24** and implemented in review 3 (§15). | `PM_D23_D24_TodayQueue` |
| QA-1-13 | Low | **Fixed:** fictional version strings. **Accepted:** quarter-label versus day-date drift in mock windows (reasons in §8). | §8 |
| QA-1-14 | Low | **Fixed:** (a) guard inside `load()`; (b) reseed keeps settings; (c) `db.channel` stamped and checked, and a PROD open of a mock DB is refused; (d) an empty file with a foreign `application_id` is refused. | `test_1_14_*` (2 tests) |
| QA-1-15 | Low | **Documented:** `object_label` privacy note (§7) and environment precedence (§4). | — |

## 14. QA `SCHEMA_REVIEW_2` dispositions

| ID | Sev | Disposition | Where / test |
|---|---|---|---|
| QA-2-1 | Medium | **Fixed.** All INSERT-side secondary-key guards were removed except the primary contact. The natural-key idioms now work: §25 re-import DO UPDATE and DO NOTHING; notification log DO NOTHING and INSERT OR IGNORE; account-name, ticker and config-name upserts; the §27 partial-index alert upsert; INSERT OR IGNORE on objects. The false doc claim is corrected. The error-text contract is `UNIQUE constraint failed: <table>…` everywhere. | `test_2_1_*` (4 tests) |
| QA-2-2 | Medium | **Fixed.** BEFORE UPDATE guards on every secondary unique key, plus id immutability on 13 tables, refuse `UPDATE OR REPLACE` with nothing deleted (14 statements tested). `ON CONFLICT REPLACE` and all spellings are added to the ban. The new `sql_safety_scan.py` works on whole normalised files, covers multi-line, concatenated, `prefix_with`, `sqlite_on_conflict`, DDL, `.mjs` and `.cjs`, and is corpus-tested (13 positive, 8 negative), file-tested and codebase-tested. **Design choice** (the coordinator allowed choosing): a trigger cannot block INSERT-side REPLACE without re-breaking QA-2-1, so that side relies on contract plus the tested scanner. Rationale in §2.1. | `test_2_2_*` (5 tests), `test_insert_side_*` |
| QA-1-5 (reopened) | Medium | **Fixed.** A binding frozen mock clock rule (`bams.mock_clock` plus `metric_freshness.sql`) covers both the backend and `MockDataSource`. The verifier now measures at real wall time. Tests advance the clock by 130 s, 1 day and 30 days and all states persist; a running provider switches to the wall clock. | `QA_1_5_FrozenMockClock` (3 tests); verifier |
| QA-1-7 (residual) | Low | **Fixed.** The ad-hoc identity index uses `coalesce(scheduled_date,'')`, so undated duplicates collide. | `test_1_7_adhoc_null_date_duplicates_refused` |
| QA-2-3 | Low | **Fixed (contract plus test).** Always bump explicitly. RETURNING after an implicit bump is stale (demonstrated). Use rowcount, not `total_changes`. | `test_2_3_*`, §2.2 |
| QA-2-4 | Low | **Fixed.** Refusals are checked before the stamp: a refused PROD open writes nothing and DEV can still open the DB. `channel` is a required keyword; `None` is tooling-only and warns. The CLI requires `--channel`. | `test_2_4_*` (2 tests) |
| QA-2-5 | Low | **Fixed.** `assert_guards` compares normalised trigger SQL, so a neutered same-name trigger is refused. Packaging of `schema.sql` is flagged for deployment-agent (§12). | `test_2_5_*` |
| QA-2-6 | Low | **Fixed now, not deferred.** Poller columns on `bams_metrics` and `bams_alert_rules` do not bump `row_version`. Alert close uses a status-conditional UPDATE. | `test_2_6_*`, §2.2 |
| QA-2-7 | Low | **Fixed.** Deterministic tie-break in the BAMS branch. The `INDEXED BY` hard dependency is documented in §9.2 and in the query. | `test_2_7_*` |
| QA-1-12 | Low | **PM-owned.** No schema change. | §12 |

## 15. QA `SCHEMA_REVIEW_3` dispositions and PM follow-ups

| ID | Sev | Disposition | Where / test |
|---|---|---|---|
| QA-3-1 | Medium | **Fixed.** Scanner rebuilt (§2.1):<br>• (a) root-anchored skips; nested `web`/`tests`/`dist` and `.pyw`/`.pyi` are scanned<br>• (b) a comment-aware lexer replaces line regexes, so comment markers inside strings never hide code<br>• (c) new patterns for SQLAlchemy `text('OR REPLACE')`, peewee `on_conflict_replace()`/`on_conflict('replace')` and pandas `if_exists='replace'`; escaped `\n` and backslash continuation normalised<br>• (d) every QA case is in the corpus, plus a scratch-tree test | `test_2_2_scanner_catches_every_spelling` (25 positive / 16 negative), `test_2_2_scanner_scans_files_and_suffixes` |
| QA-3-2 | Low | **Fixed.** Contextual patterns: SQL `replace()` after `OR`, `.replace("INTO", …)`, `label.replace(' into ', …)`, UI copy ("Replace into template", "Update or replace your logo") and prose docstrings are no longer flagged. A per-line `sql-safety: allow <reason>` marker covers deliberate quotes of a banned statement. | corpus negatives, scratch tree `server/allowed.py` |
| QA-3-3 | Low | **Fixed (both suggestions).** PROD refuses a DB carrying `bams.mock_clock` even without `db.mock_seed`, and writes nothing. `metric_freshness.sql` takes `:channel` and honours the mock clock only in `dev`. | `test_3_3_*` (2 tests) |
| QA-3-4 | Low | **Fixed.** `assert_guards` refuses undeclared extra triggers. | `test_3_4_undeclared_trigger_refused` |
| PM D-23 | — | **Implemented.** NOT EXISTS suppression of the touch item in queue and Upcoming; `Next Client Touch` context on the task. Different dates or a Complete task keep both. Seed scenarios: HFA (tier 2), BRS (tier 6 / Upcoming), TBF (different dates). The verifier checks all three. | `PM_D23_D24_TodayQueue` (2 tests); verifier |
| PM D-24 | — | **Implemented.** Exception at any date goes to tier 5 (tier 1 if past); Deferred is never queued, including Deferred + Failed, and is shown in Upcoming at +15..+30. Seed scenarios: LHF Exception at T+45, SCS Deferred at T+22, MRA Deferred + Failed at T+5. | `test_d24_*`; verifier |
| D-11 doc | — | **Fixed.** §1 now states `expected_row_version`. | §1 |

## 16. QA `SCHEMA_REVIEW_4` dispositions (scanner only; no schema, migration, seed or query change)

| ID | Sev | Disposition | Where / test |
|---|---|---|---|
| QA-4-1 | Medium | **Fixed.** The `REPLACE INTO` and `UPDATE OR REPLACE` table token is now any non-space token, so f-string, `%s`, `.format` and JS `${}` placeholders match. E1-E5 are in the corpus, E1 is in the scratch tree, and the 572-case generated corpus covers every table form × wrapper. | `test_4_1_*` (2 tests), `test_4_2_encodings_and_scripts_in_a_scratch_tree` |
| QA-4-2 | Low | **Fixed:** E5 `AS alias`; peewee `Model.replace()` / `replace_many()`; pandas `if_exists` via a dict; BOM-aware and UTF-16-aware decoding; `.sh/.bash/.zsh/.ps1/.psm1/.bat/.cmd` scanned; a bare allow marker no longer exempts; `--list-allow` added for QA 3.2. Also added: sqlite-utils `replace=True`, Kysely `.orReplace()`. | `test_4_2_*` (2 tests), corpus |
| QA-4-3 | Low | **F10 fixed:** `.sql` single-quoted data is never scanned. **F6 accepted** with reasons (§2.1), together with two sibling cases. All are tested as fail-closed and clearable only with a reasoned marker. | `test_4_3_*` (2 tests) |

