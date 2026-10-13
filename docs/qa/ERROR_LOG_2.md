# QA Error Log 2: Gate 3.2 re-test (after Phase 4.1)

Reviewer: qa-guardrail-agent. Date: 2026-10-12. Tree: committed HEAD `bec9159` ("Phase 4.1: live API default, FE-AC-1..4, security headers, body cap, pinned deps"). Source was not edited. The working tree also holds uncommitted edits by other agents (`CHANGELOG.md`, `TAM_PROJECT_STATE.md`, `docs/05_TRACEABILITY.md`); the live server was started from a `git archive HEAD` copy (`server/ db/ web/`) under the scratchpad, with a scratch DEV database, so only committed code was driven. Severity policy per `docs/TEAM_LOOP.md`: only Blocker/High fail the gate.

## 1. What was run (real results)
| Check | Result |
|---|---|
| `pytest server` | 118 passed |
| `pytest db` | 77 passed (9 subtests) |
| `pytest tests/e2e` (old 44 + new 25 passed, 3 xfail = QA-E2-1/-2) | 69 passed, 3 xfailed |
| `tsc --noEmit` | exit 0 |
| `vitest run` | 10 files, 118 passed |
| `build:api` into a scratch dir (`VITE_DATA_SOURCE=api vite build --outDir ...`) | OK; `diff -r` against the committed `web/`: IDENTICAL (`index-CRNYxAvH.js`, `index-DRO3Y7zq.css`, `index.html`) |
| `sql_safety_scan.py .` / `--list-allow` | 0 violations / 0 allow markers |
| `pip-audit -r server/requirements.txt` | No known vulnerabilities found |
| `bandit -r server --exclude server/tests` | 0 High; 8 Medium B608 (same f-string SQL builders reviewed in log 1: internal identifiers only), 1 Low B101 |
| `npm audit` | 8 findings (5 moderate, 1 high, 2 critical), unchanged (see QA-E1-6) |
| Real DEV server from HEAD copy, port 8851, scratch DB `.../scratchpad/qa2/tree/dev_data/tam_dev.db` | Started; `lsof` shows `127.0.0.1:8851 (LISTEN)` only. Ports 8771/8793/8766 were already held by other processes, so they were not used |

New test file: `TAM_Command_Center/tests/e2e/test_gate32_retest_e2e.py` (starts its own DEV uvicorn from a temp copy; covers headers on 14 response classes, 405, 413, FE-AC-1..4, shipped-build checks).

