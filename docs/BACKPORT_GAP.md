# Backport gap: workstation zip vs source (TASK B-1, read-only investigation)

Baseline: `TAM_Command_Center.zip` (VERSION 0.1.0-rc6, channel=prod) vs source `TAM_Command_Center/` and original rc6 release.
Method: `diff -rq` zip vs rc6 (what the user changed) and source vs rc6 (what source changed since: dead-code cleanup only, tag rc6-working).
Key fact: for every file in the table below, source == rc6 except trivial unused-import/local removals (reads.py, routes.py, bams_plan.py: 2-3 lines each). So each zip change applies cleanly on source with a small manual merge on those three files. Files that differ between zip and source but not between zip and rc6 (auditlog, auditprune, lifecycle, dupes, importer/plan|service|template, portability/*) are source's cleanup only: do NOT overwrite source with zip copies.

## Backend (server/)

| File | Change in zip | Status |
|---|---|---|
| server/bams/provider.py | `FIELD = "PX_LAST"` -> `"LAST_PRICE"` (1 line) | BACKEND-PORT. Tests already expect LAST_PRICE (`test_blpapi_provider.py:35,39` passes `field="LAST_PRICE"` explicitly, so unaffected); `tools/bloomberg_probe.py` default `--fields PX_LAST` is a separate tool, decide whether to follow. Check `docs/BLPAPI_NOTES.md` for PX_LAST wording. |
| server/bams/notify.py | Windows notifier rewritten (+293 lines): `base64 -EncodedCommand` PowerShell NotifyIcon script, serialized delivery worker thread, `send_sync`, `send_async(title, body, callback)`, `info()`, `shutdown()`, clipping, duration | BACKEND-PORT (copy whole file; source identical to rc6) |
| server/bams/monitor.py | (a) `stop()` calls `notifier.shutdown()`; (b) `_poll` runs `sync_auto_policies(conn)` in a transaction each cycle; (c) desktop notification delivered via `send_async` with callback that logs the real result into `bams_notification_log` (own connection, dedupe via `repo.notification_logged`), falls back to `send()` for fake notifiers | BACKEND-PORT. Requires `repo.notification_logged` to exist: verify in source repo.py (grep) before porting |
| server/bams/service.py | +217: `_CONFIG_COLS`, `_policy_rule_values`, `_sync_policy`, `sync_auto_policies(conn, config_ids=None)` (row_factory-safe), `notification_test(rt)`; `ensure_starters` inserts `auto_apply`, calls sync at startup; config save/delete/apply handle persistent policy (apply with `metric_ids=None` sets `auto_apply=1`, returns `persistent`, `adopted_identical`, `updated_managed`, `disabled_managed`); delete config disables managed rules | BACKEND-PORT (source differs from rc6 by 3 lines of cleanup: merge) |
| server/bams/reads.py | `config_public` adds `auto_apply`; new `metric_catalog(conn)` | BACKEND-PORT (merge: source removed an unused import near top) |
| server/bams/routes.py | new `GET /bams/metrics/catalog`, `POST /bams/notifications/test` | BACKEND-PORT (merge: source removed unused imports). Route order: `/bams/metrics/catalog` does not collide with `/bams/metric/{id}` |
| server/bams/schemas.py | `ConfigSave.auto_apply: Optional[StrictBool]` | BACKEND-PORT |
| server/importer/bams_reader.py | New optional `polarity` column (LIMIT 10, East/West validated, overrides region). Header rule relaxed: only `Account` required (was Account-or-BPID + Appliance + Metric + Ticker). Per-row: Metric and Ticker must be given together; Account required per row; `ALIASES["polarity"]="region"` removed | BACKEND-PORT |
| server/importer/bams_plan.py | Metadata-only rows (no Metric/Ticker) update an existing appliance; explicit non-blank Region/Environment/Location now overwrite (was fill-blanks-only); conflicting values across rows of one appliance rejected (`appliance_metadata_conflict`); new codes `appliance_required_for_bams`, `nothing_to_import`, `appliance_not_found`; metric counts only count metric rows | BACKEND-PORT (merge: source removed 2 unused locals) |
| server/importer/bams_service.py | After apply, `sync_auto_policies(conn)` so imported metrics get policies; `policy_sync` in result | BACKEND-PORT |
| server/importer/bams_template.py | Template instructions rewritten; new Polarity column K with East/West list (errorStyle stop); example rows incl. metadata-only rows; only Account highlighted required | BACKEND-PORT |
| server/importer/bams_terminal_adapter.py (NEW, 301 lines) | Converts a Bloomberg Terminal BAMS export (Client, Ticker, Region, Metric, DC Location) in memory to template schema | BACKEND-PORT but note: grep found NO caller in zip server/ other than itself and `__main__.py` is not a caller. It is unwired dead code unless the caller exists elsewhere. Port only together with its wiring and tests, or defer. Confirm with user |
| server/portability/app.py (535 lines) and server/portability/services.py (694) | Stray copies of `server/app.py` and `server/services.py` (90-line diff vs app.py). Nothing imports them (`from .app`/`from .services` in server/portability: none) | DROP |
| server/auditlog.py, auditprune.py, bams/lifecycle.py, dupes.py, importer/plan.py|service.py|template.py, portability/{dbrestore,export,planner,readers,restore,tables}.py | zip == rc6; differ from source only because source was cleaned | ALREADY-IN-SOURCE (do not overwrite) |

## Database (db/)

| File | Change | Status |
|---|---|---|
| db/migrations/0003_bams_persistent_metric_alerts.sql (NEW) | `bams_alert_configs.auto_apply`, `bams_alert_rules.config_id` (FK ON DELETE SET NULL), unique index `ux_bams_alert_rules_config_metric (config_id, metric_id) WHERE config_id IS NOT NULL`, bumps schema_version to 3 | BACKEND-PORT |
| db/schema.sql | Same three additions inline; **schema_version INSERT at line 866 still says '2' in the zip** (diff shows no change there). Fresh DBs then start at 2 and rely on the migration; check how migrate.py handles a fresh DB (does it run 0003 after schema.sql?). Source has migrations 0001, 0002 only | BACKEND-PORT. Data Architect owns schema: raise via `docs/qa/SCHEMA_CHANGE_REQUEST.md`, not a direct edit |
| requirements.txt (root of zip; source keeps `server/requirements*.txt`) | Zip adds `blpapi>=3.25.10.1,<4` (no trailing newline) although the header comment says BLPAPI is NOT listed | DROP / decide. Contradicts its own comment and `server/requirements-release.txt` generated by build_release.py. Pip on a machine without Bloomberg mirror would fail. Do not port unless the user wants it; fix at the source of truth (requirements-release.txt) |

## Frontend / web (zip `web/` is a built artifact; source is `frontend/src`)

Important: zip `web/assets/index-I2MVC1x9.js` has the **same hashed filename as source's built web/** but is 565,934 bytes vs 558,083: the zip bundle was **hand-patched in the minified output** (identifiers `tamDone*`, `tamNotes*`). The filename hash is therefore misleading. Source `web/` is stale rc6 output and is not a reference. The zip `web/index.html` differs from source only by 2 lines loading `metric-alert-policies.css/js`.

| Zip artifact | What it does | Status |
|---|---|---|
| web/terminal-links.js (191 lines) | DOM scanner turning `{TICKER <GO>}` into Terminal links | ALREADY-IN-SOURCE: `frontend/src/components/ui/TerminalLinkText.tsx`, `lib/terminalLinks.ts`, `lib/terminalLinks.test.tsx`. Also NOT loaded by zip index.html (dead file), and the compiled bundle already contains the React link code |
| web/task-undo.js (175 lines) | fetch-wrapper offering 20 s Undo after task completion | ALREADY-IN-SOURCE: `TaskList.tsx` Undo toast with `onAction` (Toast.tsx, 10 s TTL). Not loaded by zip index.html (dead file). Only difference: 20 s vs 10 s window |
| web/metric-alert-policies.js + .css (497 + 42 lines) | Injected panel on `/bams/config` (finds `.page.bm-page`, mounts `#map-root`): metric-first alert policies using `/bams/metrics/catalog` + `/bams/configs`, operator direction, edit/delete, hides legacy "Starter templates" panel; installed via MutationObserver | FRONTEND-PORT-NEEDED. Source `ConfigPage.tsx` and `ApiDataSource.ts` (configs at lines 395-401) have no `auto_apply`, no catalog, no persistent apply. Needs: `BamsConfig.auto_apply` type, `getBamsMetricCatalog()`, apply with `metric_ids: null` meaning persistent, React ConfigPage policy UI, tests. Do not port the DOM-injection script |
| Patched bundle: TaskViewDialog | "Done" button in task popup (saveTask status Complete + Undo toast), inline notes editor (Add context, Save/Cancel) | FRONTEND-PORT-NEEDED (source `TaskViewDialog.tsx` is read-only, shows Notes only) |
| Patched bundle: row "Done" (`trow__done`, aria-label "Mark done: ...") on task rows in a grouped list | One-click complete with Undo | FRONTEND-PORT-NEEDED. Locate the owning list (Today/search rows using `trow` class) |
| Patched bundle: BAMS search suggestions (`bams-search-option-*`, "BAMS search suggestions" listbox; kinds account/object/ticker setting filters) | Typeahead on the BAMS dashboard search | FRONTEND-PORT-NEEDED (absent from `DashboardPage.tsx`) |
| web/assets/index-BPo3Yr2Q.css (86 KB vs 82 KB), TrendChart-hUKEsx38.js | CSS for the above; TrendChart chunk identical size family | FRONTEND-PORT-NEEDED for the CSS classes of the above; TrendChart: ALREADY-IN-SOURCE (`pages/bams/TrendChart.tsx`; only the stale older chunks `-BY73IgoS`, `-Dz-bGqGQ`, old index-C0LB--wt.js/DFZHXX1P.css are DROP) |
| Stray in zip root: BUILD_MANIFEST.txt, VALIDATION.txt, docs/, README etc | Release packaging | Out of scope |

## Tests that will need updating or adding after the port

- `server/tests/test_startup.py`: lines 182/184 (`schema_version == "2"`, health `== 2`), 251, 279, 412 assert version 2 after migration paths; with 0003 these become 3. Lines 239/269/393 craft fake `0003_*` migrations ("0003_bad.sql") that will now collide with the real 0003 filename: rename to 0004.
- `server/tests/test_import_reader.py` lines 160 and 398: `header_missing` for "Name only" still true (Account missing) but message text changes; any test for "Account or BPID", `appliance_required`, `metric_required`, `ticker_required` codes must change (these per-row required codes are gone; new `metric_required_for_metric`/`ticker_required_for_metric`, `account_required` wording is "is required").
- `server/tests/test_bams_import.py`: fixtures that expected Region fill-only semantics, "Polarity is an alias of Region" (D-108), and Appliance/Metric/Ticker mandatory headers; template shape (11 columns, Polarity at K); metric counts in preview.
- `server/tests/test_blpapi_provider.py` and `fake_blpapi.py`: already LAST_PRICE-explicit; add one test asserting the class default `FIELD == "LAST_PRICE"`.
- `server/tests/test_bams_monitor.py`: fake notifier has only `send()`; add tests for `send_async` path, notification log dedupe, `shutdown`, and `sync_auto_policies` in poll.
- New tests needed for: `sync_auto_policies` (create/adopt/update/disable), `metrics/catalog`, `notifications/test`, import `policy_sync`, `auto_apply` in config save, migration 0003 idempotency.
- Frontend: `Bams.test.tsx`, `ApiDataSource.test.ts`, `importState*.test.ts`, `MockBams`/`mockBamsImport.ts` (import header/polarity and mock catalog), TaskView tests (Done/notes), BAMS search suggestions tests.
- `db/tests`: schema snapshot/column-list tests and `sql_safety_scan.py` need the new columns (not inspected).
- Docs: `docs/04_API_CONTRACT.md` (two routes, `auto_apply`, import columns), `docs/03_DATA_MODEL.md` (schema v3).
