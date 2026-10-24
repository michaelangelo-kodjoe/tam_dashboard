# PERF_AUDIT: PROD-path slowness audit (0.2.0-rc5 working tree)

Read-only audit. No source edited. Harness and raw results (scratch only): `scratchpad/launcher.py`, `bench.py`, `benchA.txt`, `benchB.txt`, `inflate*.py`, `prof*.py`.

## Method (what was actually run)
- Scratch copy of `server/ db/ web/ tools/`, `VERSION.txt` set to `channel=prod`, so the real PROD code path runs (`BlpapiProvider`, no simulator, no DEV routes, real uvicorn on port 8790; the 8766 dev server was not touched).
- DB copied from `dev_data/tam_dev.db` and inflated (scratch only): 156 accounts, 2,259 tasks, 2,730 notes, 455 contacts, 27 appliances, 103 metrics, **4,449,600 minute samples** (43,200 x 103; 1.09 GB), 30,893 audit rows.
- Scenario A: fake `blpapi` module, `socket.create_connection` patched to sleep 0.5 s twice then raise `OSError` (Terminal off, IPv6+IPv4). Scenario B: connect succeeds in 2 ms, fake session whose requests never answer (30 s request deadline), monitor started.
- All 61 documented routes timed (81 OpenAPI path entries; 501 stubs excluded): cold = first call, warm = 5 repeats. Table is in `benchA.txt` / `benchB.txt`.

## Headline numbers (macOS SSD; Windows with AV will be slower)
| | A (Terminal off) | B (Terminal up, hung session) |
|---|---|---|
| warm p50 across endpoints | 3.4 ms | 3.6 ms |
| /api/state warm | 24 ms (1.3 MB body) | 27 ms |
| /api/bams/state warm | 4.4 ms | 10.7 ms (spark on) |
| warm over 150 ms (excl. intentional exports) | none | `bams/metric/trend 30d` 230 ms |
| cold over 1 s | `client/infrastructure` 910 ms | `client/infrastructure` 1,050 ms; `trend 30d` 2,089 ms |

The probe fix works: after the first call, `/api/state` and `/api/bams/state` stay at 24 and 4 ms, also across the 10 s TTL boundary (verified: calls at +11 s and +13 s, no inline wait, background probe logged once per 10 s).

## Findings (ranked)

