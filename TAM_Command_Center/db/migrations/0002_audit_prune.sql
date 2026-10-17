-- =============================================================================
-- 0002: audit_events can be PRUNED, but only rows older than 14 days.
-- User decision 2026-10-16 (overrides the "deletes are always refused" rule for OLD rows only):
--   * UPDATE stays forbidden (trg_audit_events_no_update unchanged).
--   * Re-using an id stays refused (trg_audit_events_no_replace unchanged; ids are AUTOINCREMENT, so a deleted
--     id is never handed out again).
--   * DELETE is refused when the row is newer than 14 days, so no code path (a bug, a rogue query, an import)
--     can remove recent history; only rows past the retention window can go. The prune job runs every 14 days
--     (server/auditprune.py). The guard keeps its name so migrate.assert_guards() and purge_audit_events()
--     (DEV reseed) work unchanged.
-- Runs inside the runner's transaction (DDL is transactional): a failure leaves the database at version 1.
-- =============================================================================
DROP TRIGGER IF EXISTS trg_audit_events_no_delete;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN OLD.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
BEGIN
    SELECT RAISE(ABORT, 'audit_events rows newer than 14 days cannot be deleted');
END;

INSERT INTO app_meta (key, value) VALUES ('schema_version', '2')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_meta.value AS INTEGER) < 2;
