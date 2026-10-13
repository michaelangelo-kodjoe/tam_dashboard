-- =============================================================================
-- BAMS metric freshness (§27 bands; US-9.1 "worst metric status"). Reference query.
--
-- Params:
--   :wall_now          current UTC instant ('YYYY-MM-DDTHH:MM:SS.sssZ')
--   :provider_running  1 if a BAMS provider (BLPAPI or DEV simulator) is
--                      polling in this process, else 0
--   :channel           'dev' | 'prod' (the running mode). The mock clock is
--                      honoured ONLY in 'dev' (QA-3-3); PROD always uses the
--                      wall clock, and additionally refuses to open a DB that
--                      carries bams.mock_clock (migrate.assert_channel).
--
-- FROZEN MOCK CLOCK RULE (QA-1-5, binding): while app_meta['bams.mock_clock']
-- exists (it is written only by the DEV mock seed) AND the channel is 'dev'
-- AND no provider is running,
-- ages are measured against that frozen instant, NOT the wall clock. Seeded
-- Live / Delayed / Stale / No Data states therefore stay put for the life of the
-- DEV DB. Once a provider runs, the wall clock applies. PROD can never carry
-- the key, because a mock-seeded DB is refused in PROD.
--
-- Bands: Live age <= 75 s; Delayed 75 < age <= stale_after_seconds (default
-- 120); Stale above that; No Data = never received; Disabled = object or
-- metric disabled (not monitored, so excluded from the worst-status roll-up).
-- Worst-status roll-up order for an object: Stale > No Data > Delayed > Live.
-- =============================================================================
WITH clock AS (
    SELECT CASE WHEN :channel = 'dev' AND :provider_running = 0
                 AND (SELECT value FROM app_meta WHERE key = 'bams.mock_clock') IS NOT NULL
                THEN (SELECT value FROM app_meta WHERE key = 'bams.mock_clock')
                ELSE :wall_now END AS now_ts
),
ages AS (
    SELECT m.id AS metric_id, m.object_id, o.client_id, o.name AS object_name, m.metric_name,
           m.current_value, m.last_received, m.stale_after_seconds,
           (o.enabled = 1 AND m.enabled = 1) AS monitored,
           CASE WHEN m.last_received IS NULL THEN NULL
                ELSE (julianday(substr(clock.now_ts, 1, 23)) - julianday(substr(m.last_received, 1, 23))) * 86400.0
           END AS age_s,
           clock.now_ts
    FROM bams_metrics m
    JOIN bams_objects o ON o.id = m.object_id
    CROSS JOIN clock
)
SELECT metric_id, object_id, client_id, object_name, metric_name, current_value, last_received,
       now_ts AS freshness_clock, age_s,
       CASE WHEN NOT monitored              THEN 'Disabled'
            WHEN last_received IS NULL      THEN 'No Data'
            WHEN age_s <= 75                THEN 'Live'
            WHEN age_s <= stale_after_seconds THEN 'Delayed'
            ELSE 'Stale' END AS freshness
FROM ages
ORDER BY client_id, object_name, metric_name;