### PERF-1 High: daily sample prune + recompute of highs run inside the poll write transaction
`server/bams/monitor.py:146` opens `transaction(conn)` (BEGIN IMMEDIATE) for the whole ingest loop and calls `_daily_prune` at `:161` (def `:318`), which calls `recompute_highs` (`:333`) for every metric: 3 range scans each.
- Measured: `recompute_highs` x103 metrics = **22.0 s** at 4.45 M rows (30 days of data; a 90-day history is ~3x).
- While a write lock is held, reads are fine (28 ms) but a write fails: `POST /api/note/save` waited **5,228 ms then returned HTTP 500 "Unexpected server error"** (busy_timeout 5 s, `db/migrate.py:76`).
- Triggers once per day on the first poll after the Terminal is up (the user's morning). Samples are only inserted on a value change (`monitor.py:209-213`), so real volume is lower than the synthetic 4.4 M, but 1-3 M rows after 100 days with ~100 metrics is plausible.
- Fix: run prune and highs outside the ingest transaction, one short transaction per metric (or incrementally maintain highs; the ingest already updates highs on new maxima). Return a retryable 503/"busy" instead of 500 for lock timeouts.
- Not verifiable here: the user's real sample count.

### PERF-2 High: server tiles in `/api/client/{id}/infrastructure` parse every sample with strptime
`server/infra.py:63-64` (`_instant`), `:71-83` (`_downsample`), `:86-96` (`_spark`), called from `:99`/`:212` for every tile. Each tile reads up to 7 days of minute samples (10,080 rows) and calls `strptime` per row.
- Measured: ~100 ms per tile warm (profile: 20,153 `strptime` calls = 0.17 s of 0.22 s); 3-4 tile accounts 186-228 ms; **first call 910-1,110 ms**. An account with 10 servers is ~1 s warm.
- Hit on every Workspace open (`frontend/src/pages/WorkspacePage.tsx:28`, regardless of tab) and again on every mutation (`bump`).
- Only costly when the Terminal has run (samples exist). With the Terminal usually off it is cheap, which is why dev testing missed it.
- Fix: bucket in SQL (`GROUP BY CAST((julianday(sampled_at)-julianday(:lo))*86400/:w AS INT)` with `max(value)`), no per-row Python datetime parsing; or cache per metric for 60 s.

### PERF-3 High (when DB >~100 MB): every destructive action takes a full-DB safety backup + integrity_check inside the request
`server/backups.py:48-58` -> `db/migrate.py:119-132` (`conn.backup` then `PRAGMA integrity_check` on the copy). Call sites: `server/services.py:221,338,484,607,636`; `server/ops/service.py:83,177`; `server/bams/service.py:413,934`; imports `server/importer/service.py:145`, `bams_service.py:154`; `portability/restore.py:369`.
- Measured on 1.09 GB: note delete **15.9 s**, task delete **12.4 s**, client delete **14.2 s**, manual backup 15.5 s. Split: backup 1.9 s + integrity_check 12.7 s. On the 32 MB dev DB: 0.06 s + 0.36 s = 0.4 s. `quick_check` on the 1 GB file was 7.8 s, so it only halves it.
- 1 s is crossed at roughly 80-100 MB, i.e. a few weeks of Terminal-on sampling. The delete buttons freeze for that long and the UI shows no progress.
- Fix: keep the backup (data safety) but drop integrity_check from the request path (run it in a background thread after the response, or only for weekly backups); exclude `bams_metric_samples` from safety backups (re-creatable, it is >95% of the file) or backup only the CRM tables; show a busy state.
- Also `GET /api/export/database` 15-17 s (`portability/export.py:145`, same backup + integrity_check); user-initiated, Low on its own.

### PERF-4 Medium: first request after launch waits ~1.0-1.3 s for the inline probe
`server/bams/provider.py:83-95`: the very first `_reachable()` probes inline while holding `_probe_lock`, so every concurrent `availability()` caller waits. Measured with 6 concurrent calls at cold start (Terminal off): `/api/state` 1,287 ms, `/api/bams/state` 1,273 ms; `/api/today` (no provider) 323 ms. `/api/state` gates the whole UI (`AppShell.tsx:82-90` shows a skeleton until it returns), so first paint is +1.3 s each launch. (Probe timeout is now 0.5 s x 2 addresses; on Windows a refused loopback connect is not immediate, so expect >= 1 s.)
- Fix: start the first probe in the lifespan (`app.py:219`) on a thread; until it answers, `availability()` returns "unknown/unavailable" without waiting. Connect to `127.0.0.1` explicitly to avoid the IPv6 attempt.

### PERF-5 Medium: Stop (and app shutdown) blocks up to 5 s while a Bloomberg request is hung
`server/bams/monitor.py:72-78` `deactivate()` does `t.join(timeout=5)` on the request thread. Measured with the hung fake session: `POST /api/bams/monitor/stop` **5,026 ms** (twice, 5,016 ms). `Runtime.close` (`runtime.py:~124` -> `Monitor.shutdown`) pays the same on exit. The poll itself holds `provider._lock` and `_poll_lock` for up to `REQUEST_TIMEOUT_S` = 30 s per batch (`provider.py:~172`, `monitor.py:107`), but no read route takes those locks (verified: only `dev_poll`, DEV-only).
- Fix: set the stop event and return without joining (let the thread end on its own), or join with a short timeout off the request path.

### PERF-6 Medium: `alerts_list` loads every alert event ever recorded, polled every 15 s
`server/bams/reads.py:386-394` (`rows = [dict(r) for r in conn.execute(sql)]` with no WHERE/LIMIT), then filters, sorts and builds rows in Python; per-item `rule_row` N+1 at `:422`. Closed events are never pruned (only samples are, `repo.py:130`). Measured: 4 ms at 32 events -> **41-48 ms at 5,032 events**, linear (~9 ms per 1,000). Polled by `AlertsPage.tsx:26` and, together with `bams/state`, by `InfrastructureTab.tsx:22-23` every 15 s. Fix: push status/account/metric filters, ORDER and LIMIT into SQL; add retention for closed events.

### PERF-7 Medium: metric trend 30d/90d rescans the range on every 15 s poll
`server/bams/reads.py:343-385` runs 3 aggregate/scan statements over the range; `MetricDrawer.tsx:26` re-requests it every 15 s. Measured at 43,200 pts/metric: 120 ms warm (230 max), **2,089 ms cold**; 90 d would be ~3x. Fix: don't poll the trend (refresh on open and on range change), or cache by (metric, range, minute).

### PERF-8 Medium: frontend fan-out and duplicate requests (no in-flight de-duplication, no abort)
Counts below are from code plus a live trace of `/bams` (state x1, notifications x2, bams/state x2 in 20 s).
- `store/DataContext.tsx:64-96`: every `refreshMs` tick, every `version` bump and every key change starts a new request even if one is already in flight; the superseded response is ignored (`seq`) but the server keeps working on it (no AbortController). A response slower than the interval therefore stacks requests, which matches the three overlapping `/api/bams/state` calls in the user's log.
- `bump()` (45 call sites) refetches every mounted query: after any save, `/api/state` (1.3 MB), `/api/today`, the page's BAMS queries and notifications all re-run.
- `DashboardPage.tsx:51-52`: search text is part of the key, so each debounced edit (250 ms) is a full `/api/bams/state` (4 availability calls each); filters do the same.
- `ConfigPage.tsx:46` and `PolicyPanel.tsx:24` (rendered at `ConfigPage.tsx:70`) both fetch `bams-configs` on the same page: duplicate request on every visit.
- Per page (load / idle per minute; shell adds `/api/state` x1 on boot and `/api/bams/notifications` x1 on load + 4/min on EVERY page, `BellInbox.tsx:10,21`):
  - Today: +`/api/today` x1 / 0 (auto-refresh default "off").
  - Accounts: +`/api/today` x1 / 0.
  - Workspace Overview/Tasks/Contacts: +client infrastructure x1, +today x1, (+activity x1 on Overview) / 0.
  - Workspace Infrastructure: as above + `bams/state` x1 + `bams/alerts` x1 / **+8 per min** (12 per min with notifications).
  - Operations: +operations x1 / 0.
  - BAMS Dashboard: +`bams/state` x1 / 4 per min (8 with notifications).
  - BAMS Alerts: +alerts / 4. Metric drawer open: +metric +trend / 8 more per min.
  - BAMS Config: +state(spark off), configs x2 (duplicate), catalog / 0. BAMS Settings: settings, monitor / 0.
  - Settings: backups, logs / 0.
- `/api/state` is also re-fetched in full as a freshness check by `ContactDrawer.tsx:45,68` and `AccountDrawer.tsx:83,109`.
- Polls pause while the tab is hidden (`DataContext.tsx:90`); there is no refetch-on-focus. Good.
- Fix: in-flight map keyed by query key (share the promise), skip a tick while in flight, `AbortController` on supersede, scope `bump()` to affected keys, a `/api/accounts/{id}` call instead of full `/api/state` in drawers, dedupe `bams-configs`.

### Low
- PERF-9 `POST /api/bams/notifications/test` 760 ms here (`notify.py:248` `time.sleep(0.75)` plus PowerShell run, `notify.py:203`) on a request thread; on Windows several seconds. Manual button only.
- PERF-10 `async def` endpoints do blocking file I/O on the event loop: `portability/routes.py:47-52` (`path.open`, `fh.write` per chunk during DB upload). Upload-only; other async routes correctly use `run_in_threadpool` (`app.py:470`, `bams/routes.py:156`, `portability/routes.py:77`). All other handlers are sync `def` (threadpool).
- PERF-11 Logging to `stderr` of a visible console (`logsetup.py:70`): a Windows console in QuickEdit/selection mode blocks the writing thread. Request threads write on every 4xx (`app.py:283`) and in DEBUG on every request (`app.py:261`). Cannot be tested on macOS.
- PERF-12 `open_db` per request runs 4 PRAGMAs (incl. `journal_mode=WAL`) plus a `sqlite_master` and `app_meta` read (`dbkit.py:48-68`, `migrate.py:73-82`); `/api/health` = 2.1 ms here, likely more with Windows AV. Bams reads open 1 connection; `make_ctx` + `monitor_block` share it.
- PERF-13 `audit/export?format=xlsx` 2.3 s at 31 k rows (14-day retention keeps real size small); `export/excel` 0.55 s.
- PERF-14 Weekly backup runs on the app-start thread (`app.py:210-216`): 14 s for 1.09 GB while the first page loads (measured `bams/state` 222 ms during it vs 4 ms idle). Same cause as PERF-3.

## Static audit: blocking calls by path (file:line)
- Sockets: `bams/provider.py:109-113` (probe; request path via `availability()` at `:138-148`; callers `app.py:331,449`, `bams/monitor.py:41,46,111,379`, `bams/service.py:39`). `environment()` (`provider.py:~126`, would probe) has no route caller. `__main__.py:12-16` startup bind check only.
- blpapi session calls: `provider.py:~150-200` (`_open`, `_request`, `fetch`), only from the monitor thread (`monitor.py:145`). Not on any request thread.
- subprocess: `bams/notify.py:203` (queued worker thread for alerts; synchronous only in `notification_test`, `bams/service.py:819-832`).
- Disk/dir scans: `backups.py:90,99,131` (`iterdir` on `GET /api/data/backups`, prune after each backup, weekly check), `logsetup.py:127` (zip download, weekly cleanup), `logs/recent` reads the last 1 MiB (`logsetup.py:94-104`, 0.6 ms). `shutil.disk_usage` only in DB restore (`dbrestore.py:265`). No update check exists.
- Integrity: `migrate.py:119-132` per backup; `dbrestore.py:173` restore only. No per-request migration or integrity check.
- Locks: `provider._lock` held across the Bloomberg request (<=30 s per batch) and `monitor._poll_lock` across a poll; neither is taken by a read route. `Gate` condition (`dbrestore.py:50-89`) is held only briefly. The SQLite write lock is held across the daily prune (PERF-1).
- N+1 / repeated work: `rule_row` per alert item (`bams/reads.py:422`); `ops/repo.py:68-71` one query per object id (<=500); `config_matches` per config in `configs_list` (`bams/reads.py:~487`, 2.5 ms now); `availability()` called 4x per `/api/bams/state` (`make_ctx`, `monitor_block`->`info`->`state`, `provider_info`, `banner`) and 1x per `/api/state`, now cached.

## Diff vs baseline zip (0.1.0-rc6 workstation build)
- `server/app.py`, `bams/monitor.py`, `bams/notify.py`: **identical**. The baseline already called `availability()` once in `/api/state` and 4x in `/api/bams/state`, with the uncached probe (`PROBE_TIMEOUT_S` 1.0 s). So the 2 s / 8 s numbers are not a server regression introduced by rc4; with the Terminal off the baseline would show the same. If the user did not see it before, the likely difference is the Terminal state or DEV vs PROD, not a code change. I cannot prove which from the repo.
- Added per-request work in current code: `infra.py:10,198,210` `upgrades_30d` in `/api/state` and client infrastructure (measured 0.6 ms with 3 quarters x 27 appliances; scales with quarters x appliances); `reads.py` `richtext.public` per note and `_note_matches` (negligible, activity 2.5 ms); `bams/reads.py` `trend(from,to)` zoom endpoint (new route, 7-day cap, 2,000-point cap, one range scan).
- Removed per-request work: `spark()` N+1 (24 queries per row) replaced by `spark_many` (one statement per 300 metrics): net faster.
- Frontend: both bundles poll at 15 s (`15e3` constants present in baseline `index-I2MVC1x9.js` and current); the module-level cache (`lib/queryCache.ts`) is stale-while-revalidate and does not reduce requests. No new polling was added; new fan-out sources are the ones in PERF-8 (`keepPrevious` search re-queries, `bams-configs` duplicate).

## What I could not verify (needs Windows / Bloomberg)
- Real connect-refused latency on Windows loopback (assumed >= 1 s per address because the user's log shows ~2 s for two addresses).
- Real `blpapi` `Session.start()` / `nextEvent` blocking behaviour and how long a real Terminal-down poll holds the monitor thread.
- Windows antivirus cost on creating/reading 1 GB backup files, `os.replace`, and WAL checkpoints; PowerShell notification timing; console QuickEdit stalls.
- The user's real DB size and sample count (drives PERF-1/2/3 severity; with the Terminal mostly off they may be Medium).
- Browser rendering cost of the 1.3 MB `/api/state` JSON on the workstation; server-side it is 24 ms.
