import { describe, expect, it } from 'vitest';
import type { AccountSummary, QueueItem, ServerUpgrade, Task } from '../types';
import {
  initials, loadLeaders, meterOf, needsAttention, nextDays, portfolio, proximityPct, serverSummary, shortMetric, signalsFromQueue,
  sparkWindowLabel, stackRows, timelineMarkers, topItemFor, upgradeDatesFromQueue, worstAlert, type AccountSignals,
} from './instruments';

const T = '2026-10-13';
const task = (o: Partial<Task>): Task => ({ id: Math.random().toString(), task: 'x', client_id: 'a', category: 'Other', priority: 'Medium', due: null, next_update: null, status: 'Not Started', waiting: null, notes: null, archived: false, created_at: '', updated_at: '', row_version: 1, ...o });
const acct = (o: Partial<AccountSummary> & { id: string }): AccountSummary => ({
  name: o.id, status: 'Active', bpid: null, products: null, last_contact: null, next_contact: null, notes: null, created_at: '', updated_at: '', row_version: 1,
  open_tasks: 0, overdue: 0, waiting: 0, active_alerts: 0, next_upgrade: null, upcoming_upgrades: 0, servers: 0, ...o,
});
const upg = (o: Partial<ServerUpgrade>): ServerUpgrade => ({
  id: Math.random().toString(), client_id: 'a', server_name: 's1', environment: 'PROD', polarity: 'East', schedule_year: 2026, schedule_quarter: 'Q4', current_version: '1', target_version: '2',
  scheduled_date: T, maintenance_window: null, status: 'Scheduled', validation_status: 'Pending', waiting_on: null, reference: null, notes: null, updated_at: '', row_version: 1, ...o,
});

describe('meterOf (exclusive segments, §10.4 #1)', () => {
  it('an overdue Waiting task is counted once, under Overdue; archived and Complete are ignored', () => {
    const m = meterOf([
      task({ due: '2026-10-01', status: 'Waiting' }), task({ due: '2026-10-02' }), task({ status: 'Waiting' }), task({}),
      task({ status: 'Complete', due: '2026-10-01' }), task({ archived: true, due: '2026-10-01' }),
    ], T);
    expect(m).toEqual({ open: 4, overdue: 2, waiting: 1, other: 1 });
    expect(m.overdue + m.waiting + m.other).toBe(m.open);
  });
  it('a task due today is not overdue', () => {
    expect(meterOf([task({ due: T })], T)).toMatchObject({ overdue: 0, other: 1 });
  });
});

describe('timelineMarkers (§10.4 #8)', () => {
  it('keeps T..T+30 not Completed/Deferred, plus Exceptions at any date; pins out-of-window to the edges', () => {
    const m = timelineMarkers([
      upg({ id: 'in', scheduled_date: '2026-10-28' }),
      upg({ id: 'done', scheduled_date: '2026-10-20', status: 'Completed' }),
      upg({ id: 'def', scheduled_date: '2026-10-20', status: 'Deferred' }),
      upg({ id: 'far', scheduled_date: '2026-12-25' }),
      upg({ id: 'exc-past', scheduled_date: '2026-07-26', status: 'Exception' }),
      upg({ id: 'exc-far', scheduled_date: '2027-03-01', status: 'Exception' }),
      upg({ id: 'edge', scheduled_date: '2026-11-12' }),
    ], T);
    const ids = m.map((x) => x.id);
    expect(ids.sort()).toEqual(['edge', 'exc-far', 'exc-past', 'in']);
    const by = Object.fromEntries(m.map((x) => [x.id, x]));
    expect(by['exc-past']).toMatchObject({ pinned: 'left', pct: 0, showDate: true });
    expect(by['exc-far']).toMatchObject({ pinned: 'right', pct: 100, showDate: true });
    expect(by['in'].pct).toBeCloseTo((15 / 30) * 100);
    expect(by['edge'].pct).toBe(100);
    expect(by['edge'].pinned).toBeNull();
  });
  it('stacks labels of markers that would overlap', () => {
    const m = timelineMarkers([upg({ id: 'a', scheduled_date: '2026-10-20' }), upg({ id: 'b', scheduled_date: '2026-10-21' }), upg({ id: 'c', scheduled_date: '2026-11-10' })], T);
    expect(stackRows(m)).toEqual([0, 1, 0]);
  });
});

