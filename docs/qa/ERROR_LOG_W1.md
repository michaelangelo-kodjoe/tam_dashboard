# ERROR_LOG_W1: 0.2.0 candidate integration gate (QA-W1), 2026-10-23

Method: scratch instance (port 8777, DB `qaw1`, DEV, simulated BAMS; removed afterwards), headless Chrome driven over CDP at 1440x900, 1024, 639 and 390 px, scratch DB migration copy, API scripts. Real app on 8766 not written to.

## Evidence
- Backend `pytest server db -q`: 697 passed, 1 failed (`test_qa_e5_3_seeded_alert_mix_survives_polls`, known, untouched tree). Frontend: `tsc --noEmit` clean; Vitest 46 files / 549 tests passed. `sql_safety_scan`: 0 violations. bandit (-ll): 2 Medium B608 at server/bams/service.py:604,641, both f-strings built from fixed column tuples / `?` marks with bound values (false positives). pip-audit (requirements.txt): clean. npm audit --omit=dev: 2 moderate (react-router, see QA-W1-3).
- web/ is current: no source file newer than web/index.html; one index bundle, one TrendChart chunk; no metric-alert-policies / task-undo / terminal-links JS or script tags (the only grep hit is a comment in frontend/src/lib/bamsPolicy.ts).
- Item 1: drag over chart issued `trend?from=...Z&to=...Z`, label became "Zoomed: 19 Oct 12:24 to 20 Oct 23:03 (1.4 d)", Reset zoom restored "Showing ... (6.8 d)". Forced 422 shows "That window cannot be loaded: ..." and keeps the loaded view; empty window shows "No samples in this window." API: from alone, from>=to, >7 d, unparsable, older than retention all 422 with field messages.
- Item 2: rows computed `bm-row--critical` red (255,92,92), `--warning` (232,197,71), `--info` blue. Only rows measured; badges/cards/bell not pixel-checked.
- Item 3: drawer screenshot shows no 30/60/90 or threshold lines (legend + text equivalent only). 30D/60D/90D HIGH stat cards and table columns remain (not chart lines).
- Item 4: UI editor saved `<strong><em><u>` (written `<b><i><u>`), `<span style="font-size: 14px">`, `<ul><li>` (DB rows, `<!--tam:rich-->` prefix, never in API). Timeline renders strong/list as elements. API XSS payload (script, img onerror, javascript: link, svg, iframe, comment, onmouseover, style+url(), 99px size) all stripped; plain legacy note `<b>raw</b> & text` returned verbatim and rendered as literal text; marker typed into a plain body is stripped; html without body 422; empty html -> null. Search `q=bold` 1 hit, `strong`/`onerror`/`alert` 0. 27 test_rich_notes tests pass including export/restore round trip (not re-run by hand). No dangerouslySetInnerHTML; htmlToReact builds elements; only RichTextEditor assigns innerHTML after client sanitiser (server also sanitises on read).
- Item 5: "Windows delivery is unverified" absent from source and both bundles; BAMS settings page text clean (DEV).
- Item 6: SPA route switch to BAMS rows: visit 1 99 ms (incl. lazy chunk), visit 2 45 ms, visit 3 26 ms; Accounts 12/10/13 ms. Local DB, so absolute numbers are small. No console errors.
- Item 7: Metric field is the custom combobox; ArrowDown, ArrowDown, Enter selected "Disk Usage (%)".
- Item 8: Config page tree collapsed by default, master "Expand all account groups" button, "Filter metrics" input; account > appliance > metric nesting.
- Item 9: metric drawer 1100 px wide at 1440, 992 at 1024, full-screen at 639 and 390 (no horizontal overflow from the dialog). Note drawer 720 px, task popup 880 px; both full-width at 390. Page-level horizontal overflow at 390 px comes from the account tab bar, not the dialogs (QA-W1-4).
- Back-port: policy create via UI ("Disk Usage (%) policy saved ... 24 appliances"); API: auto_apply create -> 24 managed rules, edit threshold 85 -> 70 updates all 24, auto_apply off disables all 24, apply preview+confirm -> persistent, delete config -> 24 rules kept disabled with config_id NULL, no crash, bad `auto_apply:"yes"` 422. Audit rows present (created/updated). Done + Notes buttons in task popup work (status Complete, Undo toast). BAMS search suggests appliances and tickers, Enter picks. Terminal workbook (sheet "Sheet9") auto-detected, note shown, 2 rows -> appliance BA49686, applied with pre-import backup and 3 audit events. Notifier test API: `{"detail":"dev: not displayed","notifier":{"available":true,"mode":"dev capture"}}`. Provider FIELD = "LAST_PRICE". Migration 0003 on a real rc6 (v2) DB copy: 2 -> 3, pre-migration backup (v2) written, all table counts unchanged (3141 -> 3142 = one app_meta row), foreign_key_check/integrity_check clean, second run no-op. Second instance refused (lock, exit message names PID/port). Bind: LISTEN on localhost only. CORS: no Access-Control headers for a foreign Origin. No .db/.env/secrets tracked.
- activity_timeline.sql change: adds `:q_like_html` as an extra bound LIKE on `n.body`; parameterised, ESCAPE kept; matching of visible text is finished in Python (`search_text`), so markup words do not hit. Acceptable.
- Unrequested change (not a defect): starter templates now behind "Show advanced templates" on the config page. User decision to confirm.

