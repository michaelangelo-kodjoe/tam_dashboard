# BAMS tab-switch lag (about 1 s): diagnosis (TASK B-1, read-only)

Measured against the dev server on localhost:8767 (zip build, simulated provider, 103 metrics, 92 enabled rows, 58,421 samples). curl wall times, 3 runs:

| Endpoint | Time | Size |
|---|---|---|
| GET /api/bams/state (default, spark=1) | 25-27 ms (first call 53 ms) | 86.6 KB |
| GET /api/bams/state?spark=0 | 6 ms | 81 KB |
| /api/bams/alerts, /monitor, /settings, /configs, /notifications, /metrics/catalog | 3-5 ms each | under 13 KB |
| /api/state (app shell) | 8 ms | 154 KB |
| trend 7d / 30d | 5 ms / 4 ms | 3.6 / 9.4 KB |
| sync_auto_policies (measured on a DB copy, 3 policies, 72 matches) | 1.0-1.3 ms steady, 2.5 ms with none | n/a |

Conclusion: the backend is not the 1 s. At mock scale a tab switch costs about 30 ms server time. The lag is client-side (plus a server cost that scales badly with real metric counts, see 2).

## Ranked causes

1. **No cross-navigation cache: every visit to BAMS starts from "no data" and renders everything.**
   Evidence: `useQuery` (`frontend/src/store/DataContext.tsx` ~lines 55-90) keeps its state in a component-local `useState`; on remount `cur` is `{data:null, loading:true}`, so `DashboardPage` shows `SkeletonRows`, fires `getBamsState`, then renders the whole grouped `DataTable` (one row per metric, each with an SVG sparkline, up to `ROW_CAP=2000` rows, no virtualization, no pagination) in one commit. It then refetches every 15 s (`REFRESH_MS`) and re-renders all rows again. Each visit = skeleton flash + network + big synchronous React render. The 566 KB bundle is already loaded (no route-level `lazy` except `TrendChart` inside `MetricDrawer`, so there is no chunk-download cost on tab switch).
   Fix: (a) module-level query cache in `DataContext.tsx` (key -> last data) so `useQuery` seeds `st` from cache and shows stale data instantly while revalidating (stale-while-revalidate); (b) in `DashboardPage.tsx` memoize `rows`/group computation (`useMemo` on `q.data`) and wrap the row cell renderers/`Spark` in `React.memo`; (c) render collapsed groups lazily (do not mount rows of collapsed groups; see `bamsGroups.ts`); (d) if rows are large, window/virtualize or cap initial rows at about 200 with "show more".

2. **N+1 sparkline queries in /api/bams/state (scales linearly with metrics).**
   Evidence: `server/bams/reads.py` `spark()` issues 24 queries per row (`repo.spark_points`, one `SELECT ... ORDER BY sampled_at DESC LIMIT 1` per hour bucket), called for every row from `build_state` (spark defaults to 1). Measured: spark=0 is 6 ms vs 27 ms with spark; 92 rows x 24 = 2,208 queries cost 21 ms (0.23 ms per row), so 1,000 metrics is about 230 ms server + JSON, 2,000 (the cap) about 460 ms, plus the GIL/DB lock held while the monitor polls. This is the only part of the backend that scales badly, and it is where a real workstation (more appliances/metrics than the 92 mock rows) would see the extra latency.
   Fix: in `server/bams/reads.py` replace per-hour loops with one query per request: `SELECT metric_id, CAST((julianday(:now)-julianday(sampled_at))*24 AS INTEGER) AS b, value FROM bams_metric_samples WHERE sampled_at >= :lo AND sampled_at <= :now` using the existing `ix_bams_metric_samples_metric_ts`, keep last value per (metric,bucket) in Python (or `GROUP BY metric_id, b` with `max(sampled_at)` join). Keep payload semantics (last value in each hour). Alternatively have the frontend request `spark=0` first and fetch sparks in a second call so the table paints immediately (`ApiDataSource.ts` line 342 already supports `spark: false`).

3. **Duplicate/unscoped polling and payload churn.**
   Evidence: three independent pollers run while on BAMS: `app-state` (154 KB, AppShell), `bams-state` (87 KB, every 15 s), `bams-notifications` (BellInbox). The full 87 KB state including `filters.objects/metrics/accounts` is resent every 15 s although only values change, and every response replaces the `data` object, re-rendering all rows. Combined with cause 1 this makes each 15 s tick another full-table render.
   Fix: structural sharing in `useQuery` (`setSt` only when `JSON.stringify` differs or compare per-row `row_version`/`last_received`), split `filters` into a separately-cached query refreshed rarely, pause polling when `document.hidden`.

4. **Zip-build-only: injected `metric-alert-policies.js` MutationObserver on the whole document.**
   Evidence: `web/metric-alert-policies.js` lines 483-495 patch `history.pushState/replaceState` and observe `document.documentElement` with `{childList:true, subtree:true}`; every DOM mutation (including each of the many mutations when BAMS rows mount) schedules a requestAnimationFrame callback that calls `isConfigPage()` and, off the config page, `getElementById(...).remove()`. The callback is coalesced per frame so cost is small (sub-ms to a few ms), but it adds a frame callback per mutation burst. On `/bams/config` it additionally fetches `/bams/metrics/catalog` and `/bams/configs` and does `querySelectorAll(".page.bm-page")` + `textContent` scans of pages. Not the main cause; disappears when the policy UI is ported into React (see BACKPORT_GAP.md).

5. **Server-side sync_auto_policies on the monitor loop: not a cause.**
   `monitor._poll` calls it each cycle in its own write transaction. Measured 1-2.5 ms steady state (3 policies, 72 matched metrics); first sync with rule creation about 10 ms. Readers are not blocked in WAL mode. Possible future risk only if hundreds of policies x thousands of metrics (it runs `config_matches` plus per-metric `rules_for_metric` queries each poll): fix would be to run it only when metrics/configs changed (version counter), `server/bams/monitor.py` ~line 134. Low priority.

6. **Indexes.** `bams_metric_samples` has `(metric_id, sampled_at)`; alert events indexed by metric; no missing index found for state/trend/alerts. Trend queries are 4-5 ms at 58k samples. Real 7 days x many metrics is bounded by `MAX_POINTS=500` downsampling in `reads.trend`, so chart rendering is not an issue; chart is lazy and only mounted in the drawer.

## Not measured
Actual browser render time (no browser session). Cause 1 is by code reading; verify with React Profiler or `performance.measure` around the `DashboardPage` commit, and by testing a DB seeded with 1,000+ metrics to confirm the cause-2 scaling.