describe('header cells', () => {
  it('serverSummary splits environments and counts alert severities', () => {
    expect(serverSummary([
      { name: 'a', environment: 'PROD', version: null, alert_severity: 'Warning', spark: null },
      { name: 'b', environment: 'DEV', version: null, alert_severity: null, spark: null },
      { name: 'c', environment: null, version: null, alert_severity: 'Critical', spark: null },
    ])).toEqual({ total: 3, prod: 1, dev: 1, unknown: 1, warning: 1, critical: 1 });
  });
  const alert = (o: Partial<QueueItem>): QueueItem => ({ kind: 'bams_alert', id: Math.random().toString(), tier: 3, tier_label: '', client_id: 'a', client_name: 'A', type_label: 'BAMS alert', title: 't', status: 'open', priority: null, severity: 'Warning', urgency: 'alert', date: '2026-10-10T10:00:00.000Z', date_kind: 'opened', days_delta: -3, context: null, server_name: 's', ...o });
  it('worstAlert: open before recovered, then severity, then earliest opened', () => {
    const q = [alert({ id: 'w-late', date: '2026-10-12T00:00:00.000Z' }), alert({ id: 'rec-crit', status: 'recovered', severity: 'Critical' }), alert({ id: 'w-early', date: '2026-10-09T00:00:00.000Z' }), alert({ id: 'info', severity: 'Info' })];
    expect(worstAlert(q, 'a')!.id).toBe('w-early');
    expect(worstAlert(q, 'zzz')).toBeNull();
  });
  it('topItemFor returns the first tier 1-5 item for the account, never an upcoming-only one', () => {
    const mkq = (id: string, tier: number | null, client = 'a'): QueueItem => ({ ...alert({ id, tier, client_id: client }) });
    expect(topItemFor([mkq('x', 3, 'b'), mkq('t6', 6), mkq('t3', 3), mkq('t1', 1)], 'a')!.id).toBe('t3');
    expect(topItemFor([mkq('t6', 6)], 'a')).toBeNull();
  });
  it('proximityPct: closer is fuller, overdue is full, beyond 30 days is empty', () => {
    expect(proximityPct('2026-10-13', T)).toBe(100);
    expect(proximityPct('2026-10-01', T)).toBe(100);
    expect(proximityPct('2026-10-28', T)).toBe(50);
    expect(proximityPct('2026-12-25', T)).toBe(0);
    expect(proximityPct(null, T)).toBe(0);
  });
  it('small helpers', () => {
    expect(initials('Sofia Whitcombe')).toBe('SW');
    expect(initials('Ops desk')).toBe('OD');
    expect(initials('Madonna')).toBe('MA');
    expect(shortMetric('CPU Utilization (%)')).toBe('CPU');
    expect(shortMetric('Disk')).toBe('Disk');
    expect(sparkWindowLabel(24)).toBe('24h');
    expect(sparkWindowLabel(168)).toBe('7d');
  });
});

