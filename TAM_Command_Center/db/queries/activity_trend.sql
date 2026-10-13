-- =============================================================================
-- Accounts "Activity trend" sparkline (D-31, 01_PM_SPEC section 10.4 #18): 14 daily points per account.
-- Reference query; owner data-architect-agent. Served by GET /api/accounts/activity-trend (PM-AC-2).
--
-- A point = the number of Activity-timeline entries (D-03) for that account on that LOCAL day. The
-- entry set is exactly the union in activity_timeline.sql (manual notes + the listed system events
-- from audit_events + BAMS alert opened/recovered/closed), with no filter and no search. Deleted notes
-- and deleted BAMS objects are gone from the union exactly as they are in Activity (their audit
-- 'deleted' rows, where the timeline lists them, still count).
--
-- Params (15 UTC instants, YYYY-MM-DDTHH:MM:SS.mmmZ; the backend converts each LOCAL midnight to UTC
-- separately, so 23h/25h DST days are exact; every day is the half-open window [b_i, b_i+1)):
--   :today             'YYYY-MM-DD' local date; day 13 is :today, day 0 is :today - 13 days
--   :b0 .. :b14        local midnight of (:today - 13 days) ... local midnight of (:today + 1 day)
--   :include_inactive  0 (default: Active accounts only) or 1
--
-- Result: one row per (account, day), 14 rows per account, zeros included:
--   client_id, client_name, day_index (0..13, oldest first), day ('YYYY-MM-DD'), n
-- Order: client_name, day_index. The backend folds the rows into {client_id: [14 ints]}.
-- Index use (confirmed with EXPLAIN QUERY PLAN, see 03_DATA_MODEL): notes -> ix_notes_client_ts and
-- audit_events -> ix_audit_client_ts, each searched per account with the 14-day timestamp range; BAMS
-- events are reached through bams_objects/bams_metrics (ix_bams_alert_events_metric) and are few per metric.
-- No JSON1 functions.
-- =============================================================================
WITH buckets(day_index, lo, hi) AS (
    VALUES ( 0, :b0,  :b1),  ( 1, :b1,  :b2),  ( 2, :b2,  :b3),  ( 3, :b3,  :b4),
           ( 4, :b4,  :b5),  ( 5, :b5,  :b6),  ( 6, :b6,  :b7),  ( 7, :b7,  :b8),
           ( 8, :b8,  :b9),  ( 9, :b9,  :b10), (10, :b10, :b11), (11, :b11, :b12),
           (12, :b12, :b13), (13, :b13, :b14)
),
sel AS (
    SELECT c.id, c.name FROM clients c WHERE :include_inactive = 1 OR c.status = 'Active'
),
entries AS (
    SELECT s.id AS client_id, n.timestamp AS ts
    FROM sel s
    CROSS JOIN notes n INDEXED BY ix_notes_client_ts ON n.client_id = s.id AND n.timestamp >= :b0 AND n.timestamp < :b14

    UNION ALL

    SELECT s.id, a.timestamp
    FROM sel s
    CROSS JOIN audit_events a INDEXED BY ix_audit_client_ts ON a.client_id = s.id AND a.timestamp >= :b0 AND a.timestamp < :b14
    WHERE (   (a.object_type = 'task'    AND a.action IN ('created','completed','reopened','archived','deleted'))
           OR (a.object_type = 'contact' AND a.action IN ('created','updated','deleted','primary_changed'))
           OR (a.object_type = 'note'    AND a.action = 'deleted')
           OR (a.object_type = 'client'  AND a.action IN ('next_contact_changed','status_changed'))
           OR  a.object_type = 'server_upgrade')

    UNION ALL

    SELECT s.id,
           CASE w.what WHEN 'opened' THEN e.opened_at WHEN 'recovered' THEN e.recovered_at ELSE e.closed_at END
    FROM sel s
    JOIN bams_objects o ON o.client_id = s.id
    JOIN bams_metrics m ON m.object_id = o.id
    JOIN bams_alert_events e ON e.metric_id = m.id
    JOIN (SELECT 'opened' AS what UNION ALL SELECT 'recovered' UNION ALL SELECT 'closed') w
      ON (w.what = 'opened') OR (w.what = 'recovered' AND e.recovered_at IS NOT NULL)
                             OR (w.what = 'closed' AND e.closed_at IS NOT NULL)
)
SELECT s.id AS client_id, s.name AS client_name, b.day_index,
       date(:today, printf('%+d day', b.day_index - 13)) AS day,
       count(e.ts) AS n
FROM sel s
CROSS JOIN buckets b
LEFT JOIN entries e ON e.client_id = s.id AND e.ts >= b.lo AND e.ts < b.hi
GROUP BY s.id, b.day_index
ORDER BY s.name, b.day_index;
