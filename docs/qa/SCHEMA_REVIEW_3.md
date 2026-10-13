# Schema Review 3 (Gate 1.3, second re-review)

| | |
|---|---|
| Reviewer | qa-guardrail-agent |
| Date | 2026-10-12 |
| Scope | `TAM_Command_Center/db/` as revised after `SCHEMA_REVIEW_2.md` (dispositions in `docs/03_DATA_MODEL.md` §14), including the new `sql_safety_scan.py` and `queries/metric_freshness.sql` |
| Gate rule | Approval requires zero open Blocker, High or Medium items. Lows are tracked. Per the coordinator, QA-1-12 (PM-owned, not a data-integrity issue) does not hold the verdict. |
| Source edits by QA | None. Probes are in the session scratchpad (`qa/probes.py`, `qa/r2/regress.py`, `qa/r3/`). |
| Probe compatibility | `migrate()` now requires the keyword `channel`, so the review-1 and review-2 probe scripts were run **unchanged** through a shim (`qa/r3/shim.py`) that supplies `channel=None`, the tooling-only path. |

## 1. Independent reproduction

| Check | Result |
|---|---|
| Contract tests on Python 3.9.12/SQLite 3.38.2, 3.10.14/3.53.4, 3.12.4/3.45.3 and 3.14.7/3.53.4 | `Ran 63 tests ... OK` on all four |
| `migrate.py --verify-schema` | `verify-schema: IDENTICAL` |
| Raw `schema.sql` load (sqlite3 CLI 3.38.2) | `integrity_check` ok, `foreign_key_check` empty. 17 tables, 19 indexes, 51 triggers. |
| CLI without `--channel`, then with `--channel dev` | `error: --channel dev|prod is required (QA-2-4)` (exit 2), then `{'from': 0, 'to': 1, ...}` |
| Seed load + verify at real wall time | `VERIFY: PASS`. Tiers 1-6 = 15/5/6/17/15/7, Upcoming 45. Freshness `{'Live': 75, 'Delayed': 4, 'No Data': 1, 'Disabled': 3, 'Stale': 12}` |
| `sql_safety_scan.py` on the real tree | `0 violation(s)`, exit 0 |
| Review-1 probes (`probes.py`, 35 probes) and review-2 probes (`regress.py`, 31 probes, on SQLite 3.38.2 and 3.53.4) | Results in §2 |
| New review-3 probes: scanner corpus (18 cases), scratch source tree, freshness clock, guard regressions | Results in §3 |

## 2. Re-verification of open items from reviews 1 and 2

