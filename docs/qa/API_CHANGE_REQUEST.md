# API change requests

Raised by the frontend-dev-agent against `docs/04_API_CONTRACT.md` (frozen for run 1). Every item is **additive and non-blocking**: the frontend works today without any of them (verified against the live DEV backend). Owner: backend-dev-agent. Status values: `open`, `accepted`, `done`, `declined`.

| ID | Sev | Status | Request | Why / current workaround |
|---|---|---|---|---|
| FE-AC-1 | Low | open | Add `GET /api/note/{id}` returning one **Note** (same shape as §3) and 404 `not_found` if missing. | `?note=<id>` deep links open the note editor. The frontend currently pages `GET /api/client/{id}/activity?filter=all&limit=100` (up to 12 pages) until it finds the note. Fine at hundreds of notes, wasteful beyond that. |
| FE-AC-2 | Low | open | On activity entries with `kind: "note"`, add `client_id` and `created_at`. | The shared `Note` type needs both. The adapter fills `client_id` from the request path and uses `ts` for `created_at`. |
| FE-AC-3 | Low | open | Add `server_name` (string or null) to activity `kind: "system"` entries and to `recent_changes` rows: the BAMS object name for `bams_alert.*`, the server name for `server_upgrade.*`, else null. | Used as the `?server=` deep-link target to the Infrastructure tab. The adapter currently derives it from `label` (`"<server> · <metric>"` split on ` · ` for alerts, the label itself for upgrades), which breaks if a server name ever contains ` · `. |
| FE-AC-4 | Low | open | Add `next_upgrade: {"date", "server"} \| null` to each `infrastructure[client_id]` entry in `GET /api/state` (and to the per-account infrastructure response). | The Account context rail shows "next upgrade (date and server)". The adapter computes it from `server_upgrades` (min `scheduled_date >= today`, status not Completed/Deferred), which duplicates the rule from `account_summary.sql`. |

No change is requested to any frozen field, route or error code.
