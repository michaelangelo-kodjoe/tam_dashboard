-- =============================================================================
-- Today work queue + Upcoming panel: reference implementation of
-- docs/01_PM_SPEC.md §3.1 (D-04, D-05). Owner: data-architect-agent.
--
-- Parameter: :today  local calendar date 'YYYY-MM-DD' computed by the backend (D-06).
-- Output:    one row per object. section = 'queue' (tier 1..6) or 'upcoming'.
--
-- "First qualifying tier only" is structural: each object kind is classified
-- by ONE CASE expression whose WHEN order is the tier order, so an object can
-- never appear twice, and anything in the queue is never in Upcoming.
--
-- Exclusions (§3.1): archived tasks, Complete tasks, Inactive accounts (tasks
-- with client_id NULL are kept), closed alerts, alerts on a disabled BAMS
-- object or metric, Completed upgrades whose validation is Passed / Not Required,
-- Deferred upgrades from the queue (D-24), D-23-suppressed client touches.
--
-- D-23 (one queue entry per follow-up obligation): an account whose
-- next_contact equals the due date of one of its open, non-archived
-- 'Client Follow-Up' tasks gets NO client_follow_up item (queue or Upcoming);
-- that task carries the context 'Next Client Touch' instead. Different dates
-- -> both items appear.
-- D-24: status 'Exception' is tier 5 at any date (a past one is already tier
-- 1); 'Deferred' never enters the queue (not even with validation Failed) but
-- appears in Upcoming when scheduled inside the +15..+30 window.
--
-- Horizon constants (D-05) are the literal day offsets below:
--   tier 5 upgrade window = +14, tier 6 = +1..+3, Upcoming tasks/touches = +4/+1..+14,
--   Upcoming upgrades = +15..+30.  Keep them in one backend module.
-- =============================================================================
WITH
p AS (
    SELECT date(:today)              AS t,
           date(:today, '+1 day')    AS t1,
           date(:today, '+3 day')    AS t3,
           date(:today, '+4 day')    AS t4,
           date(:today, '+14 day')   AS t14,
           date(:today, '+15 day')   AS t15,
           date(:today, '+30 day')   AS t30
),
-- ---------------------------------------------------------------- tasks
task_cls AS (
    SELECT tk.*, c.name AS client_name,
           CASE
               WHEN tk.due < p.t  THEN 1
               WHEN tk.due = p.t  THEN 2
               WHEN tk.status = 'Waiting' AND (tk.next_update IS NULL OR tk.next_update <= p.t) THEN 4
               WHEN tk.due BETWEEN p.t1 AND p.t3 THEN 6
           END AS tier,
           (tk.category = 'Client Follow-Up' AND tk.due IS NOT NULL
            AND tk.due = c.next_contact) AS is_touch_task,                 -- D-23
           CASE
               WHEN tk.due BETWEEN p.t4 AND p.t14 THEN 'due'
               WHEN tk.status = 'Waiting' AND tk.next_update > p.t AND tk.next_update <= p.t14 THEN 'next_update'
           END AS upcoming_kind
    FROM tasks tk
    CROSS JOIN p
    LEFT JOIN clients c ON c.id = tk.client_id
    WHERE tk.archived = 0
      AND tk.status <> 'Complete'
      AND (tk.client_id IS NULL OR c.status = 'Active')
),
task_items AS (
    SELECT 'task' AS kind, id, tier, client_id, client_name, 'Task' AS type_label,
           task AS title, status, priority, NULL AS severity,
           CASE WHEN tier = 4 THEN next_update
                WHEN tier IS NOT NULL THEN due
                WHEN upcoming_kind = 'due' THEN due
                ELSE next_update END AS item_date,
           CASE WHEN tier = 4 THEN 'next_update'
                WHEN tier IS NOT NULL THEN 'due'
                ELSE upcoming_kind END AS date_kind,
           CASE WHEN is_touch_task THEN 'Next Client Touch'                -- D-23
                WHEN status = 'Waiting' AND waiting IS NOT NULL THEN 'Waiting: ' || waiting END AS context,
           NULL AS server_name,
           upcoming_kind IS NOT NULL AS is_upcoming
    FROM task_cls
),
-- ---------------------------------------------------------------- client touches
touch_items AS (
    SELECT 'client_follow_up' AS kind, c.id,
           CASE WHEN c.next_contact <= p.t THEN 4 END AS tier,
           c.id AS client_id, c.name AS client_name, 'Client touch' AS type_label,
           'Next client touch' AS title, c.status, NULL AS priority, NULL AS severity,
           c.next_contact AS item_date, 'next_contact' AS date_kind,
           (SELECT 'With ' || ct.name FROM contacts ct
             WHERE ct.client_id = c.id AND ct.is_primary = 1) AS context,
           NULL AS server_name,
           (c.next_contact > p.t AND c.next_contact <= p.t14) AS is_upcoming
    FROM clients c CROSS JOIN p
    WHERE c.status = 'Active' AND c.next_contact IS NOT NULL
      AND NOT EXISTS (                                                      -- D-23 de-duplication
          SELECT 1 FROM tasks ft
           WHERE ft.client_id = c.id AND ft.archived = 0 AND ft.status <> 'Complete'
             AND ft.category = 'Client Follow-Up' AND ft.due = c.next_contact)
),
-- ---------------------------------------------------------------- BAMS alerts
alert_items AS (
    SELECT 'bams_alert' AS kind, e.id,
           CASE WHEN e.status = 'open' AND e.severity = 'Critical' THEN 1 ELSE 3 END AS tier,
           o.client_id, c.name AS client_name, 'BAMS alert' AS type_label,
           o.name || ' · ' || m.metric_name AS title, e.status, NULL AS priority, e.severity,
           e.opened_at AS item_date, 'opened' AS date_kind,
           e.message AS context, o.name AS server_name, 0 AS is_upcoming
    FROM bams_alert_events e
    JOIN bams_metrics m ON m.id = e.metric_id
    JOIN bams_objects o ON o.id = m.object_id
    JOIN clients c      ON c.id = o.client_id
    WHERE e.status IN ('open','recovered') AND c.status = 'Active'
      AND o.enabled = 1 AND m.enabled = 1      -- monitoring switched off => not actionable (QA-1-11c)
),
-- ---------------------------------------------------------------- server upgrades
upgrade_items AS (
    SELECT 'server_upgrade' AS kind, u.id,
           CASE
               WHEN u.scheduled_date < p.t AND u.status NOT IN ('Completed','Deferred') THEN 1
               WHEN u.status <> 'Deferred'                                  -- D-24: Deferred never queued
                AND (   (u.scheduled_date BETWEEN p.t AND p.t14 AND u.status <> 'Completed')
                     OR u.status IN ('Validation Required', 'Exception')    -- D-24: Exception at any date
                     OR u.validation_status = 'Failed'
                     OR (u.status = 'Completed' AND u.validation_status = 'Pending')) THEN 5
           END AS tier,
           u.client_id, c.name AS client_name, 'Server upgrade' AS type_label,
           u.server_name || ' ' || coalesce(u.current_version, '?') || ' → ' || coalesce(u.target_version, '?') AS title,
           u.status, NULL AS priority, NULL AS severity,
           u.scheduled_date AS item_date, 'scheduled' AS date_kind,
           u.environment || ' ' || u.polarity || ' · validation ' || u.validation_status
               || coalesce(' · waiting on ' || u.waiting_on, '') AS context,
           u.server_name,
           (u.scheduled_date BETWEEN p.t15 AND p.t30 AND u.status <> 'Completed') AS is_upcoming,  -- D-24: Deferred shown here
           u.validation_status
    FROM server_upgrades u
    CROSS JOIN p
    JOIN clients c ON c.id = u.client_id
    WHERE c.status = 'Active'
      AND NOT (u.status = 'Completed' AND u.validation_status IN ('Passed','Not Required'))
),
all_items AS (
    SELECT kind, id, tier, client_id, client_name, type_label, title, status, priority, severity,
           item_date, date_kind, context, server_name, is_upcoming, NULL AS validation_status FROM task_items
    UNION ALL
    SELECT kind, id, tier, client_id, client_name, type_label, title, status, priority, severity,
           item_date, date_kind, context, server_name, is_upcoming, NULL FROM touch_items
    UNION ALL
    SELECT kind, id, tier, client_id, client_name, type_label, title, status, priority, severity,
           item_date, date_kind, context, server_name, is_upcoming, NULL FROM alert_items
    UNION ALL
    SELECT kind, id, tier, client_id, client_name, type_label, title, status, priority, severity,
           item_date, date_kind, context, server_name, is_upcoming, validation_status FROM upgrade_items
),
ranked AS (
    SELECT a.*,
           CASE WHEN tier IS NOT NULL THEN 'queue' ELSE 'upcoming' END AS section,
           CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END AS prio_rank,
           CASE severity WHEN 'Critical' THEN 0 WHEN 'Warning' THEN 1 WHEN 'Info' THEN 2 ELSE 3 END AS sev_rank
    FROM all_items a
    WHERE tier IS NOT NULL OR is_upcoming
)
SELECT section,
       tier,
       CASE tier WHEN 1 THEN 'Overdue / Critical' WHEN 2 THEN 'Due today'
                 WHEN 3 THEN 'Infrastructure alerts' WHEN 4 THEN 'Waiting / follow-up'
                 WHEN 5 THEN 'Upgrade actions' WHEN 6 THEN 'Upcoming tasks' END AS tier_label,
       kind, id, client_id, client_name, type_label, title, status, priority, severity,
       CASE
           WHEN section = 'upcoming'                     THEN 'upcoming'
           WHEN tier = 1 AND kind = 'bams_alert'         THEN 'critical'
           WHEN tier = 1                                 THEN 'overdue'
           WHEN tier = 2                                 THEN 'due_today'
           WHEN tier = 3 AND status = 'recovered'        THEN 'recovered'
           WHEN tier = 3                                 THEN 'alert'
           WHEN tier = 4 AND kind = 'client_follow_up'   THEN 'follow_up'
           WHEN tier = 4                                 THEN 'waiting'
           WHEN tier = 5 AND (status = 'Validation Required' OR validation_status = 'Failed'
                              OR (status = 'Completed' AND validation_status = 'Pending')) THEN 'validation'
           WHEN tier = 5                                 THEN 'upgrade'
           ELSE 'upcoming'
       END AS urgency,
       item_date AS date,
       date_kind,
       -- alert dates are instants: compare their LOCAL calendar day (D-06). SQLite's
       -- 'localtime' uses the process timezone, i.e. the workstation's (QA-1-11b).
       CAST(julianday(CASE WHEN date_kind = 'opened' THEN date(item_date, 'localtime') ELSE date(item_date) END)
            - julianday((SELECT t FROM p)) AS INTEGER) AS days_delta,
       context,
       server_name
FROM ranked
ORDER BY
    section = 'upcoming',                                   -- queue first
    tier,
    -- k1: tier 1 critical alerts first; tier 2 priority; tier 3 open before recovered; tier 4 nulls last
    CASE tier WHEN 1 THEN (kind <> 'bams_alert')
              WHEN 2 THEN prio_rank
              WHEN 3 THEN (status <> 'open')
              WHEN 4 THEN (item_date IS NULL)
              ELSE 0 END,
    -- k2: tier 1 priority (non-task kinds rank after Low); tier 3 Warning before Info
    CASE tier WHEN 1 THEN prio_rank WHEN 3 THEN sev_rank ELSE 0 END,
    -- k3: tier 2 title; everything else date ascending, NULL dates last (QA-1-11a)
    CASE WHEN tier = 2 THEN 0 ELSE (item_date IS NULL) END,
    CASE tier WHEN 2 THEN title ELSE item_date END,
    -- k4: tier 6 priority after due date
    CASE tier WHEN 6 THEN prio_rank ELSE 0 END,
    kind, id;
