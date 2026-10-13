# Schema Review 4 (Gate 1.3, third re-review)

| | |
|---|---|
| Reviewer | qa-guardrail-agent |
| Date | 2026-10-12 |
| Scope | QA-3-1 to QA-3-4 fixes (`docs/03_DATA_MODEL.md` §15), the rebuilt `db/sql_safety_scan.py`, PM D-23/D-24 in `db/queries/today_queue.sql`, `:channel` in `db/queries/metric_freshness.sql`, and a full regression pass |
| Gate rule | Approval requires zero open Blocker, High or Medium items. Lows are tracked. |
| Source edits by QA | None. Probes are in the session scratchpad: `qa/probes.py`, `qa/r2/regress.py` (run unchanged through `qa/r3/shim.py`), and `qa/r4/corpus.py` plus the `qa/r4/tree/` scratch tree. |

## 1. Independent reproduction

| Check | Result |
|---|---|
| Contract tests: Python 3.9.12/SQLite 3.38.2, 3.10.14/3.53.4, 3.12.4/3.45.3, 3.14.7/3.53.4 | `Ran 70 tests ... OK` on all four |
| `migrate.py --verify-schema`; raw `schema.sql` load | `IDENTICAL`. `integrity_check` ok. 17 tables, 19 indexes, 51 triggers. |
| `sql_safety_scan.py` on the real tree | `0 violation(s)`, exit 0 |
| Seed load + verify | `VERIFY: PASS`. Tiers 1-6 = 16/7/6/18/16/5, Upcoming 48. The D-23 and D-24 verifier checks pass. |
| Review-1 probes (35) and review-2 probes (31, on SQLite 3.38.2 and 3.53.4) | **No regression.** Every result is identical to review 3. Key results: P1, P1b, P2, P3 and P3b BLOCKED. R6 `(1, 0)`. R2-R5 upserts and IGNORE allowed. R7/R7b `UPDATE OR REPLACE` BLOCKED. R8: 8 of 8 cascades with open alerts work for metric, object and client deletes. R9: a refused PROD open writes nothing. R10/R10b refused. R11/R11b purge is transactional. R22/R22b refused. |

## 2. Re-verification of review-3 findings

| ID | Sev | Status | Evidence |
|---|---|---|---|
| QA-3-1 (a) path skips | Medium | **FIXED** | Scratch tree: `server/web/routes.py`, `server/api/tests/fixtures.py`, `server/repo.pyw`, `server/types.pyi`, `tests/e2e/test_x.py` and `frontend/src/x.ts` are all **reported**. Root-anchored `db/tests/`, `web/`, `frontend/dist/` and nested `node_modules` are skipped, as intended. |
| QA-3-1 (b)/(c) lexer and patterns | Medium | **FIXED for every review-3 case, but the rebuild introduced a new false negative.** See QA-4-1. | All 11 review-3 corpus cases now hit: `text('OR REPLACE')`, peewee `on_conflict_replace()` / `on_conflict('replace')`, `if_exists='replace'`, `#`/`--`/`//` inside strings, escaped `\n`, backslash continuation, plain and split literals. The new attempts E6/E7 (inline `/**/` comments), E13 (nested f-string quotes), E14 (JS regex literal), E15 and E16 also hit. |
| QA-3-2 false positives | Low | **FIXED (mostly)** | SQL `OR replace(`, `.replace("INTO"...)`, `label.replace(' into ')`, "Replace into template", docstring prose, SQL comments, TS block comments and `replace_count` are all clean. Residual Lows in QA-4-3. |
| QA-3-3 mock clock in PROD | Low | **FIXED** | `assert_channel(conn,"prod")` with only `bams.mock_clock` gives `refusing ... (found bams.mock_clock)`, and `db.channel` stays `None`. `metric_freshness.sql` at wall+130 s with provider 0: `channel=dev` → `{'Live': 75, 'Delayed': 4, 'No Data': 1, 'Disabled': 3, 'Stale': 12}`; `channel=prod` → `{'Stale': 91, 'No Data': 1, 'Disabled': 3}`. The mock clock is honoured only in DEV. |
| QA-3-4 undeclared triggers | Low | **FIXED** | `undeclared triggers present: ['trg_extra']`. A connection-local TEMP trigger is not seen (it lives in `sqlite_temp_master` and is not persisted). Informational only. |

## 3. PM D-23 / D-24 vs PM §3.1 and `today_queue.sql`

I built an edge DB and ran it at today = 2026-10-12:

