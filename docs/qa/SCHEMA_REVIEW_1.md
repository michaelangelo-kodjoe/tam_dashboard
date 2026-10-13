# Schema Review 1 (Gate 1.3)

| | |
|---|---|
| Reviewer | qa-guardrail-agent |
| Date | 2026-10-12 |
| Scope | `TAM_Command_Center/db/` (`schema.sql`, `migrations/0001_initial.sql`, `migrate.py`, `queries/*.sql`, `seed_mock.py`, `mock_data.json`, `tests/test_db_contract.py`) and `docs/03_DATA_MODEL.md` |
| Measured against | `docs/SPEC.md` (§4, §13, §21-§27, §33, §35, §36, §52), `docs/01_PM_SPEC.md` (§0, §2, §3), `docs/TEAM_LOOP.md` |
| Source edits by QA | None. Scratch DBs and probe scripts are in the session scratchpad only. |

## 1. What I ran (independent reproduction)

| Check | Command / method | Result |
|---|---|---|
| Raw schema load | `sqlite3 raw.db < db/schema.sql` (SQLite 3.38.2 CLI) | `integrity_check` ok, `foreign_key_check` empty, `application_id` 1413565763 (0x54414D43). 16 user tables (plus `sqlite_sequence`), 22 explicit indexes, 2 triggers, `schema_version=1` |
| Migration twice | `python3.10 db/migrate.py mig.db` run 2x | `{'from': 0, 'to': 1, 'applied': ['0001_initial.sql'], 'backup': None}` then `{'from': 1, 'to': 1, 'applied': [], 'backup': None}`. No-op confirmed |
| Schema == migration chain | `migrate.py --verify-schema` | `IDENTICAL`. `diff schema.sql 0001_initial.sql` differs only by the 5-line header comment |
| Contract tests | `python -m unittest discover -s TAM_Command_Center/db/tests` on Python 3.9.12/SQLite 3.38.2, 3.10.14/3.53.4, 3.12.4/3.45.3, 3.14.7/3.53.4 | `Ran 22 tests ... OK` on all four |
| Seed load + verify | `seed_mock.py load/verify --today 2026-10-12` into scratch DB | Loaded 12/35/166/210/0/3/79/25/95/165/26/576/5/21/756 rows. `VERIFY: PASS`. Tiers 1-6 = 19/4/6/15/15/5, Upcoming 39 |
| Seed safety | load into `tam_command_center.db`; second load without `--reset` | Both refused (exit 1) |
| Adversarial probes | 35 probes (audit bypass, REPLACE semantics, concurrency token, cascades, CHECK gaps, migration edge cases) | Findings below |
| Today queue edge cases | Hand-built DB with ad-hoc/Exception/Deferred upgrades, disabled BAMS object, Client Follow-Up task + touch | Findings below |
| `EXPLAIN QUERY PLAN` | `today_queue.sql` on seeded DB | Tasks use `ix_tasks_open_due`, touches use `ix_clients_next_contact_active`; alerts and upgrades are full `SCAN e` / `SCAN u` |

## 2. Findings

Severity scale per the QA role: Blocker / High / Medium / Low. Owner is the agent that must act.

### QA-1-1 · High · Owner: data-architect-agent · Spec §35, PM US-1.5, 03_DATA_MODEL §4 ("audit immutability" enforced in DB)
**`audit_events` append-only protection is bypassed by `INSERT OR REPLACE` / `REPLACE INTO`.**
SQLite's REPLACE conflict resolution deletes the conflicting row without firing DELETE triggers (unless `recursive_triggers` is on, which is off by default) and fires no UPDATE trigger. An existing audit row can therefore be silently rewritten or forged.
Evidence (probe P1/P1b, fresh migrated DB, default pragmas):
```
INSERT OR REPLACE INTO audit_events(id,...,new_value) VALUES(1,...,'{"task":"FORGED"}')  -> [ALLOWED] [(1, '{"task":"FORGED"}')]
REPLACE INTO audit_events(id,category,object_type,action,source) VALUES(1,'crm','task','deleted','GUI') -> [ALLOWED] [(1, 'deleted', None)]
```
(`ON CONFLICT DO UPDATE` is correctly blocked by the UPDATE trigger, as P2 shows.) The test `test_audit_append_only` does not cover REPLACE.
Expected: no statement other than the documented maintenance path can change or remove an existing audit row.
Fix verified in scratch: add `CREATE TRIGGER trg_audit_events_no_replace BEFORE INSERT ON audit_events WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;`. With it, REPLACE is aborted and normal inserts still work. Add a contract test for it.

