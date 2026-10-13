# QA Error Log 3: Run 2 gate (T-76)

Reviewer: qa-guardrail-agent. Date: 2026-10-13. Tree: committed HEAD `7eb68b2` ("Backend: regression tests for auto-seed progress"); the working tree was clean apart from the new QA test file. Source was not edited. The live server ran from a `git archive HEAD` copy (`server/ db/ web/`) in the scratchpad (`.../scratchpad/qa3/tree`), DEV mode, a free port (57519, `lsof` shows `127.0.0.1:57519 (LISTEN)` only), a fresh scratch DB so auto-seed ran. Severity policy per `docs/TEAM_LOOP.md`: only Blocker/High fail the gate.

## 1. What was run (real results)
| Check | Result |
|---|---|
| `pytest server` | 144 passed |
| `pytest db` | 109 passed, 12 subtests passed |
| `pytest tests/e2e` | 96 passed (72 existing + 24 new, see below) |
| `tsc --noEmit` | exit 0 |
| `vitest run` | 14 files, 191 passed |
| `build:api` into a scratch dir vs committed `web/` | `diff -r` IDENTICAL (`index-CKvu7YjX.js`, `index-Dc25ioEM.css`, `index.html`) |
| `sql_safety_scan.py .` / `--list-allow` | 0 violations / 0 allow markers |
| `pip-audit -r server/requirements.txt` | No known vulnerabilities found |
| `bandit -r server --exclude server/tests` | 0 High; 8 Medium (B608 builders, unchanged from log 2), 1 Low |
| `npm audit` | 8 findings (5 moderate, 1 high, 2 critical), unchanged (QA-E1-6) |

New test file: `TAM_Command_Center/tests/e2e/test_gate_run2_e2e.py` (8 tests, each run under process timezones America/New_York, Pacific/Auckland and UTC = 24 cases, fresh DB each). It does not call backend code: it recomputes the expected values from the SQLite file with the PM definitions and compares them with the live server:
- `progress` equals an independent N/M/open/done_other computation in all three timezones; `done <= total`, `total = done + open`; the seed exercises every branch (done, open, done_other all > 0).
- Complete then reopen of a plan task: N +1 / open -1 / M unchanged, then back to the original values; completing a second time in the same day counts once (two `completed` audit rows, N +1); a future-dated task completed goes to `done_other` only; re-dating it into the plan grows M and open by 1; deleting it restores the independent value.
- Queue: tiers non-decreasing and all six present; no (kind,id) twice; `upcoming` disjoint from `queue`; tier 1 = alerts, then tasks (priority, due), then upgrades (date) (D-32); tier 2 priority then title; tier 6 within T+1..T+3; D-23 (no account-level follow-up row when a same-date Client Follow-Up task exists); no Inactive account in the queue; no steps/next-action keys on a queue item.
- `GET /api/accounts/activity-trend`: series keys equal the Active accounts, 14 non-negative integers each, `days=7` gives 422, `include_inactive` adds accounts, and the last bucket equals the count of that account's Activity entries on the local day (checked per timezone).
- `server_tiles`: one tile per distinct server name, `servers` equals the tile count, spark only when stored samples exist (at least 2), 2 to 28 points, window at most 168 h, metric rule (alert metric, else CPU), no spark for a server with no samples.
- Headers and CSP, 405 with `Allow`, 422 on the new routes.

## 2. Re-verification of earlier items
| ID | Result | Evidence |
|---|---|---|
| QA-E2-1 CORS preflight lacks headers | FIXED | `test_headers_everywhere[OPTIONS-...]` passes (structured 400 `cors_rejected` with security headers) |
| QA-E2-2 `Allow` on note write routes | FIXED | `test_405_allow_header_note_write_routes` passes; new routes (`POST /api/today`, `POST /api/accounts/activity-trend`, `PUT /api/client/x/infrastructure`) give 405 with `allow: GET, HEAD`, JSON body, all four security headers |
| QA-E2-3 top-bar Capture prefill | FIXED | Browser, `/accounts/<id>/infrastructure`, click "+ Capture": the Account field holds the account name |
| QA-E1-5 scanner residue | STILL OPEN (Low, accepted) | unchanged |
| QA-E1-6 npm audit | STILL OPEN (Low) | same 8 findings |