## Items
| ID | Sev | Owner | Spec | Item |
|---|---|---|---|---|
| QA-W1-1 | Medium | frontend-dev | accessibility (spec 4x keyboard) | `RichTextEditor.tsx` defines `Btn` inside the component, so every render (each selectionchange sets state) unmounts and remounts the whole toolbar. Reproduce: open a note editor, place caret in Body, focus "Bulleted list" and press Enter: focus is on BODY, formatting not applied; read-page refs of toolbar buttons are stale within a second. Expected: toolbar buttons keep identity and focus. Fix: hoist `Btn` out of the component. Mouse use works (formatting persisted). |
| QA-W1-2 | Low | backend-dev | testing | `test_qa_e5_3_seeded_alert_mix_survives_polls` fails on an untouched tree (known). |
| QA-W1-3 | Low | frontend-dev | security | `npm audit` 2 moderate in react-router 6/7 (open redirect via backslash in Link/useNavigate; SSR hydration issue not used here). Local app, no untrusted link targets. Bump with the next dependency pass. |
| QA-W1-4 | Low | frontend-dev | responsive | At 390 px the account workspace page scrolls horizontally (tab bar, document 437 px). Dialogs are fine. Likely pre-existing. |
| QA-W1-5 | Low | team-lead | release | `/api/health` still reports version `0.1.0-rc6` for the 0.2.0 candidate; bump at packaging. |
| QA-W1-6 | Low | backend-dev | data realism | DEV simulator yields CPU/Network 30D/60D/90D highs above 100 % (102.1 %, 130.3 %, 187.8 %). Cosmetic. |

## Not verified
Real Windows desktop toast and PROD mode (macOS host; PROD-route absence only via unit tests); Import UI for the Terminal workbook driven through the API, not the file picker; pixel comparison against mockups/bams-v2; amber/red on bell, cards and badges (rows only); export/restore round trip by existing test, not by hand; 15 s poll vs cache interplay beyond timing.

## W2 (focused re-check, 2026-10-23)

Build: current source; `web/` and `RichTextEditor.tsx` were rebuilt by the owner while I was testing (19:27). My first run at the old bundle lost a palette colour on save (stored body had no span, `<p><ol>`); every later run on the new bundle persisted it. Results below are the new bundle only.

### Re-verification of W1 items
| ID | Status | Evidence |
|---|---|---|
| QA-W1-1 | FIXED | CDP-driven Chrome: Shift+Tab from body lands on "Smaller text"; Bold via Enter, Space, Enter, Space keeps focus on "Bold (Ctrl+B)" each time; ArrowRight moves to "Italic". Palette: opens on Amber, Arrows move, Enter applies and returns focus to "Text colour", Esc closes palette only (dialog stays). |
| QA-W1-2 | FIXED | `pytest server db -q`: 734 passed, 0 failed. |
| QA-W1-3 | FIXED | react-router-dom 7.18.4; `npm audit --omit=dev`: 0 vulnerabilities. (Dev tooling advisories: see QA-W2-1.) |
| QA-W1-4 | FIXED | 390 px, 15 routes (all main pages, five account tabs, all BAMS pages): `scrollWidth == clientWidth == 390` on every one. Wide tables sit inside their own scroll containers. |
| QA-W1-5 | OPEN (Low) | unchanged, bump at packaging. |
| QA-W1-6 | OPEN (Low) | not re-tested, unchanged. |

