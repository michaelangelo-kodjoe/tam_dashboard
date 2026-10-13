-- =============================================================================
-- Per-account derived counts: Accounts directory (US-4.1), Today Account Load
-- (US-3.4, caller takes the first 8 Active rows), and the workspace header
-- (US-5.1). Definitions from 01_PM_SPEC §3.2. Reference query.
-- Params: :today ('YYYY-MM-DD'), :status ('Active' | 'Inactive' | 'All')
-- =============================================================================
SELECT c.id, c.name, c.bpid, c.products, c.status, c.next_contact, c.last_contact,
       (SELECT count(*) FROM tasks t
         WHERE t.client_id = c.id AND t.archived = 0 AND t.status <> 'Complete')                       AS open_tasks,
       (SELECT count(*) FROM tasks t
         WHERE t.client_id = c.id AND t.archived = 0 AND t.status <> 'Complete' AND t.due < :today)    AS overdue,
       (SELECT count(*) FROM tasks t
         WHERE t.client_id = c.id AND t.archived = 0 AND t.status = 'Waiting')                         AS waiting,
       (SELECT count(*) FROM bams_alert_events e
          JOIN bams_metrics m ON m.id = e.metric_id
          JOIN bams_objects o ON o.id = m.object_id
         WHERE o.client_id = c.id AND e.status IN ('open','recovered')
           AND o.enabled = 1 AND m.enabled = 1)                                AS active_alerts,
       (SELECT min(u.scheduled_date) FROM server_upgrades u
         WHERE u.client_id = c.id AND u.scheduled_date >= :today
           AND u.status NOT IN ('Completed','Deferred'))                                               AS next_upgrade,
       (SELECT count(*) FROM server_upgrades u
         WHERE u.client_id = c.id AND u.scheduled_date >= :today
           AND u.status NOT IN ('Completed','Deferred'))                                               AS upcoming_upgrades,
       -- US-5.1 AC1: distinct server/appliance names, case-insensitive and trimmed, across both sources
       (SELECT count(DISTINCT lower(trim(s))) FROM (
            SELECT name AS s FROM bams_objects WHERE client_id = c.id
            UNION ALL SELECT server_name FROM server_upgrades WHERE client_id = c.id))                 AS servers
FROM clients c
WHERE :status = 'All' OR c.status = :status
ORDER BY overdue DESC, open_tasks DESC, c.name;
