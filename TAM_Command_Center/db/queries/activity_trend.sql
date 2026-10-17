-- =============================================================================
-- Accounts "Activity trend" sparkline (D-31, 01_PM_SPEC section 10.4 #18): 14 daily points per account.
-- Reference query; owner data-architect-agent. Served by GET /api/accounts/activity-trend (PM-AC-2).
--
-- A point = the number of Activity-timeline entries for that account on that LOCAL day. Since 2026-10-16
-- the Activity timeline holds manual notes only (system events moved to the Audit log), so the entry set
-- is exactly the notes of activity_timeline.sql, with no filter and no search; a deleted note is gone.
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
-- Index use: notes -> ix_notes_client_ts, searched per account with the 14-day timestamp range.
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

)
SELECT s.id AS client_id, s.name AS client_name, b.day_index,
       date(:today, printf('%+d day', b.day_index - 13)) AS day,
       count(e.ts) AS n
FROM sel s
CROSS JOIN buckets b
LEFT JOIN entries e ON e.client_id = s.id AND e.ts >= b.lo AND e.ts < b.hi
GROUP BY s.id, b.day_index
ORDER BY s.name, b.day_index;
