-- =============================================================================
-- 0003: persistent BAMS metric alert policies.
-- A configuration applied to all matching metrics becomes an auto-apply policy.
-- Each managed rule records its source config so edits can be synchronized safely.
-- =============================================================================
ALTER TABLE bams_alert_configs
    ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply IN (0,1));

ALTER TABLE bams_alert_rules
    ADD COLUMN config_id TEXT REFERENCES bams_alert_configs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bams_alert_rules_config_metric
    ON bams_alert_rules (config_id, metric_id) WHERE config_id IS NOT NULL;

INSERT INTO app_meta (key, value) VALUES ('schema_version', '3')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_meta.value AS INTEGER) < 3;
