# ERROR LOG 4: Run 3 gate, account bulk import (xlsx + csv) with duplicate detection (T-92..T-94)

Date 2026-10-13. QA & Guardrail Agent. HEAD, no source edited. Scope: D-37..D-48, PM section 11, API contract section 10.

## Evidence (re-run independently)
| Check | Result |
|---|---|
| `pytest server db tests/e2e` (once, before adding new tests) | 473 passed |
| New `tests/e2e/test_gate_run3_import_e2e.py` (real DEV uvicorn, scratch tree and DB) | 22 passed (incl. 7 live golden cases) |
| `tsc --noEmit` | exit 0 |
| `vitest run` | 21 files, 326 passed |
| `build:api` to scratch dir | built; same bundle hash as shipped `web/` |
| `sql_safety_scan.py server` / `frontend/src` | 0 violations |

## Verified live (DEV backend, free port, scratch DB)
Templates: xlsx sheets Instructions/Accounts/Lists (hidden), six headers, Status list validation values equal the `clients.status` CHECK parsed from schema.sql, no formulas/macros/links; csv UTF-8 BOM, six headers; both round-trip as `no_rows`; `format=pdf` 422.
Matching: 'web mgmt ltd' vs existing 'Web Ltd' is flagged Medium with reason `contained_name`; exact (case/space-insensitive) is an automatic Update that fills blanks; no `%`, score, similarity or confidence anywhere in payloads, and none in the review UI text.
Writes: Inspect changes nothing (clients, audit, backups counted); Apply with an unresolved flag is 409 `unresolved_duplicates`, nothing written; 422 for bad decisions (no target, target not a candidate, duplicate row, target on different/skip); `preview_stale` after a concurrent edit and after a delete, refresh via GET plan then Apply succeeds; `already_applied`; 4 parallel Applies: one 200, three 409 `conflict`; unknown import 410; max 3 sessions.
Merge: fill-blanks only (BPID/products/notes never overwritten); Inactive stays Inactive; in-file exact duplicate merged, in-file near duplicate flagged High against the earlier row; earlier row wins.
Safety: `pre-import` backup exists, `integrity_check` ok and holds the pre-import state; exactly one audit row per created/updated account, source `Bulk Import`, reason `Bulk import: <file>, row N`; trigger-forced failure on the 3rd insert rolled back every create and audit row (500, counts identical), session reusable; idempotent re-import (all unchanged, no backup, no audit); no-op plan writes nothing.
Caps: 500 rows OK, 501 `too_many_rows` (xlsx and csv), 10,500 padded rows `too_many_rows`; 3 MiB accepted on inspect, 5 MiB+ gets 413 with declared and streamed bodies; `check-similar`, `client/save`, `apply`, `note/save` still 413 at 3 MiB.
Hostile: zip bomb, 250-entry zip, traversal entry, XML entity bomb, vbaProject.bin, macro content type, external link, embedding, external relationship, binary named .csv, xlsx named .csv, csv named .xlsx, .xls/.xlsm/.txt, empty, truncated, OLE named .xlsx, wrong sheet, duplicate/missing header: all 422 with the contracted reason. Formula cell makes only that row Invalid. Huge random cells: row Invalid, response under 20 KB. CSV: UTF-8, BOM, semicolon, tab, pipe, UTF-16, Windows-1252 with detected encoding/delimiter reported; multiline cells; `=cmd|...`, `=1+1`, `+SUM`, `@HYPERLINK` stored as text; skipped.csv prefixes them with `'` and re-imports with an `unknown_column` warning. X-File-Name with path parts, HTML, NUL: stripped or kept as inert text; 300 chars refused.
Single add: `check-similar` returns same candidates/reasons/strength as import; `client/save` without the flag is 409 `possible_duplicate` (direct API), exact twin stays 409 `conflict` even with the flag, no-candidate name creates, update unaffected.
Browser walkthrough (DEV, csv upload): Choose, Preview tiles (3 valid, 1 new, 0 updates, 2 review, 1 invalid), Review (no preselected radio, multi-candidate needs a target, Apply disabled until 2 of 2), Result tiles and backup name; an account named `<img src=x onerror=window.__xss=1> ...` rendered as inert text in Preview, Review, Accounts list and result (`window.__xss` undefined, 0 img nodes). Add-account dialog shows the similar panel; Same account navigates to the existing workspace with no account created.
Security: CSP, X-Frame-Options, nosniff present on API, template and SPA responses; foreign Origin on inspect rejected; other `/api/import/*` still 501; GET on inspect 405. Smoke: Today, state, FK check and integrity_check ok; account names unique case-insensitively.
Not verified: kill-and-restart `import_expired` (in-memory sessions, 410 path covered via unknown id); screenshots at four widths and keyboard-only pass (not repeated; vitest covers keyboard/aria).

## Items
| ID | Sev | Owner | Spec | Finding |
|---|---|---|---|---|
| QA-E4-1 | Low | frontend-dev / pm | PM 11.1 | Import is a modal dialog opened on `/accounts`; section 11.1 says a four-step page at route `/accounts/import` (no such route). Behaviour is otherwise complete. Either amend 11.1 or add the route. |
| QA-E4-2 | Low | pm (D-41) | D-41 R2/R4 | Abbreviation rule is spec-literal but noisy on short real words: 'Lane' is flagged as short for 'Lantern' (Low for 'Qorvex Lantern Co', Medium for 'Lantern Co' vs 'Ostrava Lane Pension Trust'); 'cmd' vs 'Commodities'. Not a defect against D-41; consider a minimum length of 4 or a stronger-word requirement. The user always confirms, so no data risk. |

No Blocker, High or Medium found. Earlier open items (QA-E1-5, QA-E1-6, QA-E3-1..7) unchanged and not re-tested beyond smoke.

VERDICT: PASS (0 open Blocker/High)