### QA-1-2 · High · Owner: data-architect-agent (contract + test); backend-dev-agent must comply · PM D-09 ("save is an upsert"), D-12, §13
**With this schema, the common `INSERT OR REPLACE` upsert idiom silently mass-deletes data, and neither the hand-off contract nor the tests warn about it.**
REPLACE deletes the old row, so `ON DELETE CASCADE` runs and the partial unique index resolves conflicts by deleting the *other* row. PM D-09 makes every `*/save` an upsert, so this idiom is likely to appear in the backend.
Evidence:
```
INSERT OR REPLACE INTO clients(id,name,notes) VALUES('c1','Acme','edited')   -- an "edit account"
after REPLACE client save: tasks= 0 contacts= 0                              -- all children cascaded away
INSERT OR REPLACE INTO contacts(id,client_id,name,is_primary) VALUES('z','c1','Z',1)
-> [('a', 0), ('z', 1)]   -- contact 'b' (the existing primary) was DELETED, with no audit row
```
Expected: the data-model contract (03 §12) explicitly forbids `REPLACE` / `INSERT OR REPLACE` on every entity table and requires `INSERT ... ON CONFLICT(id) DO UPDATE` or an explicit `UPDATE`. A contract test should demonstrate the hazard, and QA 3.2 will grep the backend for `REPLACE`. Optionally, add guard triggers on `clients` and `contacts`.

### QA-1-3 · Medium · Owner: data-architect-agent · PM D-11 (optimistic concurrency)
**`updated_at` is a weak optimistic-concurrency token.**
1. It is only as unique as the clock's millisecond: `migrate.utc_now()` returned **7 distinct values over 2,000 calls** (probe P4b). Two writes in the same millisecond produce the same token.
2. The token changes only if every write path remembers to set it (03 §2 says this is deliberately not done by a trigger). An `UPDATE` that omits `updated_at` leaves the token unchanged, so a second stale writer still matches. Probe P4: `UPDATE ... WHERE updated_at=?` succeeded twice in a row, `(1, 1)`.
3. If the wall clock steps back (NTP correction), `CHECK (updated_at >= created_at)` makes every edit to recently created rows fail with `IntegrityError` (probe P4c: `CHECK constraint failed: updated_at >= created_at`). That surfaces as a 500, not a `stale_write`.

Expected: a monotonic token that does not depend on the clock. For example, add `row_version INTEGER NOT NULL DEFAULT 1` to every editable entity, increment it on each UPDATE (by trigger, or app-enforced with a test), and use it for D-11. Alternatively, keep `updated_at` but specify `max(now, old.updated_at + 1 ms)` and add a guard trigger that rejects an UPDATE that does not advance it. Document how the clock-skew CHECK interacts with this.

### QA-1-4 · Medium · Owner: data-architect-agent · §35, 03 §4/§10
**The audit-delete maintenance flag is not confined to a transaction.**
`trg_audit_events_no_delete` only checks that `app_meta['maintenance.audit_purge_allowed']='1'`. If any code path commits that row (a crash between steps of a non-transactional job, or a retention job written in autocommit), audit deletes stay permanently enabled with no signal. Probe P3: the flag was inserted in autocommit, then `DELETE FROM audit_events` was `[ALLOWED]` and 0 rows remained.
Expected: the purge path drops and recreates the delete trigger inside its own transaction (DDL is transactional in SQLite), which removes the need for a persistent flag. Otherwise the opener must refuse to start, or clear and log, when the flag is present at startup, and a test must cover it.