## 2. Re-verification of ERROR_LOG_1 items
| ID | Result | Evidence |
|---|---|---|
| QA-E1-1 default data source | FIXED | `web/` equals a fresh `build:api` byte for byte; `web/` holds only `index.html` and two assets, no `mock_data.json`, no `.map`. `GET /mock_data.json` returns the SPA HTML, not JSON. Browser, no query string: network shows only `/api/state` and `/api/today`, no `mock_data.json`. Browser with `?data=mock&mockDelay=0`: `sessionStorage.tam.dataSource` is set to `mock` but resources fetched are `/api/state` and `/api/today`, there is no "Mock data" tag, and Settings shows "Data source: Live API". The selector forces `api` when `env===api && !DEV`. The mock adapter class is still tree-shaken into the bundle as dead code (not selectable; not a finding). Vitest `src/data/index.test.ts` passes |
| QA-E1-2 headers/CSP | FIXED for served responses; one gap, see QA-E2-1 | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and the contract CSP (`frame-ancestors 'none'`, `script-src 'self'`, no `unsafe-eval`) are present on: `/`, SPA fallback, `/assets/*.js`, `HEAD /`, `/api/health`, `/api/today`, `/api/nope` 404, `/api/client/<bad>` 404, 405, 422 (schema and bad JSON), 403 (bad Host, bad Origin), 413. Browser: the built app loaded on Today, Accounts, all five Account tabs, Tasks, Settings, task drawer, note drawer, Quick Capture at 1280, 768 and 375 widths with 0 console messages and 0 `securitypolicyviolation` events (listener installed during SPA navigation; full-page loads checked via console log). `index.html` has no inline script. `style-src` still allows `'unsafe-inline'` (React inline styles); accepted |
| QA-E1-3 405 | FIXED for all routes except the Allow header on two paths, see QA-E2-2 | `DELETE /api/health`, `PUT /api/today`, `POST /api/health`, `PATCH /api/state`, `GET /api/client/save`, `GET /api/task/save`, `GET /api/dev/reseed`: 405 `method_not_allowed` with `details.allowed` and `Allow` header. `/api/nope` still 404; `GET /api/health` 200; body carries no traceback or path |
| QA-E1-4 body cap | FIXED | 2 MiB cap: declared 2 MiB+10 gives 413 `payload_too_large` with `max_bytes: 2097152`; raw `Content-Length: 999999999` with no body sent is answered 413 from the header alone; httpx chunked 4 MB (no Content-Length) gives 413; raw `Transfer-Encoding: chunked`, 6 x 500 KB gives 413; body just under cap (cap minus 100) is parsed (422), cap plus 1 gives 413; a 50000-character note saves (200); server healthy afterwards; body text never appears in any log file |
| QA-E1-5 scanner residue | STILL OPEN (Low, accepted) | 12-case corpus run through `sql_safety_scan.py`: caught `{t}` f-string, bare `REPLACE INTO`, newline/tab-split `insert\n or\treplace`, comment-split, `.sql` file, `.bat` launcher (6 hits). Missed: `"INSERT OR REP"+"LACE"`, `\x52EPLACE`, REPLACE via a variable (3 contrived dynamic cases, as in log 1). UI prose (`"replace the contact; drop table rows"`) not flagged. The scanner targets REPLACE only (`DROP`/`DELETE` strings are not flagged by design) |
| QA-E1-6 npm audit | STILL OPEN (Low) | Same 8 findings. Shipped dependency: `react-router-dom@6.30.6`, moderate; fix needs 7.x (major). `vite` (high), `vitest`/`tinypool` (critical), `esbuild` are dev-only and not shipped |
| QA-E1-7 pins, audit tools | FIXED | `server/requirements.txt` pins match `pip freeze` exactly for every listed package (diff shows only the dev tools bandit/pip-audit and their dependencies installed in the venv); `pip-audit` 0 vulnerabilities; `bandit` ran (0 High). Deployment still owns the release lock file |
| QA-E1-8 FE-AC-1..4 | FIXED | FE-AC-1: `GET /api/note/{id}` returns `{ok, item}` equal to the saved note, unknown id gives 404 `not_found`, hostile ids give 404/422; browser deep link `/accounts/<id>/activity?note=<id>` opened the note drawer with exactly one `GET /api/note/<id>` and no activity paging. FE-AC-2: every note activity entry has `client_id` and `created_at`; the created note's `created_at` equals the note record. FE-AC-3: every `system` activity entry has `server_name` (set for `bams_alert.*` and `server_upgrade.*`, null otherwise); `recent_changes` rows carry the key. Browser: `?server=hfa-bpipe-ldn-01` highlighted the matching rows in both Infrastructure tables. FE-AC-4: every `infrastructure[cid]` in `/api/state` has `next_upgrade`, equal to the per-account infrastructure response and consistent with that account's upgrades; the rail shows "24 Oct hfa-bpipe-ldn-01". `API_CHANGE_REQUEST.md` marks all four done and `docs/04_API_CONTRACT.md` documents them |
| QA-4-1 / QA-4-2 | CLOSED | See QA-E1-5 |
| QA-4-3 | ACCEPTED | 0 violations, 0 allow markers on the real tree; prose with replace/drop is not flagged |

