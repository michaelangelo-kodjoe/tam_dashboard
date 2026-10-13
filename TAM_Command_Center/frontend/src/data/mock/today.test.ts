import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rebaseTables } from './rebase';
import { rankToday } from './today';
import { mockFile } from './testFile';

const dates = ['2026-10-12', '2026-10-20', '2026-11-03'];

describe('Today ranking parity with db/queries/today_queue.sql', () => {
  for (const d of dates) {
    it(`matches the SQL reference output order for ${d}`, () => {
      const expected = JSON.parse(readFileSync(resolve(__dirname, `__fixtures__/today_parity_${d}.json`), 'utf8')) as Record<string, unknown>[];
      const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
      const { queue, upcoming } = rankToday(t, d);
      const got = [...queue, ...upcoming];
      expect(got.length).toBe(expected.length);
      got.forEach((g, i) => {
        const e = expected[i];
        expect({ i, kind: g.kind, id: g.id, tier: g.tier, urgency: g.urgency, section: g.tier == null ? 'upcoming' : 'queue' }).toEqual({
          i, kind: e.kind, id: e.id, tier: e.tier, urgency: e.urgency, section: e.section,
        });
        expect(g.title).toBe(e.title);
        expect(g.context ?? null).toBe(e.context ?? null);
        expect(g.client_name).toBe(e.client_name);
        expect(g.days_delta ?? null).toBe(e.days_delta ?? null);
      });
    });
  }

  it('puts every item in exactly one place and every tier has items (seed catalogue)', () => {
    const d = '2026-10-12';
    const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
    const { queue, upcoming } = rankToday(t, d);
    const keys = [...queue, ...upcoming].map((i) => `${i.kind}:${i.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tier of [1, 2, 3, 4, 5, 6]) expect(queue.filter((q) => q.tier === tier).length).toBeGreaterThanOrEqual(2);
  });

  it('ranks an overdue task before a normal upcoming task (US-3.1 AC3) and includes BAMS + upgrades (AC4/AC5)', () => {
    const d = '2026-10-12';
    const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
    const { queue } = rankToday(t, d);
    const firstOverdue = queue.findIndex((q) => q.kind === 'task' && q.urgency === 'overdue');
    const firstUpcomingTask = queue.findIndex((q) => q.kind === 'task' && q.tier === 6);
    expect(firstOverdue).toBeGreaterThanOrEqual(0);
    expect(firstOverdue).toBeLessThan(firstUpcomingTask);
    expect(queue.some((q) => q.kind === 'bams_alert' && q.urgency === 'critical')).toBe(true);
    expect(queue.some((q) => q.kind === 'server_upgrade' && q.tier === 5)).toBe(true);
  });

  it('D-23: no client_follow_up item exists for an account whose open follow-up task is due on next_contact', () => {
    const d = '2026-10-12';
    const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
    const c = t.clients.find((x) => x.status === 'Active')!;
    t.tasks.push({ id: 'x-d23', task: 'Follow up', client_id: c.id, category: 'Client Follow-Up', priority: 'Medium', due: c.next_contact ?? '2026-10-12', next_update: null, status: 'Not Started', waiting: null, notes: null, archived: 0 });
    c.next_contact = c.next_contact ?? '2026-10-12';
    const { queue, upcoming } = rankToday(t, d);
    expect([...queue, ...upcoming].some((i) => i.kind === 'client_follow_up' && i.id === c.id)).toBe(false);
    const task = [...queue, ...upcoming].find((i) => i.id === 'x-d23');
    expect(task?.context).toBe('Next Client Touch');
  });

  it('D-24: an Exception upgrade qualifies for tier 5 at any date; Deferred never enters the queue', () => {
    const d = '2026-10-12';
    const t = rebaseTables(mockFile(), { today: d, loadNow: new Date(`${d}T12:00:00.000Z`) });
    const c = t.clients.find((x) => x.status === 'Active')!;
    const base = { client_id: c.id, server_name: 'zz-test-01', environment: 'PROD', polarity: 'East', current_version: '1', target_version: '2', validation_status: 'Pending', waiting_on: null };
    t.server_upgrades.push({ ...base, id: 'x-exc', scheduled_date: '2027-03-01', status: 'Exception' });
    t.server_upgrades.push({ ...base, id: 'x-def', scheduled_date: '2026-10-14', status: 'Deferred', validation_status: 'Failed' });
    const { queue } = rankToday(t, d);
    expect(queue.find((i) => i.id === 'x-exc')?.tier).toBe(5);
    expect(queue.some((i) => i.id === 'x-def')).toBe(false);
  });
});
