# ERROR LOG 5: Run 4 gate, BAMS dashboard and appliance/metrics import (T-112, T-113, T-116, T-129, T-130, T-131)

Date 2026-10-14. QA & Guardrail Agent. Uncommitted working tree, no source edited. Scope: D-49..D-72, PM 12 and 12.8, API contract 11 and 12. Plan: `docs/qa/BAMS_TEST_PLAN.md`.

## Evidence (run by QA)
| Check | Result |
|---|---|
| `pytest server db tests/e2e` (full, once at end) | 606 passed (544 before the new tests, +42 BAMS, +20 import e2e; Run 3 `test_gate_run3_import_e2e.py` unchanged and passing) |
| `tsc --noEmit` | exit 0 |
| `vitest run` | 26 files, 401 passed |
| `sql_safety_scan.py server` and `frontend/src` | 0 violations each |
| bandit (server, excl. tests) | 4 High (2x B324 sha1, 2x B613 literal zero-width chars in the control-char regex), 12 Medium B608 (f-string SQL built only from code constants, all columns/ids bound as parameters; checked bams/repo.py:94, bams/service.py:469) |
| pip-audit | no known vulnerabilities |
| npm audit --omit=dev | 2 moderate (react-router 6.x, pre-existing dependency; recharts adds none) |

## Verified live (scratch DEV trees, free ports, never 8766; scratch PROD tree with isolated LOCALAPPDATA)
Lifecycle via dev routes: open only after N consecutive fresh breaches, repeat breach updates the same event, recover keeps it active, reopen from recovered, Close with note, close-while-breaching suppresses until a clear sample, stale and outage freeze (counter unchanged, resumes), cooldown honoured, disabled rule/metric/appliance never alerts, all four operators at the boundary value, pct_of_high and exceeds_high, delete blocked 409 `active_alert`, no re-notify after restart, desktop log row carries no names or values. Freshness at ages 0/74/75 Live, 76/120 Delayed, 121 Stale; per-metric stale_after 200 moves only the Stale edge; poll 300 s gives live_seconds 315. 200 state reads and alert reads made zero polls; 4 concurrent monitor/start all 200; poll interval 29/86401/"60"/1.5/0/-5 refused, 30 and 86400 accepted. PROD: provider blpapi unavailable, every row null/No Data, no samples/events, monitor/start stays `provider_unavailable`, all `/api/dev/bams/*` 404, `TAM_DEV_MODE` and `TAM_BAMS_TEST_MODE` ignored with a warning, settings cannot enable simulation, imported appliances show No Data and never a value. Delete: confirmation_required, `pre-delete` backup, cascade clean, `foreign_key_check` empty. Reset: confirm required, backup, events cleared, rules kept.
Import: templates (xlsx sheets, csv BOM, no formulas, bad format 422); inspect writes nothing; counts add up and equal the DB delta; ticker conflicts (other account, differing ticker, repeats both-invalid per D-66); same name in another account not flagged; near duplicates (BAMS NY 01 vs BAMS-NY-01 High/Medium, ldn-03 not flagged, in-file near duplicate), no numbers/percent in payload, apply 409 until decided, bad decisions 422, same/different/skip behave; 21 hostile rows (bad environment, enabled, stale 0/-1/1.5/text/huge, 201-char values, unknown/no account, formula text, SQL text, HTML text) Invalid or stored as inert data; hostile files (binary csv, extension mismatches, vba, embedding, entity bomb, empty, wrong headers) refused; 500 rows OK, 501 xlsx/csv 422, 5 MiB+ 413; skipped file only in upload format, strings only, re-uploadable; accounts-import id on BAMS routes 410; foreign Origin refused; 500-row apply 100 appliances + 500 metrics + 600 audit rows, one `pre-import` backup passing integrity_check and holding the pre-state, restore to that backup then re-import works; injected failure (trigger raising on metrics insert) gives 500 `import_failed`, rolled_back true, zero partial rows, audit unchanged; fill-blanks-only with an all-different file (enabled, stale_after, ticker, row_version unchanged, disabled appliance stays disabled, overwritten 0); re-import writes nothing (no backup, no audit); concurrent Apply gives one 200 and one 409; ticker taken after preview gives 409 `preview_stale`; session cap 3; monitor polling concurrently with Apply raised no errors and all 60 new metrics had values after the next poll; infrastructure tab includes imported appliance.
Browser (DEV, 1024 and 375 wide): `/bams` table, summary, drawer (trend with 30/60/90 lines, text equivalent, rules), Esc closes, `/bams/import` step 1; no console errors; every `/api/` call from this server returned 200 (failed calls to port 8793 in the tab buffer are from a previous session).
Performance (668 metrics, more than the 200 required): `/api/bams/state` p50 148 ms, p95 149 ms, 552 KB; one poll 925 ms; trend at most 500 points for 24h/7d/30d/90d.
Not verified: Windows toast (no Windows), browser file-chooser upload through the real UI (vitest covers; API verified), kill-and-restart `import_expired`, full keyboard-only and screen-reader pass.

## Items (no Blocker, no High)
| ID | Sev | Owner | Spec | Finding and evidence |
|---|---|---|---|---|
| QA-E5-1 | Low | backend-dev / pm | D-65 | Row with a valid Account name and a BPID that matches no account is accepted as New under the named account with no warning (hostile row 13 in `test_I6_hostile_rows`). Spec text "BPID first, else name" is ambiguous; consider a warning or Invalid |
| QA-E5-2 | Low | data-architect | 26, D-54 | Seed/simulated history exceeds 100 for percent metrics (90D high 102.1%, 100.8%) and "Network Throughput (Mbps)" shows 400.7% high and a "%" current value, contradicting "all values are percentages" |
| QA-E5-3 | Low | data-architect / backend-dev | 12.1 | First DEV poll turns 7 seeded open alerts into recovered (UI: "1 open, 8 recovered"), so the seeded open/recovered mix is lost on first load |
| QA-E5-4 | Low | frontend-dev | 29 | Trend x-axis repeats date ticks ("8/10 8/10 9/10 ... 14/10 14/10") |
| QA-E5-5 | Low | frontend-dev | 54 | At 375 px the import step tabs and the columns legend table are clipped ("Revie", "RUL") |
| QA-E5-6 | Low | backend-dev | contract 12.4 | Appliance audit reason reads "Bulk import: a.csv, rows 2, 3"; contract says "row N". Align text or contract |
| QA-E5-7 | Low | backend-dev | 46 | bandit B324 sha1 in `importer/bams_plan.py:188` and `importer/plan.py:98` (not security use; add `usedforsecurity=False`); B613 literal zero-width characters in `_CTRL` regex of `dupes.py:47` and `importer/reader.py:40` (use `​` escapes) |
| QA-E5-8 | Low | frontend-dev | 46 | npm audit: react-router 6.x moderate advisories (open redirect, SSR deserializeErrors); local app, no SSR, but upgrade at next dependency pass |

Environment note for the orchestrator: earlier QA runs of a prod-channel tree without `LOCALAPPDATA` created `/Users/Michaelangelo/.local/share/TAM_Command_Center/` (empty PROD DB, backups, logs, created 20:08 today). QA tests now isolate it; QA was not permitted to delete the folder, so remove it by hand.

New QA tests: `TAM_Command_Center/tests/e2e/test_gate_run4_bams_e2e.py` (43 cases), `TAM_Command_Center/tests/e2e/test_gate_run4_import_e2e.py` (19 cases).

VERDICT: PASS (0 open Blocker/High)
