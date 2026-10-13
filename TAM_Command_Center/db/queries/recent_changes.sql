-- =============================================================================
-- Today "Recently Changed" (US-3.3): latest :limit (20) account-level changes.
-- Includes note created, task completed, upgrade changes, contact changes and
-- BAMS opened/recovered/closed. Excludes settings and backup events (they have
-- client_id NULL and category settings/data). Reference query.
-- Params: :limit
-- =============================================================================
-- Each branch is ordered + LIMITed on its own so the audit branch walks
-- ix_audit_ts newest-first and stops early instead of sorting the whole
-- (unbounded) audit table on every Today refresh.
-- NOTE: INDEXED BY makes a rename/drop of ix_audit_ts a hard query error
-- (deliberate: fail loudly rather than silently degrade to a full sort).
WITH audit_part AS (
    SELECT * FROM (
        SELECT a.timestamp AS ts, 'a:' || printf('%012d', a.id) AS entry_key, a.client_id,
               a.object_type, a.object_id, a.object_label, a.action, a.old_value, a.new_value,
               NULL AS severity, NULL AS server_name, NULL AS metric_name
        FROM audit_events a INDEXED BY ix_audit_ts
        WHERE a.client_id IS NOT NULL
          AND a.category NOT IN ('settings','data')
          AND (   (a.object_type = 'note'    AND a.action IN ('created','deleted'))
               OR (a.object_type = 'task'    AND a.action IN ('created','completed','reopened','archived','deleted'))
               OR (a.object_type = 'contact' AND a.action IN ('created','updated','deleted','primary_changed'))
               OR (a.object_type = 'client'  AND a.action IN ('next_contact_changed','status_changed'))
               OR  a.object_type = 'server_upgrade')
        ORDER BY a.timestamp DESC, a.id DESC
        LIMIT :limit)
),
bams_part AS (
    SELECT * FROM (
        SELECT x.ts, 'b:' || x.id || ':' || x.what AS entry_key, o.client_id, 'bams_alert_event' AS object_type,
               x.id AS object_id, o.name || ' · ' || m.metric_name AS object_label, x.what AS action,
               NULL AS old_value, NULL AS new_value, x.severity, o.name AS server_name, m.metric_name
        FROM (SELECT id, metric_id, severity, opened_at AS ts, 'opened' AS what FROM bams_alert_events
              UNION ALL SELECT id, metric_id, severity, recovered_at, 'recovered' FROM bams_alert_events WHERE recovered_at IS NOT NULL
              UNION ALL SELECT id, metric_id, severity, closed_at, 'closed' FROM bams_alert_events WHERE closed_at IS NOT NULL) x
        JOIN bams_metrics m ON m.id = x.metric_id
        JOIN bams_objects o ON o.id = m.object_id
        ORDER BY x.ts DESC, x.id DESC, x.what DESC   -- full tie-break: deterministic top-N (QA-2-7)
        LIMIT :limit)
),
changes AS (SELECT * FROM audit_part UNION ALL SELECT * FROM bams_part)
SELECT ch.*, c.name AS client_name
FROM changes ch
LEFT JOIN clients c ON c.id = ch.client_id      -- LEFT: the account may have been deleted (D-12)
ORDER BY ch.ts DESC, ch.entry_key DESC
LIMIT :limit;
