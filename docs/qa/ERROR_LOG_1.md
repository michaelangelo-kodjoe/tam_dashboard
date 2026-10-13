# QA Error Log 1: Gate 3.2 (Phase 2 integration)

Reviewer: qa-guardrail-agent. Date: 2026-10-12. Tree: committed `master`, working tree clean. Source was not edited.
Severity policy per `docs/TEAM_LOOP.md`: only Blocker/High fail the gate; Medium/Low are listed here and appended to `docs/qa/OPEN_ITEMS.md`.

## 1. What was run (real results)
| Check | Result |
|---|---|
| `pytest server` (venv, from `TAM_Command_Center/`) | 107 passed |
| `pytest db` | 77 passed (9 subtests) |
| `tsc --noEmit` (frontend) | exit 0, no errors |
| `vitest run` | 9 files, 113 passed |
| `vite build` (to scratch dir, repo `web/` untouched) | OK; bundle names equal the committed `web/` (`index-BDVzithq.js`, `index-DRO3Y7zq.css`) |
| New e2e: `TAM_Command_Center/tests/e2e/test_gate32_e2e.py` (starts real uvicorn DEV and PROD-channel processes from a temp copy) | 44 passed |
| `sql_safety_scan.py .` over the whole tree | 0 violations; `--list-allow`: 0 allow markers |
| `npm audit` | 8 findings (see QA-E1-6). `pip-audit` and `bandit` are not installed and were not run (QA-E1-7) |
| Real server, DEV, port 8766, scratch copy + scratch DB under the scratchpad dir | Started; `lsof` shows `127.0.0.1:8766 (LISTEN)` only |

## 2. Spec section 52 scenarios in scope
| Scenario | Result | Evidence |
|---|---|---|
| Overdue before upcoming | PASS | e2e `test_today_ordering_and_shape`; queue tiers non-decreasing, no duplicates, no overlap with `upcoming` |
| Active BAMS alert actionable | PASS | tier 1/3 `bams_alert` items with `urgency` critical/alert |
| Near-term upgrade in queue | PASS | tier 5 `server_upgrade` items (2026-10-24 etc.) |
| Queue click-through | PASS | e2e: every item's `client_id` exists and `server_name` resolves in that account's infrastructure. Browser: link kinds `/accounts/:id/tasks?task=`, `/tasks?task=`, `/accounts/:id/overview`, `.../overview#next-touch`, `.../infrastructure?server=` match contract §2. Clicking a task opened the task drawer; the infrastructure deep link highlighted the server row in both tables |
| Account opens, Tasks tab filters to account, Overview counts | PASS | e2e `test_tasks_filter_to_account`, `test_account_counts_match_tasks`; browser |
| Meeting / Call / General note create, edit, delete | PASS | e2e (3 parametrised cases incl. stale write 409, confirm required, backup on delete, "X deleted: subject" system entry). Browser: created a Meeting Note through the drawer; `POST /api/note/save` 200 and the entry appeared |
| Activity filters | PASS | e2e: each filter returns only its type; pagination has no duplicates and is newest first |
| System events distinct, read-only | PASS | system entries have `kind: system`, no subject; no route edits them; UI Timeline has no edit/delete on them (vitest) |
| Contact Primary | PASS | e2e: second primary clears the first with `primary_cleared`; make-primary by id; zero primaries allowed; two concurrent set-primary calls leave exactly one |
| Infrastructure shows BAMS and upgrades | PASS | e2e + browser |
| Safety: loopback bind | PASS | `lsof` and e2e `test_loopback_bind` |
| Safety: second instance blocked | PASS | exit code 2, message names the holder PID |
| Safety: DEV cannot run PROD | PASS | dev-channel build without `TAM_DEV_MODE=1` exits 3 |
| Safety: DEV-only routes absent in PROD | PASS | PROD-channel copy: `/api/dev/reseed` 404, `/openapi.json` has no paths, DB created under `LOCALAPPDATA`, no `dev_data/`, no auto-seed, `TAM_DEV_MODE`/`TAM_BAMS_TEST_MODE` ignored |
| Safety: backup under WAL | PASS | 5 online backups taken while a thread wrote tasks continuously; each passes `integrity_check`; journal mode is `wal`; no writer errors |
| Safety: destructive action creates backup | PASS | task, contact, note, account delete and DEV reseed each return `backup_created`; the pre-delete backup file contains the deleted account; audit history survives; account delete needs the exact `confirm_name` |

Windows (`msvcrt.locking`, `%LOCALAPPDATA%`) is untested, as flagged in spec section 56.

## 3. Security review
- SQL injection: 8 payloads (quote, UNION, DROP, wildcard, backslash) against `q`, `client_id`, `category`, `before`, path ids: all handled, no leakage, tables intact; hostile strings stored as literal text. Manual review: the only f-string SQL (`services._apply_update`, `infra`, `reads`) interpolates internal column/table names behind an allow-list assert or placeholder lists, never request values. LIKE uses an escaped pattern.
- XSS: note subject/body/action items, task title/notes/waiting, and account name/notes set to `<img onerror>`, `<script>`, `javascript:` links. Verified in the browser on Today, Accounts, Tasks, Overview, Activity, Contacts, Settings: `window.__xss` never set, 0 injected `img`/`script`/`[onerror]`/`javascript:` links, the text renders literally. Source grep: no `dangerouslySetInnerHTML`, `innerHTML` or `eval`. The `RichText` component only produces React text nodes.
- Host/Origin/CORS: `Host: evil.com` and `127.0.0.1.evil.com` give 403; cross-origin POST (including `Origin: null` and text/plain) gives 403; text/plain POST without Origin gives 422; CORS preflight from `evil.com` gets no ACAO; allowed Vite origin gets ACAO without credentials.
- Path traversal: 8 encoded/raw variants through the SPA fallback leak no file contents.
- Secrets/logging: no secrets in the tree; error bodies carry no traceback or paths; with `log_level=DEBUG`, note bodies do not appear in the log.
- Input limits: oversize, unknown fields, control characters and client-chosen ids are rejected (422).

