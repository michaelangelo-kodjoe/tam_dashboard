-- =============================================================================
-- "Done today N of M" progress ring (D-29, 01_PM_SPEC section 10.2). Tasks only.
-- Reference query; owner data-architect-agent. Served as `progress` on GET /api/today.
--
-- Params:
--   :today          'YYYY-MM-DD'  the server's local date (the same value /api/today echoes as `day`)
--   :day_start_utc  UTC instant (YYYY-MM-DDTHH:MM:SS.mmmZ) of LOCAL midnight of :today
--   :day_end_utc    UTC instant of LOCAL midnight of :today + 1 day
--                   The backend converts each local midnight to UTC SEPARATELY, so a 23h or
--                   25h DST day is exact. Window is half-open: [start, end).
--
-- Result: exactly one row  (day, total, done, open, done_other)
--   done        N  plan tasks completed today (Complete now AND a task 'completed' audit row in the window)
--   open        R  plan tasks still open
--   total       M  = N + R, so N <= M by construction
--   done_other     tasks completed today under the same rules but outside the plan (due > :today or due NULL)
--
-- Plan task = due IS NOT NULL AND due <= :today AND (no account OR account Active) AND
--             (open: status <> 'Complete' AND archived = 0)  OR  (done today).
-- Rules worth knowing:
--   * a task is counted once however many 'completed' rows it has today (DISTINCT task id);
--   * reopened after completing -> status is no longer Complete -> it is in `open`, not in `done`;
--   * archived is ignored for done tasks (complete then archive still counts), enforced for open ones;
--   * Inactive-account tasks are excluded from done, open and done_other alike;
--   * a deleted task has no row to join -> not counted;
--   * audit `source` is ignored; the plan test uses the task's CURRENT due (accepted limit, section 10.2).
-- Index use: the window is a range scan on ix_audit_ts (timestamp DESC, id DESC); each hit is joined
-- to tasks/clients by primary key. No JSON1 functions.
-- =============================================================================
WITH done_ids AS (
    SELECT DISTINCT a.object_id AS task_id
    FROM audit_events a INDEXED BY ix_audit_ts
    WHERE a.timestamp >= :day_start_utc AND a.timestamp < :day_end_utc
      AND a.object_type = 'task' AND a.action = 'completed'
),
done AS (
    SELECT t.id,
           (t.due IS NOT NULL AND t.due <= :today) AS in_plan
    FROM done_ids d
    JOIN tasks t ON t.id = d.task_id
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status = 'Complete'
      AND (t.client_id IS NULL OR c.status = 'Active')
),
done_counts AS (
    SELECT coalesce(sum(in_plan), 0) AS n_plan, coalesce(sum(NOT in_plan), 0) AS n_other FROM done
),
open_plan AS (
    SELECT count(*) AS n
    FROM tasks t
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.status <> 'Complete' AND t.archived = 0
      AND t.due IS NOT NULL AND t.due <= :today
      AND (t.client_id IS NULL OR c.status = 'Active')
)
SELECT :today AS day,
       d.n_plan + o.n AS total,
       d.n_plan       AS done,
       o.n            AS open,
       d.n_other      AS done_other
FROM done_counts d, open_plan o;
