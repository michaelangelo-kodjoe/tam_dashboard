# Schema Review 2 (Gate 1.3, re-review)

| | |
|---|---|
| Reviewer | qa-guardrail-agent |
| Date | 2026-10-12 |
| Scope | `TAM_Command_Center/db/` as revised after `SCHEMA_REVIEW_1.md`, and `docs/03_DATA_MODEL.md` (dispositions in §13) |
| Gate rule applied | Same as Gate 3.2: approval requires zero open Blocker, High or Medium items. Lows are tracked. |
| Source edits by QA | None. Probe scripts and scratch DBs are in the session scratchpad (`.../scratchpad/qa/r2/`). |

## 1. Independent reproduction

| Check | Result (quoted) |
|---|---|
| Contract tests: Python 3.9.12/SQLite 3.38.2, 3.10.14/3.53.4, 3.12.4/3.45.3, 3.14.7/3.53.4 | `Ran 47 tests ... OK` on all four |
| `migrate.py --verify-schema` | `verify-schema: IDENTICAL`. `0001_initial.sql` equals `schema.sql` plus its header. |
| Raw `schema.sql` load (sqlite3 CLI 3.38.2) | `integrity_check` ok, `foreign_key_check` empty. 17 tables (16 + `sqlite_sequence`), 19 indexes, 36 triggers. |
| CLI migrate with `--channel dev`, run twice, then with `--channel prod` | `{'from': 0, 'to': 1, ...}`, then `{'from': 1, 'to': 1, 'applied': [] ...}`, then `refused: DB belongs to channel 'dev'; refusing to open it as 'prod'` (exit 1) |
| Seed load + verify (real local today) | `VERIFY: PASS`. Tiers 1-6 = 15/5/6/17/15/7, Upcoming 45. Freshness bands at load time: Live 75, Delayed 4, Stale 12, No Data 4. |
| DEV reseed (`--reset`) | `setting.log_level` stayed `DEBUG`. `db.channel=dev`. 36 triggers present. A direct `DELETE FROM audit_events` afterwards was refused (`audit_events is append-only`). |
| Original review-1 probes (`probes.py`), re-run unchanged | Results per finding in §2 |
| New regression probes (`regress.py`, 31 probes on SQLite 3.38.2 and 3.53.4) | Results in §3 |

## 2. Re-verification of review-1 findings