### QA-1-5 · Medium · Owner: data-architect-agent · PM US-9.1 (worst metric status), §26/§27 stale handling, PM §2.8 coverage
**The mock BAMS data cannot show any metric state except Stale.**
All 95 metrics have the same `last_received` (`2026-10-11T03:00:01.200Z`, about 35 h before load time). There is no metric with NULL `last_received` or `current_value`, so there is no "No Data" state. The "nothing later than yesterday 20:00Z" rule means rebasing keeps every metric beyond the 120 s stale threshold. As a result, the Infrastructure tab's in-scope "worst metric status" column and any Live / Delayed / Stale / No Data styling cannot be exercised on mock data, in either the DEV DB or the `MockDataSource`.
Evidence: `select max(last_received), min(last_received) from bams_metrics` → both `2026-10-11T03:00:01.200Z`; `sum(last_received is null)` = 0.
Expected: a documented freshness rule for BAMS time fields, for example "rebase `last_received`/`last_source_update` relative to load time (now minus N seconds)", with seeded metrics in each of Live (≤75 s), Delayed (76-120 s), Stale (>120 s) and No Data (NULL), and a verifier check for each.

### QA-1-6 · Low · Owner: data-architect-agent · §27
`bams_alert_events` does not order `closed_at` against `recovered_at`. Probe P8n: `status='closed'` with `recovered_at=2026-10-05` and `closed_at=2026-10-02` was `[ALLOWED]`. Add `CHECK (closed_at IS NULL OR recovered_at IS NULL OR closed_at >= recovered_at)`.

### QA-1-7 · Low · Owner: data-architect-agent · §25
Upgrades with no release escape `ux_server_upgrades_identity` because NULLs are distinct. Probe P6: two ad-hoc upgrades for `srv`/`SRV` on the same account were both accepted. This is acceptable for Phase 1-2, but the Phase 3 contract should state how ad-hoc identity works (for example, a partial unique index on `(client_id, server_name, scheduled_date) WHERE schedule_year IS NULL`).

### QA-1-8 · Low · Owner: data-architect-agent · §27, 03 §5
Deleting a rule SET-NULLs an open event's `rule_id`, and that event then takes the metric's "stale" slot in `ux_bams_alert_events_one_active` (`coalesce(rule_id,'')`). Probes P7/P7b/P7c: after deleting rule `r1`, event `e1` stayed `('e1', None, 'fixed_threshold', 'open')`; deleting `r2` then failed with `UNIQUE constraint failed`; and a later stale alert on that metric cannot open. The fail-safe for a second deletion is documented, but the silent suppression of stale alerts after the first deletion is not. The Phase 4 contract must require closing a rule's active events before deleting the rule (03 §5 says this) and a test for it.

### QA-1-9 · Low · Owner: data-architect-agent · PM §3.2 validation
Some CHECK gaps are left to the app. They are listed so QA 3.2 can test them in the backend:
- P8b: email `a@@b..c` is accepted.
- P8d: `trim()` strips spaces only, so the name `'Bob\n'` is accepted.
- P8g: `notes.source='System'` is allowed even though notes are manual only (D-03).
- P8i: `category`/`object_type` pairing is not enforced (`bams`/`note` accepted).
- P8m: `high_30 > high_90` is accepted.
- P8c: non-ASCII case duplicates (`éclair`/`ÉCLAIR`) are accepted. This one is documented.

### QA-1-10 · Low · Owner: data-architect-agent · 03 §9.2 accuracy
03 §9.2 states, "from `EXPLAIN QUERY PLAN` on the seeded DB", that Today upgrades use `ix_server_upgrades_open_date` and Today alerts use `ix_bams_alert_events_active`. For the reference `today_queue.sql`, the plan is `SCAN u` and `SCAN e`, and `ix_server_upgrades_validation` is not used by any reference query. Performance is irrelevant at this scale, but the documentation claim is wrong. Correct the table or drop the unused index.

