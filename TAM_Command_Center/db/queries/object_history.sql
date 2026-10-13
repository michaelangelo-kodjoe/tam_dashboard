-- =============================================================================
-- History of one object (task/contact/upgrade drawer "History", deleted-note
-- lookups). Reference query; uses ix_audit_object.
-- Params: :object_type, :object_id
-- =============================================================================
SELECT id, timestamp, client_id, object_label, action, old_value, new_value, reason, source
FROM audit_events
WHERE object_type = :object_type AND object_id = :object_id
ORDER BY timestamp, id;
