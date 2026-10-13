// In-memory ports of db/queries/day_progress.sql (D-29, PM §10.2) and db/queries/activity_trend.sql
// (PM §10.4 #18). Same rules, same half-open [start, end) UTC windows built from LOCAL midnights, so a
// 23h or 25h DST day is exact. Parity with the SQL reference is pinned by progress.test.ts.
import type { TodayProgress } from '../../types';
import { addDays } from '../../lib/dates';
import type { Tables } from './rebase';

/** Local midnight of a YYYY-MM-DD day as a UTC instant string (YYYY-MM-DDTHH:MM:SS.mmmZ). */
export type LocalMidnight = (day: string) => string;

export const browserLocalMidnight: LocalMidnight = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
};

export function dayProgress(t: Tables, today: string, midnight: LocalMidnight): TodayProgress {
  const start = midnight(today);
  const end = midnight(addDays(today, 1));
  const tasks = new Map(t.tasks.map((x) => [x.id, x]));
  const clients = new Map(t.clients.map((c) => [c.id, c]));
  const accountOk = (clientId: string | null | undefined) => clientId == null || clients.get(clientId)?.status === 'Active';

  const doneIds = new Set<string>();
  for (const a of t.audit_events) {
    if (a.object_type === 'task' && a.action === 'completed' && a.timestamp >= start && a.timestamp < end) doneIds.add(a.object_id);
  }
  let done = 0;
  let doneOther = 0;
  for (const id of doneIds) {
    const task = tasks.get(id);
    if (!task || task.status !== 'Complete' || !accountOk(task.client_id)) continue;
    if (task.due != null && task.due <= today) done++;
    else doneOther++;
  }
  let open = 0;
  for (const task of t.tasks) {
    if (task.status !== 'Complete' && !task.archived && task.due != null && task.due <= today && accountOk(task.client_id)) open++;
  }
  return { day: today, total: done + open, done, open, done_other: doneOther };
}

/** `days + 1` bucket bounds: local midnights of (today - days + 1) ... (today + 1). */
export function trendBounds(today: string, days: number, midnight: LocalMidnight): string[] {
  const out: string[] = [];
  for (let i = 0; i <= days; i++) out.push(midnight(addDays(today, i - days + 1)));
  return out;
}

/** Count timestamps into the half-open buckets [b_i, b_i+1). Timestamps outside all buckets are ignored. */
export function bucketCounts(timestamps: Iterable<string>, bounds: string[]): number[] {
  const counts = new Array<number>(bounds.length - 1).fill(0);
  for (const ts of timestamps) {
    if (ts < bounds[0] || ts >= bounds[bounds.length - 1]) continue;
    let lo = 0;
    let hi = counts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts >= bounds[mid]) lo = mid;
      else hi = mid - 1;
    }
    counts[lo]++;
  }
  return counts;
}