### QA-1-11 · Low · Owner: data-architect-agent · PM §3.1 sort, D-06
Today queue details:
- (a) Tier 5 "date ascending" sorts NULL `scheduled_date` first. An ad-hoc Validation Required upgrade with no date led tier 5 in the edge DB.
- (b) For alerts, `days_delta` takes the UTC date of `opened_at` against the local `:today`. An alert opened `2026-10-13T01:00Z` showed `days_delta=1` (in the future) for local today 2026-10-12. The backend must compute this in local time.
- (c) Alerts on a disabled BAMS object or disabled metric still enter the queue. Confirm the intent.

### QA-1-12 · Low · Owner: pm-agent · PM D-07 vs §3.1; SPEC §24
- (a) A Client Follow-Up task created by D-07 and the `next_contact` it sets produce **two queue items for one obligation** (edge DB: `tf` in tier 2 and `client_follow_up` for the same account and date in tier 4). Decide whether to de-duplicate.
- (b) An `Exception` upgrade more than 14 days out appears only in Upcoming, although §24 "Needs Attention" lists Exception and Deferred. This is consistent with PM §3.1 as written, so it is the PM's call.

### QA-1-13 · Low · Owner: data-architect-agent · SPEC §21, mock realism
The mock `2026 Q4` window reuses the spec's real APICS `4.78.0` but has different dates: DEV 2026-09-19, East 2026-10-24, West 2026-10-31. The §21 fixture is 10-09 / 11-13 / 11-20. Rebasing also shifts window dates by days while the labels shift by quarters. Loaded with `--today 2026-12-31`, the window labelled `2026 Q4` has PROD dates `2027-01-12`/`2027-01-19` and `2026 Q3` has PROD dates in October, all on Tuesdays. The verifier does not check that dates fall inside the labelled quarter. Use clearly fictional version strings or align with §21, and keep window dates inside their quarter (or document the drift).

### QA-1-14 · Low · Owner: data-architect-agent · SPEC §4 DEV/PROD isolation
- (a) The PROD-name guard is only in the CLI (`_assert_dev_target`). `seed_mock.load()`, which the backend `/api/dev/reseed` will call, has no guard.
- (b) Reseed also deletes all `setting.*` rows, which silently resets the user's DEV settings.
- (c) Apart from `db.mock_seed`, nothing in the DB records which channel created it. An empty or real-data DEV DB carries no DEV marker. Recommend `app_meta['db.channel']` stamped at creation and checked by the opener against the running mode.
- (d) Probe P9c: an empty file with a foreign `application_id` (12345) is adopted and re-stamped as TAMC. This is harmless because the file is empty, but noted.

### QA-1-15 · Low · Owner: data-architect-agent · additions beyond §33
- `audit_events.object_label` is **accepted**. It is justified by D-03/D-12. Privacy note: contact names persist in audit after the contact is deleted. That is consistent with §35, but it should be mentioned in the §46 privacy notes.
- `bams_objects.environment` is **accepted**. It is nullable and CHECKed. It can disagree with `server_upgrades.environment` for the same server name (the seed has 0 mismatches). The header summary needs a precedence rule; document which source wins.

## 3. Review of the data architect's flagged items

The data architect's 11-item list was not handed to QA as a file. I reconstructed it from the hand-offs and limitations in `03_DATA_MODEL.md` §12, §5 and §2 and verified each item independently.

| # | Flagged item | QA disposition |
|---|---|---|
| 1 | Backend must set connection pragmas (WAL, FK, busy_timeout, synchronous) | Accepted. `migrate.connect` does it, and a WAL file was verified after reopen (`journal_mode: wal`). |
| 2 | Use `migrate.migrate()` with an online-backup hook | Accepted. No-hook refusal, failing-hook abort and backup integrity were reproduced by the tests. |
| 3 | Primary switch = clear then set, in one transaction | Accepted. **Extend it** with the REPLACE ban (QA-1-2). |
| 4 | App sets `updated_at` on every UPDATE as the D-11 token | **Rejected as specified** (QA-1-3). |
| 5 | Exactly one audit row with `object_label` per write | Accepted as a backend contract. The DB cannot enforce it, so QA 3.2 will test it. |
| 6 | Casefold-check account names (NOCASE folds ASCII only) | Accepted (P8c confirms the gap is real). |
| 7 | Build `:q_like` with escaping | Accepted. |
| 8 | Refuse a PROD start on a DB stamped `db.mock_seed` | Accepted. Insufficient on its own (QA-1-14c). |
| 9 | Frontend `MockDataSource` applies the rebase rule | Accepted. The rule itself has a quarter/day drift (QA-1-13) and BAMS freshness gap (QA-1-5). |
| 10 | Windows workstation untested | Accepted and stays flagged (§56). QA additionally verified on Python 3.10/3.12/3.14 on macOS only. |
| 11 | Close a rule's active events before deleting the rule (Phase 4) | Accepted. The side effect on stale alerts is undocumented (QA-1-8). |