## 3. Browser walk-through (built `web/` served by the DEV backend, scratch DB)
Desktop (1280x800): Today (68-item queue, tiers in order, upcoming rail), Accounts (10 active), Account Overview (open tasks, recent activity, context rail with next upgrade and primary contact), Tasks, Activity, Infrastructure, Contacts tabs, Quick Capture (opened with `N`: account prefilled; Meeting Note saved, "Meeting Note saved" toast, "Last contact" updated to today, new note present in Activity), note deep link, Settings (Data source "Live API", Create backup now wrote a 1.1 MB file and listed it). Hostile note subject/body (`<img onerror>`, `<script>`) rendered as literal text; `window.__xss` stayed unset; 0 injected `img`/`script`.
768 wide: Today, Accounts, Overview, Tasks, Settings: `scrollWidth == innerWidth` on every page (no page-level horizontal scroll, meets PM US-2.4 AC2). The Overview shows the collapsible Account brief and its two-column content.
375 wide (below the 768 minimum, checked because 4.1 skipped narrow): Today queue stacks with ellipsis, no page overflow (`scrollWidth` 375); Accounts list shows name and BPID only; Account header, tab strip (scrolls), Brief, Tasks, Activity, Infrastructure (tables scroll inside their container), Contacts, Tasks page (table is 1419 px wide inside a 287 px scroll container), Settings (long paths wrap); Quick Capture dialog fits and saved a task (115 to 116 rows); task drawer opens with its buttons visible; 0 console messages. Observation, not filed: at 375 the Accounts list hides Open/Overdue/Alerts columns, which is below the supported minimum.
Regressions found: none in Today ordering, Account Workspace, Tasks, Settings or note CRUD. One Quick Capture gap, QA-E2-3.

## 4. Findings
No Blocker or High findings.

### QA-E2-1 | Low | owner: backend-dev-agent | spec: contract §0 (security headers on every response)
**A CORS-rejected preflight carries none of the security headers.** Reproduce: `curl -i -X OPTIONS http://127.0.0.1:8851/api/health -H 'Origin: http://evil.com' -H 'Access-Control-Request-Method: GET'`. Actual: `400 Bad Request`, `text/plain`, "Disallowed CORS origin", with no `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` or CSP (Starlette `CORSMiddleware` answers before the header middleware). Expected: the contract says every response, including errors, carries them. Impact: none exploitable (a plain-text 400 is not renderable as an app page). Test: `test_gate32_retest_e2e.py::test_headers_everywhere[OPTIONS-...]` (strict xfail).

### QA-E2-2 | Low | owner: backend-dev-agent | spec: contract §0.1 (405 with `Allow` header)
**`GET /api/note/save` and `GET /api/note/delete` return 405 without an `Allow` header.** Reproduce: `curl -i http://127.0.0.1:8851/api/note/save`. Actual: 405 `method_not_allowed`, `details.allowed: ["POST"]`, no `Allow` header. Every other POST-only route (`client/save`, `task/save`, `contact/save`, `*/delete`, `dev/reseed`, `settings/save`) sends `Allow: POST`. Cause: the `note_get` handler special-cases `save`/`delete` in `server/app.py` and raises `MethodNotAllowed` without going through the path that sets the header. Test: `test_405_allow_header_note_write_routes` (strict xfail).

### QA-E2-3 | Medium | owner: frontend-dev-agent | spec: PM spec US-10.1 AC2 (SPEC §31 "prefer selecting account early")
**The top-bar "+ Capture" button does not prefill the current account; only the `N` key does.** Reproduce: open an account (`/accounts/<id>/infrastructure`), click "+ Capture". Account field shows the placeholder "No account" (value empty). Press `Escape`, then `N`: the field is prefilled with the account name. Cause: `components/shell/TopBar.tsx` line 37 calls `openCapture()` with no argument; only the key handler in `components/shell/AppShell.tsx` passes `{ clientId: accountMatch?.params.clientId }`. Expected: AC2 says "pre-filled with the current account when opened inside a workspace", for any entry point. Severity reasoning: SPEC §31 itself is met (account chosen first, required for notes and follow-ups, so no wrong-account write); the derived PM acceptance criterion fails on the primary entry point, a usability gap with no data-loss or security path. Rated Medium, not High, on that basis; the orchestrator can promote it if it treats PM ACs as hard requirements. Same behavior at 375 wide.

## 5. Open Medium/Low after this gate
QA-E2-3 (Medium); QA-E2-1, QA-E2-2, QA-E1-5, QA-E1-6 (Low). All tracked in `docs/qa/OPEN_ITEMS.md`.

Windows (`msvcrt.locking`, `%LOCALAPPDATA%`) remains untested, as flagged in spec section 56.

VERDICT: PASS (0 open Blocker/High)