Run 1 regression pass (no regressions found): notes CRUD (create, edit, stale 409, delete without `confirm` 409, delete 200, second delete 404; hostile subject/body rendered literally in Activity and in Today "Recently changed"; `window.__xss` unset, 0 injected `img[src=x]` or `script`), task complete/reopen from the Tasks page, Quick Capture (top-bar prefill, above), contacts primary and settings (e2e suite), headers/CSP on every checked response class, 413 above the 2 MiB cap (2.2 MB body), 403 on a foreign Host, loopback-only bind.

## 3. Run 2 verification against the approved design (browser, real DEV backend, fresh seeded DB)
Today (Triage Split, D-26..D-30, US-3.6..US-3.9):
- Default list: exactly 10 rows, titles equal `GET /api/today` `queue[0:10]` in order; first row selected, its detail shown; "Showing 10 of 69", "View all (69)".
- Chips (counts from the full queue, 69 items): Top 10 = 10, Overdue/critical 17, Due today 7, Alerts 6, Waiting 18, Upgrades 16, Next 3 days 5, All 69. They equal the API tier counts. `role=radiogroup`, roving tabindex, Left/Right moves and selects. `?show=t1|t4|t6` list every item of the tier (17/18/5, "Showing N of N", no cap); `?show=all` lists 69 in exactly the API order with six tier headings and counts; `?show=bogus` falls back to Top 10; Back from `?show=all` returns to Top 10; reload keeps the state. No "Plan" chip.
- Order: tier 1 = 2 Critical alerts, then High/Medium/Low tasks by due, then the three overdue upgrades (D-32); tier 2 priority then title; upcoming-only objects (48) are all absent from the list.
- Detail pane: why-sentences match the §10.1 table for every kind checked (critical alert, overdue task, overdue upgrade, due today, alert, recovered, waiting with and without a date, scheduled upgrade, validation, tier 6 task). Null facts omitted. `document.body.innerText` has none of "What to do", "Mark complete", "Next action", steps. Hostile task title (`<img onerror>`, `<script>`) and `{DRQS ... <GO>}` render literally in the list and the detail.
- Keyboard: ArrowDown/Up/Home/End move the selection (`aria-activedescendant` follows, no wrap), Enter opened `/accounts/<id>/infrastructure?server=...`, a single click only selects. Tab order: skip link, rail, search, refresh, chips (one tab stop), listbox, View all, account link, Open button, Later tabs; a 2px `--focus` outline on every stop.
- Ring: browser text "8 of 27 tasks done" equals an independent SQL recomputation (N 8, open 19, M 27, done_other 2). Completing a due-today task from the Tasks page: 9 of 27 (open 19 to 18, M unchanged); reopening: 8 of 27; completing again: 9 of 27 (N changes, M does not). After a UI mutation the Today ring showed the new value. Date rollover: with `Date` shifted +1 day in the page, one `/api/today` refetch fired within 30 s (AC3). M = 0 / N = M texts are covered by vitest (`App.test.tsx`), not driven in the browser.
- Later tabs: collapsed on load (0 `tabpanel`), Upcoming (48), Recently changed (20), Account load; Account load shows 8 rows and "All accounts (10)"; clicking the open tab collapses it; no dialog or drawer is used.
- No console errors from the app; the only 4 console entries (422, 2x 409, 404) are my own deliberate API probes.