| ID | Sev | Status | Evidence (re-run by QA) |
|---|---|---|---|
| QA-2-1 guards blocked keyed upserts | Medium | **FIXED** | On SQLite 3.38.2 and 3.53.4:<br>• R4 §25 `ON CONFLICT(identity) DO UPDATE` → rowcount 1; R4b `DO NOTHING` → 0.<br>• R3 notification-log `DO NOTHING` → 0; R3b `INSERT OR IGNORE` → 0.<br>• R5 ticker upsert → 1. R2 name upsert → 1. R2b/R3c `INSERT OR IGNORE` → 0.<br>• Duplicate rename now fails with `UNIQUE constraint failed: clients.name` (R2d), so the error-text contract holds. |
| QA-2-2 `UPDATE OR REPLACE` and scan gaps | Medium | **UPDATE side FIXED. INSERT side accepted by design, but its sole control is defective: see QA-3-1.** | R7 is BLOCKED with `UNIQUE constraint failed: contacts.client_id (one primary ...)`, and both contacts are intact. R7b is BLOCKED with `UNIQUE constraint failed: clients.name`. P8k: `clients.id is immutable`. INSERT-side REPLACE is unguarded by design, and its cascade is real: N1 (FK on) `INSERT OR REPLACE INTO clients(id,name) VALUES('c3','Beta')` silently deleted client `c2` and cascaded its task (`c2 tasks= 0`). |
| QA-1-5 BAMS freshness decays | Medium | **FIXED** | `metric_freshness.sql` with `provider_running=0` gives an identical `{'Live': 75, 'Delayed': 4, 'No Data': 1, 'Disabled': 3, 'Stale': 12}` at wall +0 s, +130 s and +30 days. With `provider_running=1` at +130 s it gives `{'Stale': 91, ...}`, the correct wall-clock behaviour. The verifier now measures at real time. |
| QA-1-7 undated ad-hoc duplicates | Low | **FIXED** | `srv`/`SRV` undated duplicate → `UNIQUE constraint failed: index 'ux_server_upgrades_adhoc_identity'`. Changing a dated upgrade to undated so that it collides → blocked by `trg_server_upgrades_unique_on_update`. P6 BLOCKED. |
| QA-2-3 RETURNING after implicit bump | Low | **FIXED (contract)** | R1 still returns `[(1,)]` against stored `(2,)`, which is the expected behaviour. 03 §2.2 now mandates an explicit bump, and `test_2_3_explicit_bump_returns_fresh_token` passes. |
| QA-2-4 channel stamping order | Low | **FIXED** | R9: a refused PROD open leaves `db.channel` = `None` (nothing written). R9b: a DEV open then succeeds. `channel=None` emits `migrate(channel=None): channel check skipped (tooling/tests only)`. The CLI requires `--channel`. |
| QA-2-5 guard check by name only | Low | **FIXED** | R10: `guard triggers altered: ['trg_audit_events_no_delete']`. R10b: `missing`. Residual Low: QA-3-4. |
| QA-2-6 poller writes and row_version | Low | **FIXED** | A metric poll (`current_value`, `last_received`, `high_30`) left rv at `(1,)`. `breach_count` on a rule left rv at `(1,)`. A user edit (`enabled`) bumped it to `(2,)`. Alert events still bump on monitor touches (`(2,)`), but the documented status-conditional close returned rowcount 1, so there is no spurious 409. |
| QA-2-7 recent-changes tie-break | Low | **FIXED** | `ORDER BY x.ts DESC, x.id DESC, x.what DESC` in the BAMS branch. The `INDEXED BY` dependency is noted in the query and in 03 §9.2. The test passes. |
| QA-1-12 | Low | **OPEN, PM-owned** | Not a data-integrity issue, so it does not hold the verdict (per the coordinator). |
| Earlier fixed items (QA-1-1, 1-3, 1-4, 1-6, 1-8 to 1-11, 1-13 to 1-15) | | **No regression** | P1, P1b, P2, P3 and P3b are BLOCKED. R6 gives `(1, 0)`. R11 and R11b purge is transactional. R8: 8 of 8 cascades with open alerts succeed for metric, object and client deletes. P8d, P8g, P8n and P9c are BLOCKED. R22 and R22b refused. R12 bumps by exactly 1 with `recursive_triggers=ON`. R20: 20,000-row UPDATE in 0.03 s. |

## 3. New findings

### QA-3-1 · Medium · Owner: data-architect-agent · 03 §2.1, QA-1-2 / QA-2-2 (data loss through REPLACE cascade)
**`sql_safety_scan.py` is now the only control against INSERT-side REPLACE, and it has false negatives. The worst is a skip rule that silently disables it for any directory named `web`, `tests` or `dist` at any depth.**

The REPLACE guards were removed on purpose so that QA-2-1 upserts work. That is acceptable, but it makes the scanner load-bearing. N1 shows the hazard is live: an unrelated account and its tasks were deleted with no audit row.

**Defect 1, path skip.** `SKIP_DIRS` is matched against every path component. Scratch tree, real scanner:
```
server/web/routes.py        INSERT OR REPLACE INTO clients ...   -> NOT reported (any dir named 'web' skipped)
server/api/tests/fixtures.py INSERT OR REPLACE INTO clients ...  -> NOT reported (by design for tests, but at any depth)
server/repo.pyw              INSERT OR REPLACE INTO clients ...  -> NOT reported (suffix not scanned)
frontend/src/x.ts            INSERT OR REPLACE INTO clients ...  -> reported
sql_safety_scan: 1 violation(s)
```
`server/web/` is a common FastAPI package name. The compiled-asset skip should be anchored to the top-level `TAM_Command_Center/web/`, plus `node_modules`, `.venv` and `dist` build outputs, and not applied at arbitrary depth.

**Defect 2, corpus false negatives.** These are all INSERT-side, the unguarded side:

