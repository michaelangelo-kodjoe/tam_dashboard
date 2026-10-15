# BAMS test plan (T-112, appended T-129)

Sources: PM spec 12 (D-49..D-62, US-14.1..10), 12.8 (D-63..D-72, US-14.11..16), API contract 11 and 12. Written 2026-10-14, QA agent. Executable form: `TAM_Command_Center/tests/e2e/test_gate_run4_bams_e2e.py` (real DEV and PROD uvicorn processes on scratch trees, free ports, never 8766) and `test_gate_run4_import_e2e.py`.

## A. Lifecycle matrix (DEV routes force-value / clock / poll / simulate-*)
Rule: fixed_threshold `> 85`, consecutive 2, cooldown 0 unless stated.
| # | Start | Action | Expected |
|---|---|---|---|
| L1 | no event | 1 breaching fresh poll | no event, breach_count 1 |
| L2 | L1 | 2nd breaching poll | exactly one `open` event, one in-app notification |
| L3 | open | more breaches | same event id, current/peak/last_triggered updated, no new event, no new notification |
| L4 | open | clear poll | `recovered`, still listed active, `recovered_at` set |
| L5 | recovered | breach again | back to `open`, `recovered_at` null, same id |
| L6 | recovered | Close with note | `closed`, note stored, `closed_at` |
| L7 | open and breaching | Close | closed; further breaches do NOT reopen (suppress_until_clear); after a clear poll then breaches, reopens a new event |
| L8 | open | simulate-stale / outage + clock | no recover, no open, counters unchanged (frozen) |
| L9 | closed, cooldown 10 min | breach within cooldown | no event; after clock +10 min and fresh breach, opens |
| L10 | disabled rule / disabled metric / disabled appliance | breach | no event; active lists hide |
| L11 | open | delete rule / object / metric | blocked 409 `active_alert`, nothing written |
| L12 | pct_of_high, exceeds_high | breach vs stored high | opens per type; operators `>`,`>=`,`<`,`<=` each |
| L13 | any | repeat Close, close closed, close unknown | 409/404, no second audit row |
| L14 | notification | restart server | no re-notify (unique event/kind/channel) |

## B. Freshness boundaries (age = clock - last_source_update; poll 60 s, live_seconds 75, stale 120)
Ages 74, 75 -> Live; 76, 120 -> Delayed; 121 -> Stale; no value -> No Data. Per-metric `stale_after_seconds` 200 moves only the Stale boundary (121 -> Delayed, 201 -> Stale). Poll interval 300 -> Live <= 315 (D-52). Display status precedence open > recovered > stale > no_data > delayed > live.

## C. Fail closed (PROD runtime, channel prod, no TAM_DEV_MODE)
Provider kind blpapi, available false, simulated false; every row `current_value` null and freshness No Data; zero events and zero samples after start and after `monitor/start`; `/api/dev/*` all 404 (including bams); `TAM_BAMS_TEST_MODE=1` ignored; no route changes provider; banner flag in state; PROD with DEV flags refuses to start.

## D. Monitor
Provider calls independent of UI reads (200 reads, 0 provider calls); two concurrent `monitor/start`; start/stop persisted across restart; poll interval validation 29/30/86400/86401; import Apply while polling.

## E. Contract and security checks
Strict bodies (extra field 422), row_version stale 409, foreign Origin refused, 2 MiB body cap, no XSS (script in names stored and returned as data, UI renders as text), CSV formula in names, SQL metacharacters in filters/search/sort/range params, path traversal in import ids, ids unknown 404, no secrets or tickers in logs.

## F. Import (D-63..D-72), all via the real API
| # | Case | Expected |
|---|---|---|
| I1 | template xlsx and csv | headers per D-64/12.2, no formulas, Example re-imports clean |
| I2 | valid file | counts add up; inspect writes nothing (objects, metrics, audit, backups unchanged) |
| I3 | ticker conflict with other account / same appliance / differing ticker for existing metric / repeated in file | Invalid with sentence naming owner; nothing overwritten |
| I4 | same appliance name in two accounts | not flagged, both created |
| I5 | near duplicate (BAMS-NY-01 vs BAMS NY 01; ldn-01 vs ldn-03; shared-words case) | flagged High/Medium; none preselected; apply 409 until decided; same/different/skip each behave; no numbers or percent in payload |
| I6 | hostile: formula cells, `=cmd`, long values, control chars, bad Environment, Enabled junk, Stale after 0 / -1 / 1.5 / text, unknown account, ambiguous account, BPID/name mismatch, zip bomb, macro, wrong extension, binary csv | row-level Invalid or refused at inspect, never executed or stored raw |
| I7 | 500 rows ok, 501 `too_many_rows`; 5 MiB+ 413 | as Run 3 |
| I8 | apply: one `pre-import` backup valid under integrity_check and holding pre-state; one audit per appliance and metric, source Bulk Import; result counts equal DB delta | |
| I9 | injected failure (trigger raising on bams_metrics insert, or read-only fault) | 500 `import_failed`, rolled_back true, zero partial rows, backup exists |
| I10 | backup restore | restoring the pre-import copy yields the pre-state (counts equal) |
| I11 | re-import same file | all unchanged, no backup, no audit, `backup` null |
| I12 | fill-blanks-only with an all-different file | region/location/environment only filled when blank; enabled, stale_after, ticker never changed; disabled appliance stays disabled |
| I13 | concurrent monitor | polls running (clock advance + poll in a loop) while Apply runs: no error, new metrics picked up on next poll, No Data then value |
| I14 | skipped download xlsx/csv | formula-safe cells, re-uploadable |
| I15 | cross-import: accounts import session id on BAMS routes -> 410; Run 3 account import suite unchanged |
| I16 | account consistency | workspace Infrastructure counts and `/api/bams/state` for the account include imported items |

## G. UI (browser, DEV)
Desktop 1280 and narrow 375/768: `/bams`, drawer, alerts, rules, add appliance, settings, `/bams/import` four steps, entry points; console and network free of errors; keyboard reach of table rows, drawer focus trap and Esc, labels on inputs, status never by colour alone; browser title never changes on alert.

## H. Performance
200 metrics (via import of 40 appliances x 5 metrics): `/api/bams/state` p95 under 300 ms, UI table render and filter interactive under 1 s, one poll cycle under 2 s, trend max 500 points.