| ID | Sev (R1) | Status | Evidence (re-run by QA) |
|---|---|---|---|
| QA-1-1 audit REPLACE bypass | High | **FIXED** | P1 and P1b are now `[BLOCKED] ... IntegrityError: audit_events is append-only`. Same with `recursive_triggers=ON` (P3b). Upsert is still refused (P2). |
| QA-1-2 REPLACE mass-deletes data | High | **REOPENED (as Medium)** | `INSERT OR REPLACE` with a secondary-key clash is now blocked (P5b: `contacts: unique key already used by another row`). A PK `INSERT OR REPLACE` on `clients` still cascades (`tasks= 0`). That is accepted on the strength of the codebase scan. **However, `UPDATE OR REPLACE` bypasses both the guards and the scan.** See QA-2-2. |
| QA-1-3 weak concurrency token | Medium | **FIXED** | R6: two stale writers on `row_version` gave `(1, 0)`. The guard refuses jumps. `recursive_triggers=ON` still bumps by exactly 1 (R12 → `(2,)`). A clock step-back no longer causes a 500 (P4c ALLOWED, as intended). A bulk 20,000-row UPDATE took 0.05 s, every row at row_version 2. One residual Low: QA-2-3. |
| QA-1-4 audit-delete flag persists | Medium | **FIXED** | P3 is now BLOCKED (the flag has no effect). R11: `purge_audit_events` in autocommit raises `must run inside a transaction`. Purge followed by ROLLBACK leaves `rows now 1, guard present True`. R10b: a dropped guard is refused on open. Residual Low: QA-2-5. |
| QA-1-5 mock BAMS shows only Stale | Medium | **REOPENED** | Bands are correct only at load time and against the verifier's frozen `bams_now`. Measured on the freshly loaded DB against real time: **+0 s → 75/4/12/4; +80 s → 0/37/54/4; +130 s → 0/0/91/4** (Live/Delayed/Stale/No Data). Two minutes after load, the DEV DB is all Stale apart from No Data, which is the original defect. See §4. |
| QA-1-6 close before recover | Low | **FIXED** | P8n: `CHECK constraint failed: ... closed_at >= recovered_at` |
| QA-1-7 ad-hoc duplicates | Low | **PARTIALLY FIXED (Low, open)** | A dated duplicate is blocked. Ad-hoc upgrades with a **NULL** `scheduled_date` still duplicate: `('a3',...,None)` and `('a4',...,None)` were both ALLOWED, and so was P6. The index key includes a NULLable column. |
| QA-1-8 rule delete and stale slot | Low | **FIXED** | P7: `close this rule's active alerts before deleting the rule`. R8: deleting a metric, object or client that owns an open rule-driven alert works in 8 of 8 cases each, with 0 failures. |
| QA-1-9 CHECK gaps | Low | **FIXED (partly) / ACCEPTED** | P8d (newline) and P8g (`source='System'`) are now BLOCKED. Email, category/object_type pairing, `high_N` ordering and non-ASCII case are accepted as app-level (03 §4). QA accepts these with QA 3.2 backend tests. The reasons are sound: no JSON1, provider data is stored as received, and NOCASE is ASCII-only. |
| QA-1-10 index claims | Low | **FIXED** | Unused indexes were dropped and 03 §9.2 was rewritten. `recent_changes.sql` uses `INDEXED BY ix_audit_ts`, with per-branch LIMIT. I verified it returns 20 rows newest-first. |
| QA-1-11 Today details | Low | **FIXED** | Edge DB under `TZ=America/New_York`, `UTC` and `Asia/Tokyo`: NULL dates sort last in tiers 4 and 5. An alert opened `2026-10-13T01:00Z` gives `days_delta` 0 in New York and 1 in UTC/Tokyo, which is correct local-day arithmetic. Alerts on a disabled object or disabled metric are absent. SQLite `localtime` on Windows is still untested (§56). |
| QA-1-12 D-07 duplicate / Exception horizon | Low | **OPEN, routed to pm-agent** | No schema change was needed. The PM decision is still pending. It does not block this gate. |
| QA-1-13 mock windows | Low | **FIXED / ACCEPTED** | Fictional versions (`7.x`, `mock-*`). QA accepts the quarter/day drift for mock data for the reasons in 03 §8. |
| QA-1-14 seed and channel guards | Low | **FIXED** | R22: `load()` refuses a prod-stamped DB and a file named `tam_command_center.db` (`SeedRefused`). P9c: a foreign `application_id` is refused (`0x3039`). Settings survive reseed. Residual Low: QA-2-4. |
| QA-1-15 extra columns | Low | **FIXED (documented)** | 03 §4 has the precedence rule; 03 §7 has the privacy note. |

## 3. New findings (regressions and gaps from the review-1 fixes)