## 4. Gate checklist

| Area | Result |
|---|---|
| §33 completeness | **Pass.** All 16 tables and every listed column are present (checked column by column against `PRAGMA table_info`). Only additions: `audit_events.object_label` and `bams_objects.environment` (QA-1-15). §33 `UNIQUE(client_id,name)`, `ticker UNIQUE`, `name UNIQUE` (configs), `UNIQUE(event_id,kind,channel)` and `PRIMARY KEY(schedule_year,schedule_quarter)` are all present. |
| Enum CHECKs (PM §2.2) | **Pass.** Task category/priority/status, note_type, client status, upgrade env/polarity/status/validation, alert status, severity and audit source are all CHECKed. Bad values are rejected in the tests and probes. |
| One primary contact per account | **Pass** in the DB (`ux_contacts_one_primary`). See QA-1-2 for the REPLACE hazard. |
| Normalization / FKs / FK-child indexes | **Pass.** Every FK child column has a leading index. `audit_events.client_id` intentionally has no FK (D-12). |
| Cascade semantics | **Pass with notes.** Client delete cascades to contacts, tasks, notes, support_cases, upgrades and BAMS, down to the notification log, while audit survives (test plus probe). Windows are RESTRICT (tested). Rule delete is SET NULL (QA-1-8). A `clients.id` update with children is blocked (P8k). |
| Audit append-only | **Fail** (QA-1-1, QA-1-4). |
| Optimistic concurrency | **Fail** (QA-1-3). |
| Migration idempotence / safety | **Pass.** No-op rerun, guarded re-execution, refusal of newer and foreign DBs, rollback of a failed migration and the pre-migration backup were all reproduced. |
| WAL / backup compatibility | **Pass.** Online backup under concurrent WAL writes passes `integrity_check`. No `shutil.copy` on a live DB (`shutil` appears only in tests, for temp dirs and fixture copies). |
| PM Today tiers vs `today_queue.sql` | **Pass with Lows.** Tier predicates, first-tier-wins, exclusions, Upcoming windows and within-tier sorts match PM §3.1 for all the edge cases I built. Details in QA-1-11 and QA-1-12. Seeded tier counts for 2026-10-12: 19 / 4 / 6 / 15 / 15 / 5, with 39 in Upcoming. Every tier has at least 2 items. |
| Mock realism / coverage | **Partial.** Fictional names, `example.com` emails and `MOCK.*` tickers. Audit rows reconcile with entity state (49 completed tasks = 49 `completed` rows; 13 archived = 13 `archived` rows). Every PM §2.8 edge case is present. Fails on BAMS freshness (QA-1-5); window realism is Low (QA-1-13). |

## 5. Re-review conditions

To pass Gate 1.3 on review 2, the data architect must:
- Fix QA-1-1 and QA-1-2 (High).
- Fix QA-1-3, QA-1-4 and QA-1-5 (Medium).
- Add a contract test for each one.
- Update `03_DATA_MODEL.md`, `TAM_PROJECT_STATE.md` and `CHANGELOG.md`.
- Answer each Low item: fix it, or record it as accepted with a reason.

Because schema v1 has not been released, `0001_initial.sql` may still be edited in place. After that, the forward-only rule applies.

VERDICT: REJECTED
