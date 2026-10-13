-- =============================================================================
-- Account Activity timeline (US-7.1/7.2, D-03): manual notes UNION read-only
-- system events derived from audit_events and bams_alert_events.
-- Reference query; owner data-architect-agent.
--
-- Params:
--   :client_id
--   :filter      'all' | 'meeting' | 'call' | 'general' | 'system'
--   :q_like      NULL, or a LIKE pattern built by the backend: '%' || escaped(q) || '%'
--                (escape \ % _ with '\'; the pattern uses ESCAPE '\')
--   :before_ts   NULL for the first page, else the last row's ts      (keyset cursor)
--   :before_key  NULL for the first page, else the last row's entry_key
--   :limit       page size (default 50, max 100)
--
-- Ordering is (ts DESC, entry_key DESC); entry_key is unique across sources,
-- so the cursor is stable even when two entries share a timestamp.
-- No JSON1 functions are used (portability; see schema.sql header).
-- System-event selection (01_PM_SPEC §3.2):
--   task: created, completed, reopened, archived, deleted
--   contact: created, updated, deleted, primary_changed
--   note: deleted            (note create/edit is the note itself)
--   client: next_contact_changed, status_changed
--   server_upgrade: any action
--   bams_alert_events: opened_at, recovered_at, closed_at -> one entry each
-- =============================================================================
WITH entries AS (
    SELECT n.timestamp AS ts, 'n:' || n.id AS entry_key, 'note' AS entry_kind,
           n.note_type AS event_type, 'note' AS object_type, n.id AS object_id,
           n.subject, n.body, n.action_items, n.source,
           NULL AS old_value, NULL AS new_value, NULL AS severity, NULL AS alert_status,
           n.updated_at
    FROM notes n
    WHERE n.client_id = :client_id
      AND (:filter = 'all'
           OR (:filter = 'meeting' AND n.note_type = 'Meeting Note')
           OR (:filter = 'call'    AND n.note_type = 'Call Note')
           OR (:filter = 'general' AND n.note_type = 'General Note'))
      AND (:q_like IS NULL OR n.subject LIKE :q_like ESCAPE '\' OR n.body LIKE :q_like ESCAPE '\'
           OR n.action_items LIKE :q_like ESCAPE '\')

    UNION ALL

    SELECT a.timestamp, 'a:' || printf('%012d', a.id), 'system',
           a.object_type || '.' || a.action, a.object_type, a.object_id,
           a.object_label, NULL, NULL, a.source, a.old_value, a.new_value, NULL, NULL, NULL
    FROM audit_events a
    WHERE a.client_id = :client_id
      AND :filter IN ('all','system')
      AND (   (a.object_type = 'task'    AND a.action IN ('created','completed','reopened','archived','deleted'))
           OR (a.object_type = 'contact' AND a.action IN ('created','updated','deleted','primary_changed'))
           OR (a.object_type = 'note'    AND a.action = 'deleted')
           OR (a.object_type = 'client'  AND a.action IN ('next_contact_changed','status_changed'))
           OR  a.object_type = 'server_upgrade')
      AND (:q_like IS NULL OR a.object_label LIKE :q_like ESCAPE '\'
           OR a.old_value LIKE :q_like ESCAPE '\' OR a.new_value LIKE :q_like ESCAPE '\')

    UNION ALL

    SELECT CASE w.what WHEN 'opened' THEN e.opened_at WHEN 'recovered' THEN e.recovered_at ELSE e.closed_at END,
           'b:' || e.id || ':' || w.what, 'system',
           'bams_alert.' || w.what, 'bams_alert_event', e.id,
           o.name || ' · ' || m.metric_name, e.message, e.closed_note, 'System',
           NULL, NULL, e.severity, e.status, NULL
    FROM bams_alert_events e
    JOIN bams_metrics m ON m.id = e.metric_id
    JOIN bams_objects o ON o.id = m.object_id AND o.client_id = :client_id
    JOIN (SELECT 'opened' AS what UNION ALL SELECT 'recovered' UNION ALL SELECT 'closed') w
      ON (w.what = 'opened') OR (w.what = 'recovered' AND e.recovered_at IS NOT NULL)
                             OR (w.what = 'closed' AND e.closed_at IS NOT NULL)
    WHERE :filter IN ('all','system')
      AND (:q_like IS NULL OR e.message LIKE :q_like ESCAPE '\' OR o.name LIKE :q_like ESCAPE '\')
)
SELECT *
FROM entries
WHERE :before_ts IS NULL
   OR ts < :before_ts
   OR (ts = :before_ts AND entry_key < :before_key)
ORDER BY ts DESC, entry_key DESC
LIMIT :limit;
