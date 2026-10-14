# API change requests

Raised by the frontend-dev-agent against `docs/04_API_CONTRACT.md` (frozen for run 1). Every item is **additive and non-blocking**: the frontend works today without any of them (verified against the live DEV backend). Owner: backend-dev-agent. Status values: `open`, `accepted`, `done`, `declined`.

| ID | Sev | Status | Request | Why / current workaround |
|---|---|---|---|---|
| FE-AC-1 | Low | done (2026-10-12) | Add `GET /api/note/{id}` returning one **Note** (same shape as §3) and 404 `not_found` if missing. | `?note=<id>` deep links open the note editor. The frontend currently pages `GET /api/client/{id}/activity?filter=all&limit=100` (up to 12 pages) until it finds the note. Fine at hundreds of notes, wasteful beyond that. |
| FE-AC-2 | Low | done (2026-10-12) | On activity entries with `kind: "note"`, add `client_id` and `created_at`. | The shared `Note` type needs both. The adapter fills `client_id` from the request path and uses `ts` for `created_at`. |
| FE-AC-3 | Low | done (2026-10-12) | Add `server_name` (string or null) to activity `kind: "system"` entries and to `recent_changes` rows: the BAMS object name for `bams_alert.*`, the server name for `server_upgrade.*`, else null. | Used as the `?server=` deep-link target to the Infrastructure tab. The adapter currently derives it from `label` (`"<server> · <metric>"` split on ` · ` for alerts, the label itself for upgrades), which breaks if a server name ever contains ` · `. |
| FE-AC-4 | Low | done (2026-10-12) | Add `next_upgrade: {"date", "server"} \| null` to each `infrastructure[client_id]` entry in `GET /api/state` (and to the per-account infrastructure response). | The Account context rail shows "next upgrade (date and server)". The adapter computes it from `server_upgrades` (min `scheduled_date >= today`, status not Completed/Deferred), which duplicates the rule from `account_summary.sql`. |

No change is requested to any frozen field, route or error code.

## Run 2 (raised by pm-agent, 2026-10-13; D-26 to D-36, `docs/01_PM_SPEC.md` §10)
All additive; no frozen field, route or error code changes; **no schema change**. Owner: backend-dev-agent (tasks T-62 to T-64). The frontend `MockDataSource` mirrors each (T-72).

| ID | Sev | Status | Request | Why |
|---|---|---|---|---|
| PM-AC-1 | Medium | done (2026-10-13) | `GET /api/today` adds `progress: {day, total, done, open, done_other}` per PM §10.2 (tasks with `due <= today`, Active or no account; done = status Complete now and a `task`/`completed` audit row inside the local-day window; open = not Complete and not archived; `total = done + open`). Day window = local midnights of `today` and `today+1` converted to UTC separately (DST-safe). Reference query `db/queries/day_progress.sql` (DA, T-61). | "Done today N of M" ring (D-29). |
| PM-AC-2 | Low | done (2026-10-13) | New `GET /api/accounts/activity-trend?days=14` returning `{ok, today, days, series: {client_id: [int x days, oldest first]}}` for Active accounts: Activity-timeline entries (same union as `activity_timeline.sql`) per local day. | Accounts table activity sparkline (D-31); keeps `/api/state` light (§42). |
| PM-AC-3 | Low | done (2026-10-13) | `GET /api/client/{id}/infrastructure` adds `servers: [{name, environment, version, alert_severity, spark}]` per distinct server name; `spark = {metric, window_hours, points: [[iso_utc, value] x <= 28]}` or `null` (metric: highest-severity open alert, else a "cpu" metric, else null; window = min(7 days, available)). Reads only the window from `bams_metric_samples` (§45). | Server tiles with sparklines (D-31). |

`GET /api/today` `queue` order and item shape are unchanged.

Backend notes (2026-10-13, T-62 to T-64; shapes frozen in `docs/04_API_CONTRACT.md` §9):
- PM-AC-1: as requested, `progress` on `GET /api/today`, via `day_progress.sql` unmodified; window from two separately converted local midnights (`server/localtime.py`).
- PM-AC-2: as requested, via `activity_trend.sql` unmodified. `days` accepts only `14` (the reference query is fixed at 14 buckets; other values -> 422). Extra optional `include_inactive=true`.
- PM-AC-3 **deviation**: the array is `server_tiles`, not `servers`, because `servers` is a frozen integer on that payload. Present on the per-account endpoint only (not in `/api/state`).


## Run 3 (raised by pm-agent, 2026-10-13; D-37 to D-48, `docs/01_PM_SPEC.md` §11)
Account bulk import and duplicate check. Proposal text is in `docs/04_API_CONTRACT.md` §10 ("proposed by PM, finalized by backend"). **No schema change.** Owner: backend-dev-agent (tasks T-80 to T-86). The frontend `MockDataSource` mirrors the check (T-87).

| ID | Sev | Status | Request | Why |
|---|---|---|---|---|
| PM-AC-4 | Medium | open | **Behaviour change of a frozen route:** `POST /api/client/save` (create) returns 409 `possible_duplicate` (with candidates) when the shared similarity engine finds candidates, unless the body has the new optional `duplicates_confirmed: true`. Existing tests send the flag. | D-45: one duplicate rule for single add and import; a bypassed UI cannot create a near-duplicate. |
| PM-AC-5 | Medium | open | New `POST /api/client/check-similar` `{name, bpid?}` -> `{exact, candidates[]}`. | Add account dialog (mockup 06). |
| PM-AC-6 | Medium | open | New `GET /api/import/accounts/template` (xlsx, generated with openpyxl). Non-JSON response. | US-13.1. |
| PM-AC-7 | High | open | New `POST /api/import/accounts/inspect` (raw xlsx body, 5 MiB route cap instead of 2 MiB), `GET /api/import/accounts/{id}`, `POST /api/import/accounts/apply`, `GET /api/import/accounts/{id}/skipped.xlsx`. Replace the 501 stub for these paths only. | D-38, D-39, D-44, D-46. |
| PM-AC-8 | Low | open | Additive error codes `invalid_file`, `import_expired` (410), `unresolved_duplicates`, `preview_stale`, `already_applied`, `possible_duplicate`; `payload_too_large` for the import route uses the 5 MiB cap. | §10 of the contract. |
| PM-AC-9 | Low | open | Backup reason `pre-import` added to the automatic reasons (retention as D-22); audit `source='Bulk Import'` rows for `client` `created`/`updated`; `openpyxl` (pinned) joins `server/requirements.txt`; activity sentences for Bulk Import events. | D-37, D-39. |
