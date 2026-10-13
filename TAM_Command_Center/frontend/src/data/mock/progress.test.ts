import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketCounts, dayProgress, trendBounds, type LocalMidnight } from './progress';
import type { Tables } from './rebase';
import { newMock } from './testFile';
import { downsampleMax, serverTiles } from './derive';
import { rebaseTables } from './rebase';
import { mockFile } from './testFile';

const utcMidnight: LocalMidnight = (day) => `${day}T00:00:00.000Z`;
const dates = ['2026-10-12', '2026-10-20', '2026-11-03'];
const fixture = (d: string) => JSON.parse(readFileSync(resolve(__dirname, `__fixtures__/run2_parity_${d}.json`), 'utf8')) as { progress: Record<string, unknown>; trend: Record<string, number[]> };

describe('parity with the reference SQL (db/queries/day_progress.sql, activity_trend.sql)', () => {
  for (const d of dates) {
    it(`progress and activity trend match the SQL output for ${d}`, async () => {
      const ds = newMock({ today: d, localMidnight: utcMidnight });
      const today = await ds.getToday();
      expect(today.progress).toEqual(fixture(d).progress);
      const trend = await ds.getActivityTrend(14);
      expect(trend.days).toBe(14);
      expect(trend.series).toEqual(fixture(d).trend);
    });
  }
});

describe('dayProgress (PM §10.2 edge cases)', () => {
  const T = '2026-10-13';
  const base = (): Tables => ({
    clients: [{ id: 'a', status: 'Active' }, { id: 'x', status: 'Inactive' }],
    tasks: [], audit_events: [],
  });
  let n = 0;
  const task = (t: Tables, over: Record<string, unknown>) => { const row = { id: `t${++n}`, client_id: 'a', status: 'Not Started', archived: 0, due: T, ...over }; t.tasks.push(row); return row; };
  const done = (t: Tables, id: string, ts = `${T}T09:00:00.000Z`) => t.audit_events.push({ object_type: 'task', object_id: id, action: 'completed', timestamp: ts });

  it('M = 0 for an empty day', () => {
    expect(dayProgress(base(), T, utcMidnight)).toEqual({ day: T, total: 0, done: 0, open: 0, done_other: 0 });
  });
  it('counts open plan tasks and tasks done today once, however many completions', () => {
    const t = base();
    task(t, { due: '2026-10-01' });
    const d = task(t, { status: 'Complete' }); done(t, d.id); done(t, d.id, `${T}T10:00:00.000Z`);
    expect(dayProgress(t, T, utcMidnight)).toMatchObject({ total: 2, done: 1, open: 1 });
  });
  it('N = M shows a full ring: only done tasks', () => {
    const t = base();
    const d = task(t, { status: 'Complete' }); done(t, d.id);
    const p = dayProgress(t, T, utcMidnight);
    expect(p.done).toBe(p.total);
    expect(p.total).toBe(1);
  });
  it('a task completed then reopened is open and not counted', () => {
    const t = base();
    const r = task(t, { status: 'In Progress' }); done(t, r.id);
    expect(dayProgress(t, T, utcMidnight)).toMatchObject({ total: 1, done: 0, open: 1 });
  });
  it('done with a future or no due date is done_other, outside the ring', () => {
    const t = base();
    const f = task(t, { status: 'Complete', due: '2026-12-01' }); done(t, f.id);
    const n2 = task(t, { status: 'Complete', due: null }); done(t, n2.id);
    expect(dayProgress(t, T, utcMidnight)).toMatchObject({ total: 0, done: 0, done_other: 2 });
  });
  it('Inactive-account tasks are excluded everywhere; completed-then-archived still counts; yesterday does not', () => {
    const t = base();
    const i = task(t, { client_id: 'x', status: 'Complete' }); done(t, i.id);
    task(t, { client_id: 'x' });
    const a = task(t, { status: 'Complete', archived: 1 }); done(t, a.id);
    const y = task(t, { status: 'Complete' }); done(t, y.id, '2026-10-12T23:30:00.000Z');
    expect(dayProgress(t, T, utcMidnight)).toMatchObject({ total: 1, done: 1, open: 0, done_other: 0 });
  });
  it('a deleted task (no row) is not counted', () => {
    const t = base();
    done(t, 'ghost');
    expect(dayProgress(t, T, utcMidnight).total).toBe(0);
  });
  it('uses the local-day window: 23:30 vs 00:30 local in a UTC+10 zone, and a 25 hour DST day', () => {
    const tokyoish: LocalMidnight = (day) => { const d = new Date(`${day}T00:00:00.000Z`); d.setUTCHours(d.getUTCHours() - 10); return d.toISOString(); };
    const t = base();
    const a = task(t, { status: 'Complete' }); done(t, a.id, '2026-10-12T14:30:00.000Z'); // 00:30 local on the 13th
    const b = task(t, { status: 'Complete' }); done(t, b.id, '2026-10-12T13:30:00.000Z'); // 23:30 local on the 12th
    expect(dayProgress(t, T, tokyoish)).toMatchObject({ done: 1 });
    // fall-back day: the next local midnight is 25 hours after the first
    const dst: LocalMidnight = (day) => (day === T ? '2026-10-13T04:00:00.000Z' : '2026-10-14T05:00:00.000Z');
    const c = task(t, { status: 'Complete' }); done(t, c.id, '2026-10-14T04:30:00.000Z');
    expect(dayProgress(t, T, dst).done).toBe(1);
  });
  it('done never exceeds total (property over mixed data)', () => {
    const t = base();
    for (let i = 0; i < 40; i++) {
      const r = task(t, { status: i % 3 === 0 ? 'Complete' : 'Not Started', due: i % 5 === 0 ? null : i % 2 ? T : '2026-11-30', archived: i % 7 === 0 ? 1 : 0 });
      if (i % 3 === 0) done(t, r.id);
    }
    const p = dayProgress(t, T, utcMidnight);
    expect(p.done).toBeLessThanOrEqual(p.total);
    expect(p.total).toBe(p.done + p.open);
  });
});