| Input | Hit |
|---|---|
| `insert(t).prefix_with(text('OR REPLACE'))` (SQLAlchemy) | no |
| `Model.insert(**row).on_conflict_replace()` / `.on_conflict('replace')` (peewee) | no |
| `x = "a #b"; c.execute("REPLACE INTO t VALUES(1)")` (`.py`; the comment stripper eats from ` #` inside a string) | no |
| `INSERT INTO t VALUES('--'); REPLACE INTO t VALUES(2);` (`.sql`; same with `--` inside a literal) | no |
| `const u = "a //b"; db.run("REPLACE INTO t ...")` (`.ts`) | no |
| `"INSERT OR %s INTO t" % "REPLACE"` | no (runtime assembly, the documented limit) |

Related, not REPLACE but the same silent-loss class for §37 imports: `df.to_sql('clients', conn, if_exists='replace')` is not flagged, and it drops and recreates the table.

UPDATE-side spellings the scanner also misses (`"UPDATE OR\nREPLACE ..."` with an escaped `\n`, and backslash line continuation) are now harmless because the UPDATE guards block them. Noted only.

**Expected:**
- (a) Anchor the skips to explicit root-relative paths, and scan `.pyw`.
- (b) Strip only whole-line comments (or do not strip `#`, `--`, `//` that appear after an unclosed quote on that line).
- (c) Add patterns: `text\s+OR\s+REPLACE`, `on_conflict_replace`, `on_conflict\s*replace`, and `if_exists\s*=?\s*replace` (or ban `to_sql` writes to entity tables in 03 §2.1).
- (d) Add each case above to the scanner corpus test, plus a scratch-tree test with `server/web/x.py`.

### QA-3-2 · Low · Owner: data-architect-agent · 03 §2.1
The scanner fails closed on some legitimate code. Each case below breaks the build with a misleading message:

| Input | Why it is legitimate |
|---|---|
| `.sql`: `WHERE bpid = ? OR replace(name,' ','') = ?` | The bare `OR REPLACE` rule hits the scalar `replace()` function, which is a plausible normalisation in reference queries. |
| `.py`: `q.replace("INTO", "INTO main.")` | String method, not SQL. |
| `.ts`: `label.replace(' into ', ' ')` | String method, not SQL. |
| `.tsx`: `<Button>Replace into template</Button>` | UI copy. |
| A docstring saying "Never use INSERT OR REPLACE here" | Docstrings are scanned by design, so this is intentional, but it needs documenting. |

Document these, add a per-line allow marker (for example `sql-safety: allow`), or require `\(` to be absent after `REPLACE` for the `.sql` bare rule.

### QA-3-3 · Low · Owner: data-architect-agent · SPEC §4 ("Production must never silently use simulated BAMS data"), §26 fail closed
The frozen mock clock is honoured whenever `app_meta['bams.mock_clock']` exists and `provider_running=0`. In PROD with BLPAPI down (fail closed, so provider not running), a stray `bams.mock_clock` would show Live and Delayed for stale data. The only barrier is that `db.mock_seed` makes PROD refuse the DB, and the two keys are independent. N3: with `bams.mock_clock` present and `db.mock_seed` absent, `assert_channel(conn, "prod")` was **ALLOWED**.

Refuse a PROD open when `bams.mock_clock` is present, and/or give `metric_freshness.sql` a `:mode` parameter so the clock applies only in DEV.

### QA-3-4 · Low · Owner: data-architect-agent · 03 §6.6
`assert_guards` compares declared triggers but ignores **extra** undeclared ones. N2: `CREATE TRIGGER trg_extra AFTER INSERT ON tasks BEGIN DELETE FROM notes; END` passed `assert_guards`. Low risk on a single-user local DB, but it is a one-line fix: also refuse any trigger in `sqlite_master` that is not in `declared_triggers()`.

## 4. Open-item summary

| ID | Sev | Owner |
|---|---|---|
| QA-3-1 | Medium | data-architect-agent |
| QA-3-2, QA-3-3, QA-3-4 | Low | data-architect-agent |
| QA-1-12 | Low | pm-agent (does not hold the verdict) |

Everything else from reviews 1 and 2 is FIXED or accepted with a reason, with no regression found. One Medium remains: QA-3-1. Its fix is confined to `sql_safety_scan.py` and its tests. No schema change is needed, so review 4 can be limited to re-running the scanner corpus, the scratch-tree test and the regression probes.

VERDICT: REJECTED