### QA-2-1 · Medium · Owner: data-architect-agent · SPEC §25, §28/§33 (`bams_notification_log` UNIQUE), §37; 03 §2.1
**The secondary-key REPLACE guard triggers also abort legitimate natural-key upserts, `ON CONFLICT DO NOTHING` and `INSERT OR IGNORE`.**
03 §2.1 claims "A plain INSERT would fail on those keys anyway, so nothing legitimate is blocked". That is false: a BEFORE INSERT `RAISE(ABORT)` fires before conflict resolution, so it defeats every conflict clause, not only REPLACE. Reproduced on SQLite 3.38.2 and 3.53.4:
```
R4  §25 re-import: INSERT ... ON CONFLICT(client_id,server_name,schedule_year,schedule_quarter) DO UPDATE
    -> IntegrityError: server_upgrades: unique key already used by another row (REPLACE is banned)
R4b same with ON CONFLICT DO NOTHING                       -> same error
R3  notification "attempt at most once": ON CONFLICT(event_id,kind,channel) DO NOTHING
    -> IntegrityError: bams_notification_log: unique key already used by another row (REPLACE is banned)
R3b INSERT OR IGNORE into bams_notification_log          -> same error
R5  BAMS import ticker upsert ON CONFLICT(ticker) DO UPDATE -> bams_metrics: ... (REPLACE is banned)
R2  account import ON CONFLICT(name) DO UPDATE              -> clients: ... (REPLACE is banned)
R2b / R3c INSERT OR IGNORE on clients / bams_objects        -> aborted
```
These are the natural idioms for the §25 "re-import same identity = Update, not duplicate" rule, the §33 notification-log dedupe and §37 imports. The error text also wrongly blames REPLACE.

In scope this run: a plain duplicate account name now fails with a trigger message instead of `UNIQUE constraint failed`. Any backend mapping to 409 `conflict` that matches on "UNIQUE" will misfire.

Expected, either of:
- (a) Drop the secondary-key guards on natural-key tables (clients, server_upgrades identity, bams_objects, bams_metrics, bams_alert_configs, bams_notification_log) and rely on the extended scan in QA-2-2. Keep the guards only where no keyed upsert is ever legitimate (the contacts primary and the single active alert).
- (b) Keep the guards, correct 03 §2.1, and specify the mandatory SELECT-then-INSERT/UPDATE idiom for §25, §28 and §37, with tests.

Either way, document the error-text contract for duplicate names.

### QA-2-2 · Medium (reopens QA-1-2) · Owner: data-architect-agent · PM D-09, D-12, §13
**The REPLACE ban misses `UPDATE OR REPLACE`, and the scan regex misses several spellings.**
`UPDATE OR REPLACE` resolves a unique conflict by deleting the *other* row. It fires no INSERT trigger and does not match the scan pattern `\b(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b`.
```
R7  UPDATE OR REPLACE contacts SET is_primary=1 WHERE id='b'   -> [('b', 1)]   contact 'a' (old primary) DELETED, no audit
R7b UPDATE OR REPLACE clients SET name='Gamma' WHERE id='c2'   -> clients [('c1',),('c2',)]; client c3 'Gamma' DELETED, its task cascaded (count 0)
Scan regex vs: "UPDATE OR REPLACE ..." MISS · "UNIQUE ON CONFLICT REPLACE" (DDL) MISS ·
               'execute("INSERT OR "\n "REPLACE INTO t")' (split line) MISS · ".prefix_with('OR REPLACE')" MISS
```
03 §2.1 itself bans `ON CONFLICT REPLACE`, but the test does not enforce it.

Expected: widen the scan to `\bOR\s+REPLACE\b|\bREPLACE\s+INTO\b|\bON\s+CONFLICT\s+REPLACE\b`, run it over whole-file text (not per line) so split strings are caught, also scan `.mjs/.cjs`, and add `UPDATE OR REPLACE` and `ON CONFLICT REPLACE` to the 03 §2.1 ban and hazard test. Add `BEFORE UPDATE` guards for the contacts primary and `clients.name`, mirroring the INSERT guards; both are cheap.

### QA-1-5 (reopened) · Medium · Owner: data-architect-agent (contract), backend-dev-agent and frontend-dev-agent comply · PM US-9.1
The freshness fix holds only at the instant of loading (numbers in §2). In this run nothing updates BAMS metrics: the provider is Phase 4. The DEV DB, and the `MockDataSource` once a page has been open for 2 minutes, therefore show every enabled metric as Stale. The verifier passes only because it measures against the frozen `db.mock_seed.bams_now`. The in-scope "worst metric status" column still cannot be verified in Gate 3.2 screenshots.