## 4. Findings
No Blocker or High findings.

### QA-E1-1 | Medium | owner: frontend-dev-agent / backend-dev-agent | spec: PM §Phase 4.1, SPEC §46
**Default build talks to the mock adapter, not the API.** Reproduce: `python -m server`, open `http://127.0.0.1:8766/` (no query). Network shows `mock_data.json` and no `/api/*` calls; only `?data=api` switches (the choice is not remembered across a full reload). Expected: the served UI uses the live API by default in the assembled product. Actual: the committed `web/` is the dev (mock) build; `npm run build:api` is the release path. Known and planned for Phase 4.1, so Medium. Verified separately that `?data=api` works end to end. Evidence: browser network log, `frontend/vite.config.ts`, `TAM_PROJECT_STATE.md`.

### QA-E1-2 | Low | owner: backend-dev-agent | spec: SPEC §46 (hardening)
**No clickjacking or CSP headers.** `curl -I /` returns only `x-content-type-options`, `cache-control`, `vary`. No `X-Frame-Options` / `frame-ancestors`, no `Content-Security-Policy`. A hostile page can frame `http://127.0.0.1:8765/` (the Host guard passes because the framed request is to 127.0.0.1) and try to induce a click. Mitigated by confirm dialogs and typed account name for account delete. Expected: `frame-ancestors 'none'` and a restrictive CSP.

### QA-E1-3 | Low | owner: backend-dev-agent | spec: contract §0.1
**Wrong method on a known path.** `DELETE /api/health` returns 404 `not_found` (contract: 405 `method_not_allowed`, because the catch-all `/api/{rest:path}` route captures it). `HEAD /` returns 405. Cosmetic.

### QA-E1-4 | Low | owner: backend-dev-agent | spec: SPEC §46
**No request body size limit.** A 20 MB JSON body to `/api/note/save` is fully read and answered with 422 (no 413). Loopback-only, so impact is local memory use only.

### QA-E1-5 | Low | owner: data-architect-agent | spec: OPEN_ITEMS QA-4-1/2/3 re-check
**Scanner status against real code.** `sql_safety_scan.py` finds 0 violations over the real tree and 0 allow markers. QA-4-1 (placeholder table names) is verified fixed: `{t}`, f-strings, whitespace, newline, comments in SQL strings, ` `, NBSP and zero-width characters were all caught (16 hits in a 25-case evasion corpus). Still missed, all contrived: mid-keyword concatenation (`"INSERT OR REP"+"LACE"`, `"REPLA" "CE"`), `\x4c` hex escapes in a literal, REPLACE passed through a variable, `%`/`.format` and `chr()`/`bytes.fromhex`. Static scanning cannot close dynamic cases; the schema's UPDATE-side triggers remain the second control. QA-4-1 and QA-4-2 can be closed; QA-4-3 stays as accepted. Residual keyword-split evasion is the Low.

### QA-E1-6 | Low | owner: frontend-dev-agent | spec: SPEC §46 (supply chain)
**`npm audit`: 8 findings.** Runtime (shipped bundle): `react-router`/`react-router-dom` 6.x, moderate (open redirect via backslash in `<Link>`/`useNavigate`; SSR hydration issue not applicable). The app only builds internal links from ids, never from external input. Dev-only: `vite` 5.x (high, dev-server path traversal in optimized deps `.map`), `esbuild` (moderate, dev server), `vitest`/`tinypool` (critical, prototype pollution in the test runner worker options), none shipped or run at runtime. Fix: bump `react-router-dom` to the patched 6.x; plan a vite/vitest major upgrade. Not exposed in production.

### QA-E1-7 | Low | owner: backend-dev-agent / deployment-agent | spec: SPEC §46
**No Python dependency audit possible.** `pip-audit` and `bandit` are not installed in the venv, and `server/requirements.txt` uses unpinned lower bounds (`fastapi>=0.110`). Manual review done instead (section 3). Add both to a dev requirements file and pin versions for the release.

### QA-E1-8 | Low | owner: backend-dev-agent | spec: API change requests FE-AC-1..4
FE-AC-1..4 remain open (additive). The frontend works around each; verified the live API still lacks `GET /api/note/{id}`, `client_id`/`created_at` on note activity entries, `server_name` on system activity entries and `next_upgrade` on infrastructure. Unchanged from the request file.

## 5. Re-check of prior open items
QA-4-1 FIXED (verified against real code, see QA-E1-5). QA-4-2 FIXED apart from the contrived residue in QA-E1-5. QA-4-3: 0 false positives in real `server/` and `frontend/`; accepted.

VERDICT: PASS (0 open Blocker/High)
