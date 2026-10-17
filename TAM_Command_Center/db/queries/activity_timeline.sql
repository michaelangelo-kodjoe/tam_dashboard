-- =============================================================================
-- Account Activity timeline (US-7.1/7.2): manual notes ONLY (changed 2026-10-16 by
-- user request: system events from audit_events and bams_alert_events moved to the
-- Audit log, GET /api/audit; amends D-03). :filter 'system' now matches nothing.
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

)
SELECT *
FROM entries
WHERE :before_ts IS NULL
   OR ts < :before_ts
   OR (ts = :before_ts AND entry_key < :before_key)
ORDER BY ts DESC, entry_key DESC
LIMIT :limit;