Expected: a binding rule in 03 §8/§12. For example: "while `db.mock_seed` is present and no BAMS provider is running, freshness age = `bams_now − last_received` (frozen mock clock)". Alternatively, specify a DEV-only freshness refresher that re-stamps the mock times. Add a test that ages the clock past 120 s and still sees all four states.

### QA-2-3 · Low · Owner: data-architect-agent · D-11
`UPDATE ... RETURNING row_version` returns the **pre-bump** value when the statement relies on the auto-bump trigger. R1: `RETURNING` gave `[(1,)]` while the stored value was `(2,)`. A backend that echoes that token to the UI would get a spurious 409 on the next save. The explicit `row_version = row_version + 1` idiom in 03 §2.1 returns the correct value. 03 §2.2 must state "always bump explicitly; never trust RETURNING after an implicit bump". Separately, `cursor.rowcount` is 1 but `total_changes` advances by 2 (R13/R13b), so the backend should not count changes through `total_changes`.

### QA-2-4 · Low · Owner: data-architect-agent · SPEC §4
`assert_channel` stamps before it checks. Opening an unstamped mock DB as PROD writes `db.channel='prod'` and only then refuses (R9: `db.channel after refused prod open: ('prod',)`). After that, DEV refuses it too (R9b: `belongs to channel 'prod'`) and so does the seed loader, which strands the DEV DB. Move the mock-seed check ahead of the stamp. Also, `migrate(conn)` without `channel` skips every channel check (R9c ALLOWED on a prod-stamped mock DB). Make `channel` a required argument for non-test callers, or log loudly when it is omitted.

### QA-2-5 · Low · Owner: data-architect-agent · 03 §6.6
`assert_guards` checks trigger **names** only. A same-name trigger with a neutered body (`WHEN 0 BEGIN SELECT 1; END`) passed (R10 ALLOWED). Compare the normalized trigger SQL against `schema.sql` (the `schema_fingerprint` helper already exists). Also note that `declared_triggers()` reads `schema.sql` at runtime, so packaging must ship it; flag this for deployment-agent.

### QA-2-6 · Low · Owner: data-architect-agent · Phase 4 seam, D-11
`row_version` now also covers monitor-written tables (`bams_metrics`, `bams_alert_events`). A poller touching an open event every ~60 s will make a user's "close alert" with `expected_row_version` return 409 repeatedly. Before Phase 4, record whether monitor writes are exempt from the user token, or whether close uses a status-conditional UPDATE instead.

### QA-2-7 · Low · Owner: data-architect-agent · US-3.3
`recent_changes.sql`, `bams_part`: it orders by `x.ts DESC` with no tie-breaker before its inner LIMIT, so when timestamps tie at the boundary, which BAMS rows make the top 20 is nondeterministic. Add `x.id DESC, x.what` to the inner ORDER BY. The `INDEXED BY ix_audit_ts` hint turns any future rename of that index into a hard query error; add a note in 03 §9.2.

## 4. Open-item summary

| ID | Sev | Owner |
|---|---|---|
| QA-2-1 | Medium | data-architect-agent |
| QA-2-2 (reopens QA-1-2) | Medium | data-architect-agent |
| QA-1-5 (reopened) | Medium | data-architect-agent (+ BE/FE comply) |
| QA-1-7 residual, QA-2-3, QA-2-4, QA-2-5, QA-2-6, QA-2-7 | Low | data-architect-agent |
| QA-1-12 | Low | pm-agent |

Three Medium items are open. On re-review I will re-run `probes.py` and `regress.py` unchanged. The fix for QA-2-1 and the fix for QA-2-2 interact: whichever option is chosen for QA-2-1, the scan must catch every REPLACE spelling.

VERDICT: REJECTED