| Case | Expected per PM §0 D-23/D-24 and §3.1 | Actual |
|---|---|---|
| Follow-up task due = `next_contact` = T | Touch suppressed. Task shows "Next Client Touch". | Task `ta` in tier 2 with context `Next Client Touch`. No touch for account A. ✓ |
| Dates differ (task T+1, touch T) | Both appear | Touch `b` in tier 4, task `tb` in tier 6. ✓ |
| Matching task is Complete / archived | Touch kept | Touches `c` and `e` in tier 4. ✓ |
| Matching category on another account | Touch kept | Touch `d` in tier 4. ✓ |
| Same date, category not Client Follow-Up | Touch kept | Touch `g` in tier 4; task `tg` has no D-23 context. ✓ |
| Match in the Upcoming window (T+8) | Suppressed in Upcoming too | Only task `tf` in Upcoming, with context `Next Client Touch`. ✓ |
| Exception at T+79 / with NULL date / in the past | Tier 5 / tier 5 / tier 1 | `x_future` t5, `x_null` t5, `x_past` t1. ✓ |
| Deferred + Failed at T+5; Deferred in the past | Never queued; outside the Upcoming window | Both absent. ✓ |
| Deferred at T+20 | Upcoming only | `d_up` in Upcoming. ✓ |
| Completed + Pending at T+21 | Tier 5 (validation work) | Tier 5. ✓ |

PM §3.1's tier-5 row still says "or validation Failed". D-24 ("Deferred upgrades stay out of the queue") takes precedence, and the SQL follows D-24. Informational for pm-agent: the §3.1 table could say "except Deferred". D-23 and D-24 are **conformant**.

## 4. New findings

### QA-4-1 · Medium · Owner: data-architect-agent · 03 §2.1, QA-1-2 / QA-2-2 / QA-3-1 lineage (silent cascade deletion)
**The rebuilt scanner no longer detects `REPLACE INTO` when the table name is a placeholder.** That is the typical shape of a generic repository upsert helper. The review-3 scanner (`\bREPLACE\s+INTO\b`) caught all of these; the new tightened pattern requires a literal identifier (`[\w.\[\]]+`) after `INTO`:
```
E1 c.execute(f"REPLACE INTO {table} ({cols}) VALUES ({qs})", vals)      -> hit=False
E2 c.execute("REPLACE INTO %s (id, name) VALUES (?, ?)" % table, row)    -> hit=False
E3 c.execute("REPLACE INTO {} (id) VALUES (?)".format(t), row)           -> hit=False
E4 db.run(`REPLACE INTO ${table} (id) VALUES (?)`, row)                  -> hit=False
scratch tree: server/repo_helper.py containing E1 -> NOT reported
```
The banned keyword phrase is fully static here; only the table name varies. So this is not the documented "assembled at runtime" limit. Review 3 established that INSERT-side REPLACE silently deletes the clashing row and cascades its children, and the scanner is the only control for it. This is a regression in that control, on the most plausible bad idiom.

Expected: accept placeholder table tokens in the `REPLACE INTO` pattern, for example `[\w.\[\]{}%$"]+` or `\S+` followed by the existing `(`/`VALUES`/`SELECT`/`DEFAULT`/`WITH` lookahead. Add E1-E4 (and E5) to the positive corpus and E1 to the scratch-tree test. The QA-3-2 negatives already in the corpus will confirm that no false positives return.

### QA-4-2 · Low · Owner: data-architect-agent · 03 §2.1
Further scanner false negatives. Each is unlikely or depends on the backend choosing a particular library, so none blocks the gate. Document each or add patterns.

| Case | Why it misses |
|---|---|
| E5 `REPLACE INTO clients AS c VALUES (...)` | Valid SQLite alias form |
| E8/E9 peewee `Model.replace_many(rows)` / `Model.replace(**kw)` | Both issue INSERT OR REPLACE |
| E10 `to_sql(..., **{"if_exists": "replace"})` | Option passed through a dict |
| A UTF-16LE `.sql` file containing `REPLACE INTO` | `errors="ignore"` decoding hides it; Windows editors produce these |
| `.bat`/`.ps1`/`.sh` launchers calling the `sqlite3` CLI | These suffixes are not scanned; deployment-agent will write `.bat` launchers |

Separately, E11: a `# sql-safety: allow` marker with no reason text exempts a real `INSERT OR REPLACE`. This is by design, but the marker should require a non-empty reason, and every allow marker must be listed in QA 3.2 for review.

### QA-4-3 · Low · Owner: data-architect-agent · 03 §2.1
Remaining false positives (fail closed; `sql-safety: allow` is available):
- `.tsx` UI copy "Insert or replace into the list" (F6).
- A data literal in a `.sql` seed file: `VALUES('Do not REPLACE INTO prod (seriously)')` (F10).

Both are acceptable with the marker. Note them in §2.1.

## 5. Open-item summary

| ID | Sev | Owner |
|---|---|---|
| QA-4-1 | Medium | data-architect-agent |
| QA-4-2, QA-4-3 | Low | data-architect-agent |
| QA-1-12 | resolved by PM D-23/D-24 (verified conformant in §3) | pm-agent |

Every schema, trigger, migration, seed, Today-queue and freshness item from reviews 1-3 is FIXED or accepted, and no regressions were found in the 66 regression probes. The single blocker is QA-4-1, which is a one-regex change in `sql_safety_scan.py` plus corpus entries. Review 5 will re-run `qa/r4/corpus.py` and the scratch tree only, unless other files change.

VERDICT: REJECTED