### Checks
- (a) Templates: `Templates` component and "Starter templates" panel (explicit apply copy) are the same as `git show HEAD:` version; no "advanced templates" string anywhere in `frontend/src`. The only ConfigPage diff vs HEAD is the earlier metric tree and policy panel, not the templates.
- (b) Lists: Meeting, Call, General notes and Quick Capture (General note): editor computed `ul` disc / `ol` decimal / nested `circle`, 24 px indent; timeline renders real `ul/ol/li`, disc/decimal. Nesting made with `execCommand('indent')` (no Tab-to-indent: Tab moves focus, by design; no UI control for nesting exists). Task popup has no rich editor (n/a).
- (c) Colours: all seven palette swatches plus Default applied in one note; stored as `#FA9A28 #E5484D #3FB950 #4C9AFF #B392F0 #8B949E #F0F0F0` and plain text for Default; reopened editor shows same, computed colours match; re-save keeps format. Timeline computed `rgb(63,185,80)` for Green. API (real backend): palette hex any case accepted and upper-cased; `font-size:14px;color:#4c9aff` -> `font-size: 14px; color:#4C9AFF`; `rgb()`, named, `url()`, non-palette hex, extra properties (`position`, `background`, `font-weight`, `behavior`) all stripped (text kept; a span with a valid colour plus any extra property loses the whole style, which is strict but safe); `onclick`, `img onerror`, `javascript:` link removed.
- (d) Done above.
- (e) 16 routes incl. deep links and unknown route ("Page not found") load with no console errors; SPA nav clicks, back x3, forward, `?task=` deep link opens and Back closes it, account tab click and Back restore previous tab.
- (f) Done above.
- (g) pytest 734 passed; `tsc --noEmit` clean; Vitest 47 files, 558 passed.
- Export/restore (two scratch DEV trees): note with size+colour, bold, italic, nested ul and ol: Excel export, inspect (1 New, 654 Identical, 1 Differs, 0 Invalid), apply -> note body byte-identical, `body_format` html. PROD refusal of DEV export (`channel_mismatch`) works. Database export: `integrity_check` ok, body stored with `<!--tam:rich-->` prefix.
- BAMS colours (computed): Critical badge/bell count `rgb(255,92,92)` (#FF5C5C), Warning badge `rgb(232,197,71)` (#E8C547), Info `rgb(90,174,255)`, same across Alerts and Dashboard badges; account page warning text/badge `rgb(232,197,71)`. Note: Warning is yellow-gold (#E8C547), not palette Amber #FA9A28; confirm that is intended.

### Items
| ID | Sev | Owner | Spec | Item |
|---|---|---|---|---|
| QA-W2-1 | Low | frontend-dev | security | `npm audit` (dev dependencies only): 6 advisories (vite/esbuild/vitest/tinypool chain; 2 critical, 1 high by advisory rating). Not shipped in `web/`, dev server only; production audit is 0. Upgrade vite/vitest in next dependency pass. |
| QA-W2-2 | Low | frontend-dev | usability | No UI control to nest list items (Tab moves focus); nesting only possible via browser shortcuts. Pasted/restored nesting renders correctly. |
| QA-W2-3 | Low | backend-dev | data | Server stores `<ul><li>..</li><ul>..</ul></ul>` (list as direct child of list, from browser indent) and `<p><ol>` pattern previously; valid-enough in browsers, not strict HTML. Cosmetic. |
| QA-W2-4 | Low | backend-dev | testing | Simulator limitation: percent-only simulator vs seeded Mbps NET metrics; simulator test was narrowed to percent metrics. Logged in OPEN_ITEMS. |

### Not verified
Bell inbox row-level severity colours (panel opened, only count/badge measured); Windows rendering/Edge; PROD route absence (unit tests only); visual pixel review (the browser pane screenshots rendered at a fraction of the viewport, so layout and colour checks used DOM computed styles via headless Chrome/CDP). My test notes (34) were deleted from the DEV database via the API; each delete created a safety backup and an audit row in Activity.

VERDICT: PASS (0 open Blocker/High)