describe('trend buckets', () => {
  it('has days+1 bounds and half-open buckets', () => {
    const b = trendBounds('2026-10-13', 14, utcMidnight);
    expect(b).toHaveLength(15);
    expect(b[0]).toBe('2026-09-30T00:00:00.000Z');
    expect(b[14]).toBe('2026-10-14T00:00:00.000Z');
    const c = bucketCounts(['2026-09-30T00:00:00.000Z', '2026-09-29T23:59:59.999Z', '2026-10-14T00:00:00.000Z', '2026-10-13T23:59:59.999Z', '2026-10-13T00:00:00.000Z'], b);
    expect(c[0]).toBe(1);
    expect(c[13]).toBe(2);
    expect(c.reduce((s, n) => s + n, 0)).toBe(3);
  });
});

describe('server tiles (contract §9.3)', () => {
  const d = '2026-10-12';
  const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
  const clock = new Date(`${d}T12:00:00.000Z`);
  it('one tile per distinct server name, ordered by name, points never exceed 28', () => {
    for (const c of t.clients) {
      const tiles = serverTiles(t, c.id, clock);
      const names = tiles.map((x) => x.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual([...names].sort());
      for (const x of tiles) if (x.spark) { expect(x.spark.points.length).toBeLessThanOrEqual(28); expect(x.spark.window_hours).toBeLessThanOrEqual(168); }
    }
  });
  it('spark metric is the alert metric when an alert is open, else CPU; servers without samples or metrics have null', () => {
    const all = t.clients.flatMap((c) => serverTiles(t, c.id, clock));
    const alerting = all.filter((x) => x.alert_severity && x.spark);
    expect(alerting.length).toBeGreaterThan(0);
    expect(all.some((x) => x.spark == null)).toBe(true);
    for (const x of all.filter((y) => !y.alert_severity && y.spark)) expect(x.spark!.metric).toMatch(/cpu/i);
  });
  it('a server with only upgrade rows has a tile with no spark', () => {
    const c = t.clients[0];
    const copy = { ...t, server_upgrades: [...t.server_upgrades, { id: 'zz', client_id: c.id, server_name: 'zz-only-upgrade', environment: 'DEV', polarity: 'East', current_version: '1', target_version: '2', scheduled_date: '2026-11-01', status: 'Planned', validation_status: 'Pending', schedule_year: 2026, schedule_quarter: 'Q4' }] };
    const tile = serverTiles(copy, c.id, clock).find((x) => x.name === 'zz-only-upgrade')!;
    expect(tile).toMatchObject({ environment: 'DEV', version: '1', alert_severity: null, spark: null });
  });
  it('downsample keeps the bucket maximum and at most 28 points, oldest first', () => {
    const pts: [string, number][] = Array.from({ length: 100 }, (_, i) => [new Date(Date.UTC(2026, 9, 1, i)).toISOString(), i % 10]);
    const out = downsampleMax(pts);
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.map((p) => p[0])).toEqual([...out.map((p) => p[0])].sort());
    expect(Math.max(...out.map((p) => p[1]))).toBe(9);
  });
});