Account workspace (US-5.6): header band with Open tasks (3 overdue, 4 waiting in text; bar Overdue 3 / Waiting 3 / Other 6, exclusive and summing to 12), Servers (PROD 2, DEV 1, "1 critical"), Alerts, Next upgrade with a track, Next client touch; Top item panel (D-34) with no steps and no completion control, hidden for the Inactive accounts that have no queue item; due histogram (20 bars, older overdue pooled in the first bin, labelled axis, hidden table); server tiles (5-up grid, 170 px tiles). Sparklines vs `server_tiles` on all 12 accounts: tile count, spark count and "No trend data" count agree (7 sparklines in total, every other tile says "No trend data"); upgrade timeline pins a 26 Jul Exception to the left edge with its real date. No gradients, no score or grade anywhere.
Accounts (US-4.2): Portfolio "10 active, 7 with overdue, 8 with alerts, 1 clear" and Next 15 days "Upgrades 12, Client touches 5" both match independent counts from the API. Open load: top 6 in the specified order. Needs attention: Halvorsen, Castellan, Bluewater, Ostrava, which matches the D-33 key worked out by hand (Kestrelmoor's alert is Info, so Ostrava ranks above it); reasons come from the signals, no number. Table columns Account, Load, Overdue, Waiting, Alerts, Servers, Next upgrade, Next contact, Activity; every bar, dot row and sparkline carries a text label; the 14-point activity series equals `/api/accounts/activity-trend` (sums match the label "15 entries" etc.).

Calm rules (§15, greps over `frontend/src`):
- Raw hex or rgb outside `tokens.css`: 0. `<select>`: 0. `gradient(`, `backdrop-filter`, `blur(`: 0 anywhere. `border-radius` not from tokens: only `1px` on bars and marks (`instruments.css`, `today.css`, `refresh.css`, `shell.css`), accepted as spec'd ("radius 1px").
- Run 2 files (`instruments.css`, `today.css`, `refresh.css`, Run 2 TSX): no `@keyframes`, `animation`, `box-shadow`; `--r-round` only on status dots, ring, avatars, marker rings, plus a 6 px calendar-strip marker (`.cal__mark`, `refresh.css:81`), which reads as a status dot. The three `--surface-*` tints equal the 12% blend (recomputed: `#2b2a20`, `#2e1e23`, `#2d251d`). A guard test pins the Run 2 files.
- Ruling on the Run 1 animations (QA-E3-3): overlay and drawer entry (`pop-in`, `drawer-in`, 120 ms opacity plus an 8 px translate), toast `pop-in`, skeleton `pulse` (1.4 s, infinite, loading state only) and the refresh icon `spin`. None runs in Today's steady state, and `prefers-reduced-motion` sets all durations to 0 (`base.css:55`, `ui.css:296`), so US-3.9 AC1 holds and §15.5 reduced motion holds. Accepted; the guideline grep text is too broad (Low, doc).
- Contrast (recomputed): `--muted` 7.18:1 on surface-1; status colours 6.05 to 10.9:1; `--border-control` 3.7:1; the "other" segment `--border-strong` 2.03:1 (decorative, count is in text, per §15.5). `--subtle` is 3.88:1 on surface-1 and 3.62:1 on surface-2 (QA-E3-2).

Widths (1440, 1100, 768, 390), `scrollWidth == innerWidth` on Today (top and all), Accounts, Overview, Infrastructure, Tasks, Activity, Settings at every width: no page-level horizontal scroll. Today: list 418 px / detail 752 px at 1440; list 338 px at 1100 with the detail's two columns stacked; at 768 and 390 the detail sits under the list (list 267 px from top, detail 765 px) and the chips wrap to two rows. At 390 (below the 768 minimum) the Later tab bar and the workspace tab strip scroll inside their container (no page overflow).

## 4. Findings
No Blocker or High findings. No Medium findings.

### QA-E3-1 | Low | owner: frontend-dev-agent | spec: PM §10.4 #16, guidelines §15.5
**Accounts "Alerts" cell and "Servers" dot-row disagree, and the Alerts cell mislabels recovered alerts.** Reproduce: Accounts page. Kestrelmoor Capital shows "1 open" in Alerts (an open Info alert on kmc-bpipe-hk-01) while its Servers dot row reads "3 servers, 0 with an alert" (Info is deliberately excluded from the dots). Tidewater and Bluewater show "1 open" for an alert that is `recovered` (waiting to be closed). The Alerts dot is always warning-coloured, including for Critical (Halvorsen, Castellan). Code: `AccountsPage.tsx:86` (`a.active_alerts` is open plus recovered, label "open", fixed warning dot). Impact: wording and colour only; no data is wrong.

### QA-E3-2 | Low | owner: pm-agent (guidelines) + frontend-dev-agent | spec: guidelines §1 vs §15.4
**`--subtle` text fails 4.5:1 and is used for readable copy.** `--subtle` is 3.88:1 on surface-1 and 3.62:1 on surface-2, and §1 says "Disabled text and zero values only (not for anything that must be read)". Run 2 uses it for the "No trend data" caption (`ServerTiles.tsx`) and the histogram axis labels, which §15.4 itself specifies as `--subtle`; so the guideline contradicts itself. Fix: use `--muted` for "No trend data" and axis labels, or amend §1.

### QA-E3-3 | Low | owner: pm-agent | spec: guidelines §15.6 #10, PM T-70
**The QA grep text and the T-70 guard are broader than the code.** §15.6 #10 says no `@keyframes`/`animation` and no `box-shadow` other than `--shadow-pop` anywhere in `frontend/src`; Run 1 code has `pop-in`, `drawer-in`, `pulse`, `spin` keyframes and `.table tbody tr.is-highlight { box-shadow: inset 2px 0 0 var(--accent) }` (`ui.css:173`). The guard test only covers the Run 2 files. Ruling above: acceptable. Fix: reword the rule to "Run 2 files, and no animation in Today's steady state".

### QA-E3-4 | Low | owner: frontend-dev-agent | spec: PM §10.1 key facts
**Alerts and similar "Opened" facts read "2d overdue".** Detail pane for an alert: "Opened: 11 Oct 18:40 · 2d overdue". An open time is not a due date; the list row says "opened 11 Oct". Use "2d ago" for `date_kind` Opened. Wording only.

### QA-E3-5 | Low | owner: data-architect-agent | spec: PM §10.4 #7, T-61(b)
**Seed realism.** The sparkline's latest point (hfa-bpipe-ldn-01 CPU "latest 99") does not match the alert's own value shown in the header and the queue ("value 97.4"), because the seeded 7-day samples are independent of the current metric value. Dev servers also render "DEV DEV" in a context line (environment and region both "DEV"). Seed content only; the code derives from stored data correctly (verified against the DB).

### QA-E3-6 | Low | owner: frontend-dev-agent | spec: PM US-2.4 (supported minimum 768)
**Narrow-width clipping (below the supported minimum).** At 390 the top-bar placeholder reads "Jump to accoun", the header Alerts message is clipped ("(value"), and Needs attention reasons begin with a lower-case letter ("upgrade 23d overdue"). No page overflow. Not required at this width; listed for polish.

### QA-E3-7 | Low | owner: frontend-dev-agent | spec: PM US-3.7 AC3 (test gap), carried from T-2
**Midnight rollover and the page-wide arrow handler are untested and have one side effect.** The rollover works (verified in the browser by shifting `Date`), but no vitest covers it. The window `keydown` handler (TriageList) also takes ArrowUp/ArrowDown whenever focus is on the page body, so those keys cannot scroll the Today page; this follows D-26 ("arrow keys move the selection") and is by design.

## 5. Visual deviations from the mockups (the build is correct where it follows spec §10.5)
Pixel comparison was not possible: the Browser pane downscaled screenshots at emulated widths above its own width (the 1440 page filled about a third of the frame), so the review used computed geometry, DOM and styles at 1440/1100/768/390 plus native-width (about 400 to 500 px) screenshots of Today, Accounts and the workspace.
1. Workspace Overview: the context column keeps the Run 1 order (Next client touch, Infrastructure summary, Contacts, Account details, one grouped panel), and Recent activity is a full main-column panel; the mockup has Account details as a top panel and puts Contacts and Recent activity in the side rail.
2. Main/context split is fluid (about 848 px main, 320 px context at 1440), not the mockup's 7/5 columns (the guidelines allow either).
3. Workspace Alerts value is always warning-yellow, as in the mockup, even when the only alert is Critical (the Servers cell says "1 critical" in red).
4. Server tile and sparkline details follow the spec, not the mockup: sparklines on 7 of 40 tiles only, "No trend data" elsewhere, solid tint tokens instead of gradients; sparkline labels use the real window ("CPU 7d").
5. Accounts: Needs attention reasons are generated text ("Critical alert, upgrade 79d overdue"), the servers dot of the alerting server (not the first), activity trend of 14 points; the Alerts cell shows "N open" with a warning dot regardless of severity (QA-E3-1).
6. Today: "Top 10" replaces "Plan", no steps and no Mark complete, "Showing N of M / View all" footer, Later bar reads "Collapsed to keep this screen calm". All as ruled in §10.5.

## 6. Open Medium/Low after this gate
QA-E3-1 to QA-E3-7 (all Low), plus QA-E1-5 and QA-E1-6 (Low). All tracked in `docs/qa/OPEN_ITEMS.md`. Windows remains untested (spec section 56).

VERDICT: PASS (0 open Blocker/High)