describe('Accounts tiles', () => {
  const list = [
    acct({ id: 'a', overdue: 2, active_alerts: 1, open_tasks: 5 }), acct({ id: 'b', overdue: 0, active_alerts: 0, open_tasks: 9 }),
    acct({ id: 'c', overdue: 2, open_tasks: 7 }), acct({ id: 'd', status: 'Inactive', overdue: 9 }),
  ];
  it('portfolio counts accounts; an account with both is in both; clear is neither', () => {
    expect(portfolio(list)).toEqual({ active: 3, overdue: 2, alerts: 1, clear: 1 });
  });
  it('load leaders: overdue desc, open desc, name; Active only; at most 6', () => {
    expect(loadLeaders(list).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(loadLeaders(Array.from({ length: 9 }, (_, i) => acct({ id: `z${i}` }))).length).toBe(6);
  });
  it('next 15 days: cells T..T+14, upgrade and touch markers, totals over the window', () => {
    const r = nextDays(
      [acct({ id: 'a', next_contact: T }), acct({ id: 'b', next_contact: '2026-10-27' }), acct({ id: 'c', next_contact: '2026-10-28' }), acct({ id: 'd', next_contact: '2026-10-14', status: 'Inactive' })],
      ['2026-10-13', '2026-10-13', '2026-10-27', '2026-10-28', '2026-10-01'], T);
    expect(r.cells).toHaveLength(15);
    expect(r.cells[0]).toMatchObject({ date: T, upgrades: 2, touches: 1 });
    expect(r.cells[14]).toMatchObject({ date: '2026-10-27', upgrades: 1, touches: 1 });
    expect(r.upgrades).toBe(3);
    expect(r.touches).toBe(2);
  });
  it('upgrade dates come from queue upgrade items in the window, not Completed or Deferred', () => {
    const up = (date: string, status: string): QueueItem => ({ kind: 'server_upgrade', id: date + status, tier: 5, tier_label: '', client_id: 'a', client_name: 'A', type_label: '', title: '', status, priority: null, severity: null, urgency: 'upgrade', date, date_kind: 'scheduled', days_delta: 0, context: null, server_name: 's' });
    expect(upgradeDatesFromQueue([up('2026-10-15', 'Scheduled'), up('2026-10-15', 'Completed'), up('2026-10-10', 'Scheduled'), up('2026-10-27', 'Planned'), up('2026-10-28', 'Planned')], T)).toEqual(['2026-10-15', '2026-10-27']);
  });
});

describe('needsAttention (D-33): every tie-break', () => {
  const sig = (o: Partial<AccountSignals>): AccountSignals => ({ critical: false, upgradeOverdueDays: 0, overdueTasks: 0, warning: false, touchLateDays: null, alertServers: new Map(), ...o });
  const run = (entries: Record<string, Partial<AccountSignals>>, extra: Partial<AccountSummary> = {}) => {
    const accounts = Object.keys(entries).map((id) => acct({ id, name: id, ...extra }));
    const signals = new Map(Object.entries(entries).map(([id, s]) => [id, sig(s)]));
    return needsAttention(accounts, signals);
  };
  it('1 critical beats everything; 2 overdue upgrade beats tasks; 3 overdue tasks desc; 4 warning; 5 touch; 6 name', () => {
    const rows = run({ zz: { touchLateDays: 0 }, yy: { warning: true }, xx: { overdueTasks: 2 }, ww: { overdueTasks: 5 }, vv: { upgradeOverdueDays: 3 }, uu: { critical: true } });
    expect(rows.map((r) => r.id)).toEqual(['uu', 'vv', 'ww', 'xx']); // capped at 4
    expect(run({ zz: { touchLateDays: 0 }, yy: { warning: true } }).map((r) => r.id)).toEqual(['yy', 'zz']);
    expect(run({ bb: { warning: true }, aa: { warning: true } }).map((r) => r.id)).toEqual(['aa', 'bb']);
    expect(run({ b: { overdueTasks: 3 }, a: { overdueTasks: 3 } }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(run({ b: { touchLateDays: 2 }, a: { touchLateDays: 0 } }).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('accounts without a signal never appear; Inactive never appear', () => {
    expect(run({ a: {}, b: { warning: true } }).map((r) => r.id)).toEqual(['b']);
    expect(run({ a: { critical: true } }, { status: 'Inactive' })).toEqual([]);
  });
  it('reason lists up to two signals in key order; tone danger for critical or overdue upgrade', () => {
    const [r] = run({ a: { critical: true, upgradeOverdueDays: 3, overdueTasks: 4, warning: true } });
    expect(r.reason).toBe('Critical alert, upgrade 3d overdue');
    expect(r.tone).toBe('danger');
    const [w] = run({ a: { overdueTasks: 1, touchLateDays: 2 } });
    expect(w.reason).toBe('1 overdue task, client touch 2d overdue');
    expect(w.tone).toBe('warning');
    expect(run({ a: { touchLateDays: 0 } })[0].reason).toBe('client touch due today');
  });
  it('shows no score or number that implies one', () => {
    for (const r of run({ a: { critical: true, overdueTasks: 9 } })) expect(JSON.stringify(r)).not.toMatch(/score|health|grade/i);
  });
  it('signalsFromQueue derives critical, warning, overdue upgrade days and touch lateness from the queue', () => {
    const base = { tier_label: '', client_name: 'A', type_label: '', title: '', priority: null, date_kind: null, context: null, urgency: 'alert' } as const;
    const q: QueueItem[] = [
      { ...base, kind: 'bams_alert', id: '1', tier: 1, client_id: 'a', status: 'open', severity: 'Critical', date: null, days_delta: null, server_name: 'S1' },
      { ...base, kind: 'bams_alert', id: '2', tier: 3, client_id: 'a', status: 'open', severity: 'Warning', date: null, days_delta: null, server_name: 's2' },
      { ...base, kind: 'bams_alert', id: '3', tier: 3, client_id: 'a', status: 'recovered', severity: 'Warning', date: null, days_delta: null, server_name: 's3' },
      { ...base, kind: 'server_upgrade', id: '4', tier: 1, client_id: 'a', status: 'Scheduled', severity: null, date: '2026-10-10', days_delta: -3, server_name: 's1' },
      { ...base, kind: 'server_upgrade', id: '5', tier: 1, client_id: 'a', status: 'Scheduled', severity: null, date: '2026-10-01', days_delta: -12, server_name: 's1' },
    ];
    const s = signalsFromQueue([acct({ id: 'a', overdue: 2, next_contact: '2026-10-11' })], q, T).get('a')!;
    expect(s).toMatchObject({ critical: true, warning: true, upgradeOverdueDays: 12, overdueTasks: 2, touchLateDays: 2 });
    expect([...s.alertServers.keys()].sort()).toEqual(['s1', 's2']);
  });
});
